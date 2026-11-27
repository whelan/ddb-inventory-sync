import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENTITY_TYPES, MODULE_ID } from '../scripts/core/constants.js';
import { buildIndex, matchDefinition, nameVariants, normalizeName } from '../scripts/core/matcher.js';
import { coalesceKey, planCreate, planCurrency, planDelete, planUpdate, priceInGp, plainDescription } from '../scripts/core/planner.js';
import { SyncQueue } from '../scripts/core/queue.js';
import { SyncEngine, addedRows } from '../scripts/core/engine.js';
import { invertMapping, resolveTarget } from '../scripts/core/targets.js';
import { linkRows, looksLikeImport } from '../scripts/core/linker.js';
import { ProxyClient } from '../scripts/core/client.js';

const CHAR = { kind: 'character', characterId: 111, container: { id: 111, typeId: ENTITY_TYPES.CHARACTER } };
const PARTY = { kind: 'party', characterId: 111, container: { id: 999, typeId: ENTITY_TYPES.CAMPAIGN } };
const rope = { _id: 'i1', name: 'Rope, Hempen (50 feet)', type: 'loot', system: { quantity: 2 } };

// --- matcher ---------------------------------------------------------------
test('normalizeName folds case, accents, apostrophes and punctuation', () => {
  assert.equal(normalizeName("Healer's Kit"), 'healers kit');
  assert.equal(normalizeName('Épée, +1'), 'epee +1');
});

test('nameVariants tries without parentheses and both +N orders', () => {
  assert.deepEqual(nameVariants('Longsword +1'), ['longsword +1', '+1 longsword']);
  assert.ok(nameVariants('Rope, Hempen (50 feet)').includes('rope hempen'));
});

test('matchDefinition: own flag, then DDB Importer flag, then name; homebrew wins a name tie', () => {
  const index = buildIndex([
    { id: 1, entityTypeId: 10, name: 'Potion of Healing' },
    { id: 2, entityTypeId: 10, name: 'Potion of Healing', isHomebrew: true },
    { id: 3, entityTypeId: 20, name: 'Rope, Hempen' }
  ]);
  assert.deepEqual(matchDefinition({ name: 'Potion of Healing' }, index, MODULE_ID), { id: 2, entityTypeId: 10, source: 'name' });
  assert.equal(matchDefinition(rope, index, MODULE_ID).id, 3);
  assert.equal(
    matchDefinition({ name: 'x', flags: { ddbimporter: { definitionId: 7, definitionEntityTypeId: 8 } } }, index, MODULE_ID).source,
    'ddbimporter'
  );
  assert.equal(
    matchDefinition({ name: 'x', flags: { [MODULE_ID]: { definition: { id: 5, entityTypeId: 6 } }, ddbimporter: { definitionId: 7, definitionEntityTypeId: 8 } } }, index, MODULE_ID).id,
    5
  );
  assert.equal(matchDefinition({ name: 'Unknown Trinket' }, index, MODULE_ID), null);
});

// --- targets ---------------------------------------------------------------
test('resolveTarget: party actor, own flag, ddb-sync mapping, DDB Importer flag', () => {
  const actorToDdb = invertMapping({ 222: 'actorB', bogus: 'x' });
  const ctx = { moduleId: MODULE_ID, actorToDdb, party: { actorId: 'party', campaignId: '999', carrierCharacterId: '' } };
  assert.deepEqual(resolveTarget({ _id: 'party' }, ctx), { kind: 'party', characterId: 222, container: { id: 999, typeId: ENTITY_TYPES.CAMPAIGN } });
  assert.equal(resolveTarget({ _id: 'actorB' }, ctx).characterId, 222);
  assert.equal(resolveTarget({ _id: 'a', flags: { [MODULE_ID]: { characterId: '333' } } }, ctx).characterId, 333);
  assert.equal(resolveTarget({ _id: 'a', flags: { ddbimporter: { dndbeyond: { characterId: 444 } } } }, ctx).characterId, 444);
  assert.equal(resolveTarget({ _id: 'merchant' }, ctx), null);
  assert.equal(resolveTarget({ _id: 'party' }, { ...ctx, party: { actorId: 'party' } }), null, 'no campaign -> not synced');
});

