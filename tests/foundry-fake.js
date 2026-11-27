/**
 * A small stand-in for the parts of Foundry the module touches: settings,
 * hooks, actors with embedded items, fromUuidSync, ChatMessage, notifications.
 * Documents fire createItem / updateItem / deleteItem / updateActor the way
 * Foundry does (after the change is applied, with the change object).
 */
export function installFoundry() {
  const hooks = new Map();
  const settings = new Map();
  const docs = new Map();
  const chat = [];
  const notes = [];

  const Hooks = {
    on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    once: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    call: (name, ...args) => (hooks.get(name) ?? []).forEach((fn) => fn(...args))
  };

  const setPath = (obj, path, value) => {
    const keys = path.split('.');
    let o = obj;
    while (keys.length > 1) o = o[keys[0]] ??= {}, keys.shift();
    o[keys[0]] = value;
  };
  const deepMerge = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (k.includes('.')) setPath(target, k, v);
      else if (v && typeof v === 'object' && !Array.isArray(v)) deepMerge((target[k] ??= {}), v);
      else target[k] = v;
    }
  };

  let nextId = 1;
  class Item {
    constructor(actor, data) {
      this.id = data._id ?? `item${nextId++}`;
      this.parent = actor;
      this.name = data.name;
      this.type = data.type;
      this.flags = structuredClone(data.flags ?? {});
      this.system = structuredClone(data.system ?? {});
    }
    get uuid() {
      return `${this.parent.uuid}.Item.${this.id}`;
    }
    getFlag(mod, key) {
      return this.flags?.[mod]?.[key];
    }
    toObject() {
      return { _id: this.id, name: this.name, type: this.type, flags: structuredClone(this.flags), system: structuredClone(this.system) };
    }
    async update(changes, options = {}) {
      deepMerge(this, changes);
      Hooks.call('updateItem', this, changes, options, 'user');
      return this;
    }
    async delete(options = {}) {
      this.parent.items.delete(this.id);
      docs.delete(this.uuid);
      Hooks.call('deleteItem', this, options, 'user');
    }
  }

  class Collection extends Map {
    filter(fn) {
      return [...this.values()].filter(fn);
    }
    map(fn) {
      return [...this.values()].map(fn);
    }
    find(fn) {
      return [...this.values()].find(fn);
    }
    getName(name) {
      return this.find((d) => d.name === name);
    }
    [Symbol.iterator]() {
      return this.values();
    }
  }

  class Actor {
    constructor({ id, name, flags = {}, currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }, isToken = false, actorLink = true }) {
      this.id = id;
      this._id = id;
      this.name = name;
      this.flags = flags;
      this.documentName = 'Actor';
      this.system = { currency: { ...currency } };
      this.items = new Collection();
      this.isToken = isToken;
      this.token = isToken ? { actorLink } : null;
    }
    get uuid() {
      return this.isToken ? `Scene.s.Token.${this.id}.Actor.${this.id}` : `Actor.${this.id}`;
    }
    toObject() {
      return { _id: this.id, flags: this.flags };
    }
    async createItem(data, options = {}) {
      const item = new Item(this, data);
      this.items.set(item.id, item);
      docs.set(item.uuid, item);
      Hooks.call('createItem', item, options, 'user');
      return item;
    }
    async update(changes, options = {}) {
      deepMerge(this, changes);
      Hooks.call('updateActor', this, changes, options, 'user');
      return this;
    }
  }

  const actors = new Collection();
  const users = [{ id: 'gm', isGM: true }, { id: 'p1', isGM: false }];
  const game = {
    settings: {
      register: (mod, key, data) => {
        if (!settings.has(`${mod}.${key}`)) settings.set(`${mod}.${key}`, data.default);
      },
      registerMenu: () => {},
      get: (mod, key) => {
        if (!settings.has(`${mod}.${key}`)) throw new Error(`unregistered ${mod}.${key}`);
        return settings.get(`${mod}.${key}`);
      },
      set: async (mod, key, value) => settings.set(`${mod}.${key}`, value)
    },
    users: Object.assign(users, { activeGM: { isSelf: true } }),
    user: { isGM: true },
    modules: new Map([['ddb-inventory-sync', { active: true }], ['item-piles', { active: true }], ['ddb-sync', { active: true }]]),
    actors
  };

  Object.assign(globalThis, {
    Hooks,
    game,
    ui: { notifications: { warn: (m) => notes.push(['warn', m]), error: (m) => notes.push(['error', m]), info: (m) => notes.push(['info', m]) } },
    fromUuidSync: (uuid) => docs.get(uuid) ?? null,
    ChatMessage: { create: async (data) => chat.push(data) },
    foundry: {
      utils: {
        hasProperty: (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined,
        escapeHTML: (s) => s
      },
      applications: { api: { DialogV2: { prompt: async () => null } } }
    }
  });

  const addActor = (data) => {
    const a = new Actor(data);
    actors.set(a.id, a);
    return a;
  };
  const set = (mod, key, value) => settings.set(`${mod}.${key}`, value);
  return { Hooks, game, settings, set, addActor, Actor, chat, notes };
}
