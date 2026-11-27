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

  let hookId = 0;
  const Hooks = {
    // Like Foundry: on() returns an id, off() takes the id or the function.
    on: (name, fn) => {
      const id = ++hookId;
      hooks.set(name, [...(hooks.get(name) ?? []), { id, fn }]);
      return id;
    },
    once: (name, fn) => Hooks.on(name, fn),
    off: (name, ref) => hooks.set(name, (hooks.get(name) ?? []).filter((h) => h.id !== ref && h.fn !== ref)),
    call: (name, ...args) => (hooks.get(name) ?? []).forEach((h) => h.fn(...args)),
    count: (name) => (hooks.get(name) ?? []).length
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
    async createEmbeddedDocuments(type, list, options = {}) {
      const out = [];
      for (const data of list) out.push(await this.createItem(data, options));
      return out;
    }
    async delete() {
      actors.delete(this.id);
    }
    static async create(data) {
      return addActor({ id: `actor${nextId++}`, name: data.name });
    }
  }

  const actors = new Collection();
  const macros = new Collection();
  class Macro {
    constructor(data) {
      Object.assign(this, { id: `macro${nextId++}`, ...data });
    }
    async update(changes) {
      Object.assign(this, changes);
    }
    async execute(scope = {}) {
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)('scope', this.command);
      return fn(scope);
    }
    static async create(data) {
      const m = new Macro(data);
      macros.set(m.id, m);
      return m;
    }
  }
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
    actors,
    macros
  };

  Object.assign(globalThis, {
    Hooks,
    game,
    ui: { notifications: { warn: (m) => notes.push(['warn', m]), error: (m) => notes.push(['error', m]), info: (m) => notes.push(['info', m]) } },
    fromUuidSync: (uuid) => docs.get(uuid) ?? null,
    Actor,
    Macro,
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
  return { Hooks, game, settings, set, addActor, Actor, chat, notes, installItemPiles: () => (game.itempiles = { API: fakeItemPiles() }) };
}

/**
 * Item Piles stand-in with the behaviour the scenarios rely on: stacks merge
 * by name, a purchase costs the item's price, selling to a merchant pays half,
 * transfers copy the item data (flags included, as Item Piles does).
 */
function fakeItemPiles() {
  const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];
  const parse = (str) => {
    const out = {};
    for (const m of String(str).matchAll(/(\d+)\s*(cp|sp|ep|gp|pp)/g)) out[m[2]] = (out[m[2]] ?? 0) + Number(m[1]);
    return out;
  };
  const shift = async (actor, coins, sign) => {
    const now = { ...Object.fromEntries(COINS.map((c) => [c, 0])), ...actor.system.currency };
    for (const [c, n] of Object.entries(coins)) {
      now[c] += sign * n;
      if (now[c] < 0) throw new Error(`${actor.name} cannot pay ${n} ${c}`);
    }
    await actor.update({ system: { currency: now } });
  };
  const qty = (item) => Number(item.system?.quantity ?? 1);
  const receive = async (actor, item, quantity) => {
    const existing = [...actor.items].find((i) => i.name === item.name);
    if (existing) return existing.update({ system: { quantity: qty(existing) + quantity } });
    const data = item.toObject();
    delete data._id;
    data.system.quantity = quantity;
    return actor.createItem(data);
  };
  const lose = async (actor, item, quantity) => {
    const left = qty(item) - quantity;
    if (left > 0) await item.update({ system: { quantity: left } });
    else await item.delete();
  };
  const byId = (actor, ref) => (typeof ref === 'string' ? actor.items.get(ref) : actor.items.get(ref._id ?? ref.id));
  const isMerchant = (actor) => actor.flags?.['item-piles']?.data?.type === 'merchant';
  const price = (item) => {
    const p = item.system?.price ?? {};
    return { [p.denomination ?? 'gp']: Number(p.value) || 0 };
  };
  return {
    calls: [],
    async updateItemPile(actor, data) {
      actor.flags['item-piles'] = { data: { ...(actor.flags['item-piles']?.data ?? {}), ...data } };
    },
    isItemPileMerchant: isMerchant,
    async addCurrencies(actor, str) {
      await shift(actor, parse(str), +1);
    },
    async removeCurrencies(actor, str) {
      await shift(actor, parse(str), -1);
    },
    async transferCurrencies(from, to, str) {
      await shift(from, parse(str), -1);
      await shift(to, parse(str), +1);
    },
    async tradeItems(seller, buyer, items) {
      for (const { item, quantity } of items) {
        const cost = Object.fromEntries(Object.entries(price(item)).map(([c, n]) => [c, n * quantity * (isMerchant(seller) ? 1 : 0.5)]));
        if (!isMerchant(buyer)) await shift(buyer, cost, -1);
        if (!isMerchant(seller)) await shift(seller, cost, +1);
        await receive(buyer, item, quantity);
        await lose(seller, item, quantity);
      }
    },
    async transferItems(from, to, items) {
      for (const ref of items) {
        const item = byId(from, ref);
        await receive(to, item, ref.quantity ?? qty(item));
        await lose(from, item, ref.quantity ?? qty(item));
      }
    },
    async transferAllItems(from, to) {
      for (const item of [...from.items]) {
        await receive(to, item, qty(item));
        await item.delete();
      }
    },
    async removeItems(actor, items) {
      for (const ref of items) {
        const item = byId(actor, ref);
        if (item) await lose(actor, item, ref.quantity ?? qty(item));
      }
    }
  };
}