// --- planner ---------------------------------------------------------------
test('planCreate: definition -> add; unmatched -> custom item or skip; non-inventory ignored', () => {
  assert.deepEqual(planCreate(rope, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op.definition, { id: 3, entityTypeId: 20 });
  assert.equal(planCreate(rope, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op.quantity, 2);
  const custom = planCreate(
    { _id: 'i2', name: 'Bonegrinder Bell', type: 'loot', system: { quantity: 1, price: { value: 25, denomination: 'sp' }, description: { value: '<p>Cold <b>iron</b></p>' } } },
    CHAR,
    { definition: null }
  ).op;
  assert.equal(custom.custom.cost, 2.5);
  assert.equal(custom.custom.description, 'Cold iron');
  assert.equal(planCreate(rope, CHAR, { definition: null, unmatched: 'skip' }).op, null);
  assert.equal(planCreate({ _id: 's', name: 'Fireball', type: 'spell' }, CHAR, { definition: null }).op, null);
  assert.equal(planCreate(rope, null, { definition: null }).op, null);
});

test('planUpdate: quantity, quantity 0 removes, equipped only for characters', () => {
  assert.deepEqual(planUpdate(rope, { system: { quantity: 5 } }, CHAR).map((o) => o.kind), ['quantity']);
  assert.deepEqual(planUpdate(rope, { system: { quantity: 0 } }, CHAR).map((o) => o.kind), ['remove']);
  assert.deepEqual(planUpdate(rope, { system: { equipped: true, attuned: true } }, CHAR).map((o) => o.kind), ['equipped', 'attuned']);
  assert.deepEqual(planUpdate(rope, { system: { equipped: true } }, PARTY), []);
  assert.deepEqual(planUpdate(rope, { name: 'Rope' }, CHAR), []);
});

test('planCurrency sends the whole purse to the right destination', () => {
  const op = planCurrency({ gp: 12.7, sp: 3, cp: -4 }, { system: { currency: { gp: 12 } } }, PARTY);
  assert.deepEqual(op.coins, { cp: 0, sp: 3, ep: 0, gp: 12, pp: 0 });
  assert.deepEqual(op.destination, { id: 999, typeId: ENTITY_TYPES.CAMPAIGN });
  assert.equal(planCurrency({ gp: 1 }, { system: { attributes: {} } }, CHAR), null);
});

test('helpers: priceInGp, plainDescription, coalesceKey', () => {
  assert.equal(priceInGp({ value: 3, denomination: 'pp' }), 30);
  assert.equal(priceInGp({ value: 0 }), null);
  assert.equal(plainDescription('<p>a</p><p>b</p>'), 'a\n\nb');
  assert.equal(coalesceKey({ kind: 'add', itemId: 'x' }), null);
  assert.equal(coalesceKey({ kind: 'quantity', itemId: 'x' }), 'quantity:x');
});

test('planDelete only for synced inventory', () => {
  assert.equal(planDelete(rope, CHAR).kind, 'remove');
  assert.equal(planDelete(rope, null), null);
});

// --- queue -----------------------------------------------------------------
test('SyncQueue runs one lane per character in order and coalesces waiting ops', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const q = new SyncQueue(
    async (op) => {
      if (op.n === 1) await gate;
      seen.push(op.n);
    },
    { coalesceKey }
  );
  q.push({ characterId: 1, kind: 'add', n: 1 });
  q.push({ characterId: 1, kind: 'quantity', itemId: 'a', n: 2 });
  q.push({ characterId: 1, kind: 'quantity', itemId: 'a', n: 3 }); // replaces n:2
  q.push({ characterId: 2, kind: 'add', n: 9 }); // other lane, not blocked
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [9]);
  release();
  await q.idle();
  assert.deepEqual(seen, [9, 1, 3]);
});

test('SyncQueue reports errors and keeps going', async () => {
  const errors = [];
  const seen = [];
  const q = new SyncQueue(
    async (op) => {
      if (op.fail) throw new Error('boom');
      seen.push(op.n);
    },
    { onError: (op, e) => errors.push(e.message) }
  );
  q.push({ characterId: 1, fail: true });
  q.push({ characterId: 1, n: 2 });
  await q.idle();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(seen, [2]);
});

// --- engine ----------------------------------------------------------------
function fakeDeps({ responses = {}, dry = false } = {}) {
  const calls = [];
  const store = new Map();
  const client = {
    async call(characterId, op, payload) {
      calls.push({ characterId, op, payload });
      return responses[op] ?? { success: true, data: {} };
    }
  };
  const ids = {
    get: (k) => (store.has(k) ? { ddbId: store.get(k) } : null),
    set: async (k, v) => store.set(k, v),
    forget: (k) => store.delete(k)
  };
  const logs = [];
  const engine = new SyncEngine({ client, ids, log: (l, m) => logs.push([l, m]), dryRun: () => dry });
  return { engine, calls, store, logs };
}

