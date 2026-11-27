/**
 * Drives scripts/main.js through a minimal Foundry stand-in: hooks fire the
 * way an Item Piles merchant purchase and a loot take do, and the test reads
 * the proxy calls that come out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE_ID = 'ddb-inventory-sync';
const hooks = new Map();
const settings = new Map();
const docs = new Map();
const proxyCalls = [];
const warnings = [];

const setSetting = (mod, key, value) => settings.set(`${mod}.${key}`, value);

globalThis.Hooks = {
  on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  once: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  call: (name, ...args) => (hooks.get(name) ?? []).forEach((fn) => fn(...args))
};
const moduleEntry = { active: true };
globalThis.game = {
  settings: {
    register: (mod, key, data) => {
      if (!settings.has(`${mod}.${key}`)) settings.set(`${mod}.${key}`, data.default);
    },
    get: (mod, key) => {
      if (!settings.has(`${mod}.${key}`)) throw new Error(`unregistered ${mod}.${key}`);
      return settings.get(`${mod}.${key}`);
    },
    set: async (mod, key, value) => settings.set(`${mod}.${key}`, value)
  },
  users: { activeGM: { isSelf: true } },
  user: { isGM: true },
  modules: new Map([[MODULE_ID, moduleEntry]])
};
globalThis.ui = { notifications: { warn: (m) => warnings.push(m) } };
globalThis.fromUuidSync = (uuid) => docs.get(uuid) ?? null;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  proxyCalls.push({ url, body });
  if (url.endsWith('/proxy/items')) {
    return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 3, entityTypeId: 20, name: 'Potion of Healing' }] }) };
  }
  if (body.op === 'add') {
    return { ok: true, status: 200, json: async () => ({ success: true, data: { addItems: [{ id: 9001, definitionId: 3 }] } }) };
  }
  return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
};

function makeActor(id, name, flags = {}) {
  return { id, _id: id, uuid: `Actor.${id}`, name, documentName: 'Actor', flags, items: [], system: { currency: { gp: 0 } }, toObject() { return { _id: id, flags }; } };
}
function makeItem(actor, id, data) {
  const item = {
    id,
    uuid: `${actor.uuid}.Item.${id}`,
    parent: actor,
    name: data.name,
    type: data.type,
    flags: data.flags ?? {},
    system: data.system,
    getFlag(mod, key) {
      return this.flags?.[mod]?.[key];
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const keys = path.split('.');
        let o = this;
        while (keys.length > 1) o = o[keys[0]] ??= {}, keys.shift();
        o[keys[0]] = value;
      }
    },
    toObject() {
      return { _id: id, name: this.name, type: this.type, flags: this.flags, system: structuredClone(this.system) };
    }
  };
  docs.set(item.uuid, item);
  return item;
}

await import('../scripts/main.js');
Hooks.call('init');
setSetting('ddb-sync', 'characterMapping', { 111: 'pc1' });
setSetting('ddb-sync', 'proxyUrl', 'https://proxy.example');
setSetting('ddb-sync', 'cobaltCookie', 'COBALT');
setSetting('ddb-sync', 'campaignId', '999');
setSetting(MODULE_ID, 'enabled', true);
setSetting(MODULE_ID, 'dryRun', false);
setSetting(MODULE_ID, 'partyActorId', 'party');
Hooks.call('ready');
const api = moduleEntry.api;
const settle = async () => {
  await new Promise((r) => setTimeout(r, 350)); // create batch window
  await api.idle();
};
const inventoryCalls = () => proxyCalls.filter((c) => c.url.endsWith('/proxy/inventory')).map((c) => [c.body.characterId, c.body.op, c.body.payload]);

test('merchant purchase: item, stack change, coins, sale — in order, to the mapped character', async () => {
  const pc = makeActor('pc1', 'Ireena');
  const potion = makeItem(pc, 'p1', { name: 'Potion of Healing', type: 'consumable', system: { quantity: 1 } });
  Hooks.call('createItem', potion, {});
  pc.system.currency = { gp: 45, sp: 0 };
  Hooks.call('updateActor', pc, { system: { currency: { gp: 45 } } }, {});
  await settle();

  potion.system.quantity = 3;
  Hooks.call('updateItem', potion, { system: { quantity: 3 } }, {});
  await settle();
  Hooks.call('deleteItem', potion, {});
  await settle();

  assert.deepEqual(inventoryCalls(), [
    [111, 'currency', { cp: 0, sp: 0, ep: 0, gp: 45, pp: 0, destinationEntityId: 111, destinationEntityTypeId: 1581111423 }],
    [111, 'add', { equipment: [{ entityId: 3, entityTypeId: 20, quantity: 1 }] }],
    [111, 'quantity', { id: 9001, quantity: 3 }],
    [111, 'remove', { id: 9001, removeContainerContents: false }]
  ]);
  assert.equal(potion.flags[MODULE_ID].ddbId, 9001);
});

test('loot to the party actor goes to the campaign party inventory, unknown item as custom', async () => {
  proxyCalls.length = 0;
  const party = makeActor('party', 'Party Stash');
  const bell = makeItem(party, 'b1', { name: 'Bonegrinder Bell', type: 'loot', system: { quantity: 1, price: { value: 10, denomination: 'gp' } } });
  Hooks.call('createItem', bell, {});
  await settle();
  const [[characterId, op, payload]] = inventoryCalls();
  assert.equal(characterId, 111, 'carried by the first mapped character');
  assert.equal(op, 'customItem');
  assert.equal(payload.partyId, 999);
  assert.equal(payload.containerEntityTypeId, 618115330);
  assert.equal(payload.cost, 10);
});

test('ignored: merchant actor, spells, skip option, a DDB Importer rebuild, non-GM client', async () => {
  proxyCalls.length = 0;
  const merchant = makeActor('m1', 'Bildrath');
  Hooks.call('createItem', makeItem(merchant, 'x', { name: 'Rope', type: 'loot', system: { quantity: 1 } }), {});
  const pc = makeActor('pc1', 'Ireena');
  Hooks.call('createItem', makeItem(pc, 's', { name: 'Fireball', type: 'spell', system: {} }), {});
  Hooks.call('createItem', makeItem(pc, 'k', { name: 'Rope', type: 'loot', system: { quantity: 1 } }), { [MODULE_ID]: { skip: true } });
  for (let i = 0; i < 12; i++) {
    Hooks.call('createItem', makeItem(pc, `imp${i}`, { name: `Thing ${i}`, type: 'loot', system: { quantity: 1 }, flags: { ddbimporter: { id: 100 + i } } }), {});
  }
  game.users.activeGM.isSelf = false;
  Hooks.call('updateActor', pc, { system: { currency: { gp: 1 } } }, {});
  game.users.activeGM.isSelf = true;
  await settle();
  assert.deepEqual(inventoryCalls(), []);
  assert.ok(api.log.some((e) => /looks like a character import/.test(e.message)));
});

test('dry run logs instead of writing', async () => {
  proxyCalls.length = 0;
  setSetting(MODULE_ID, 'dryRun', true);
  const pc = makeActor('pc1', 'Ireena');
  Hooks.call('createItem', makeItem(pc, 'd1', { name: 'Potion of Healing', type: 'consumable', system: { quantity: 1 } }), {});
  await settle();
  assert.deepEqual(inventoryCalls(), []);
  assert.ok(api.log.some((e) => /\[dry-run\] add/.test(e.message)));
  setSetting(MODULE_ID, 'dryRun', false);
});