test('engine add to a character omits the container and stores the new row id', async () => {
  const { engine, calls, store } = fakeDeps({
    responses: { add: { success: true, data: { addItems: [{ id: 5551, definitionId: 3 }] } } }
  });
  await engine.run({ ...planCreate(rope, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op });
  assert.deepEqual(calls[0], { characterId: 111, op: 'add', payload: { equipment: [{ entityId: 3, entityTypeId: 20, quantity: 2 }] } });
  assert.equal(store.get('i1'), 5551);
});

test('engine add to the party targets the campaign container; custom items carry partyId', async () => {
  const { engine, calls } = fakeDeps();
  await engine.run(planCreate(rope, PARTY, { definition: { id: 3, entityTypeId: 20 } }).op);
  assert.deepEqual(calls[0].payload.equipment[0], {
    entityId: 3, entityTypeId: 20, quantity: 2, containerEntityId: 999, containerEntityTypeId: ENTITY_TYPES.CAMPAIGN
  });
  await engine.run(planCreate(rope, PARTY, { definition: null }).op);
  assert.equal(calls[1].op, 'customItem');
  assert.equal(calls[1].payload.partyId, 999);
  assert.equal(calls[1].payload.containerEntityTypeId, ENTITY_TYPES.CAMPAIGN);
});

test('engine quantity/remove use the stored row and skip unknown items', async () => {
  const { engine, calls, store } = fakeDeps();
  await engine.run({ kind: 'quantity', itemId: 'nope', characterId: 111, quantity: 4, name: 'x' });
  assert.equal(calls.length, 0);
  store.set('i1', 77);
  await engine.run({ kind: 'quantity', itemId: 'i1', characterId: 111, quantity: 4, name: 'x' });
  await engine.run({ kind: 'remove', itemId: 'i1', characterId: 111, name: 'x' });
  assert.deepEqual(calls.map((c) => [c.op, c.payload]), [
    ['quantity', { id: 77, quantity: 4 }],
    ['remove', { id: 77, removeContainerContents: false }]
  ]);
  assert.equal(store.has('i1'), false);
});

test('engine currency and rejected writes', async () => {
  const { engine, calls } = fakeDeps({ responses: { currency: { success: false, message: 'nope', ddbStatus: 403 } } });
  const op = planCurrency({ gp: 5 }, { system: { currency: { gp: 5 } } }, CHAR);
  await assert.rejects(engine.run(op), /nope/);
  assert.deepEqual(calls[0].payload, { cp: 0, sp: 0, ep: 0, gp: 5, pp: 0, destinationEntityId: 111, destinationEntityTypeId: ENTITY_TYPES.CHARACTER });
});

test('engine dry run never calls the proxy', async () => {
  const { engine, calls, logs } = fakeDeps({ dry: true });
  await engine.run(planCreate(rope, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op);
  assert.equal(calls.length, 0);
  assert.match(logs[0][1], /dry-run/);
});

test('addedRows tolerates both wrapper shapes', () => {
  assert.equal(addedRows({ data: { addItems: [{ id: 1 }] } }).length, 1);
  assert.equal(addedRows({ success: true }).length, 0);
});

// --- linker ----------------------------------------------------------------
test('linkRows pairs by definition and quantity, then by name', () => {
  const rows = [
    { id: 1, definitionId: 3, name: 'Rope, Hempen', quantity: 1 },
    { id: 2, definitionId: 3, name: 'Rope, Hempen', quantity: 2 },
    { id: 3, definitionId: 9, name: 'Dagger', quantity: 1 },
    { id: 4, definitionId: 8, name: 'Tinderbox', quantity: 1 }
  ];
  const items = [
    { uuid: 'a', name: 'Rope, Hempen', quantity: 2, definitionId: 3 },
    { uuid: 'b', name: 'dagger', quantity: 1 },
    { uuid: 'c', name: 'Linked already', quantity: 1, ddbId: 4 },
    { uuid: 'd', name: 'Vault Bauble', quantity: 1 }
  ];
  const r = linkRows(items, rows);
  assert.deepEqual(r.links, [{ uuid: 'a', ddbId: 2 }, { uuid: 'b', ddbId: 3 }]);
  assert.deepEqual(r.unmatchedItems, ['Vault Bauble']);
  assert.deepEqual(r.unmatchedRows, ['Rope, Hempen']);
});

test('looksLikeImport: only big bursts of DDB-imported items', () => {
  const imported = Array.from({ length: 12 }, () => ({ flags: { ddbimporter: { id: 1 } } }));
  const loot = Array.from({ length: 12 }, () => ({ flags: {} }));
  assert.equal(looksLikeImport(imported, 8), true);
  assert.equal(looksLikeImport(loot, 8), false);
  assert.equal(looksLikeImport(imported.slice(0, 5), 8), false);
});

// --- client ----------------------------------------------------------------
test('ProxyClient posts to /proxy/inventory and needs a URL and a cobalt', async () => {
  const sent = [];
  const c = new ProxyClient({
    proxyUrl: () => 'https://proxy.example/',
    cobaltFor: (id) => (id === 1 ? 'COB' : ''),
    fetch: async (url, init) => {
      sent.push([url, JSON.parse(init.body)]);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
  });
  await c.call(1, 'quantity', { id: 2, quantity: 3 });
  assert.deepEqual(sent[0], ['https://proxy.example/proxy/inventory', { cobalt: 'COB', characterId: 1, op: 'quantity', payload: { id: 2, quantity: 3 } }]);
  await assert.rejects(c.call(2, 'read'), /No cobalt/);
  await assert.rejects(new ProxyClient({ proxyUrl: () => '', cobaltFor: () => 'x', fetch: async () => {} }).call(1, 'read'), /No proxy URL/);
});
