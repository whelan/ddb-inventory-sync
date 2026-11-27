import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENTITY_TYPES, MODULE_ID } from '../scripts/core/constants.js';
import { buildIndex, matchDefinition, nameVariants, normalizeName } from '../scripts/core/matcher.js';
import {
  changedPaths,
  coalesceKey,
  isForeignCurrencyUpdate,
  isForeignItemUpdate,
  mergeOps,
  plainDescription,
  planCreate,
  planCurrency,
  planDelete,
  planUpdate,
  priceInGp
} from '../scripts/core/planner.js';
import { SyncQueue } from '../scripts/core/queue.js';
import { SyncEngine, addedRows } from '../scripts/core/engine.js';
import { invertMapping, resolveTarget } from '../scripts/core/targets.js';
import { findRowFor, linkRows, looksLikeImport } from '../scripts/core/linker.js';
import { ProxyClient } from '../scripts/core/client.js';

const CHAR = { kind: 'character', characterId: 111, container: { id: 111, typeId: ENTITY_TYPES.CHARACTER } };
const PARTY = { kind: 'party', characterId: 111, container: { id: 999, typeId: ENTITY_TYPES.CAMPAIGN } };
const rope = { _id: 'i1', name: 'Rope, Hempen (50 feet)', type: 'loot', system: { quantity: 2 } };
const opts = { moduleId: MODULE_ID };

// --- matcher ---------------------------------------------------------------
test('normalizeName folds case, accents, apostrophes and punctuation', () => {
  assert.equal(normalizeName("Healer's Kit"), 'healers kit');
  assert.equal(normalizeName('Épée, +1'), 'epee +1');
});

test('nameVariants tries without parentheses and both +N orders', () => {
  assert.deepEqual(nameVariants('Longsword +1'), ['longsword +1', '+1 longsword']);
  assert.ok(nameVariants('Rope, Hempen (50 feet)').includes('rope hempen'));
});

test('buildIndex: homebrew > current > legacy for a shared name', () => {
  const index = buildIndex([
    { id: 1, entityTypeId: 10, name: 'Potion of Healing', isLegacy: true },
    { id: 2, entityTypeId: 10, name: 'Potion of Healing' },
    { id: 3, entityTypeId: 10, name: 'Bell', isLegacy: true },
    { id: 4, entityTypeId: 10, name: 'Bell', isHomebrew: true },
    { id: 'bad', entityTypeId: 10, name: 'Broken' }
  ]);
  assert.equal(index.get('potion of healing').id, 2);
  assert.equal(index.get('bell').id, 4);
  assert.equal(index.has('broken'), false);
});

test('matchDefinition: own flag, then DDB Importer flag, then name', () => {
  const index = buildIndex([{ id: 3, entityTypeId: 20, name: 'Rope, Hempen' }]);
  assert.equal(matchDefinition(rope, index, MODULE_ID).id, 3);
  assert.equal(matchDefinition({ name: 'x', flags: { ddbimporter: { definitionId: 7, definitionEntityTypeId: 8 } } }, index, MODULE_ID).source, 'ddbimporter');
  assert.equal(
    matchDefinition({ name: 'x', flags: { [MODULE_ID]: { definition: { id: 5, entityTypeId: 6 } }, ddbimporter: { definitionId: 7, definitionEntityTypeId: 8 } } }, index, MODULE_ID).id,
    5
  );
  assert.equal(matchDefinition({ name: 'Unknown Trinket' }, index, MODULE_ID), null);
  assert.equal(matchDefinition({ name: 'Rope, Hempen' }, null, MODULE_ID), null, 'no index -> only flags');
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
  assert.equal(resolveTarget({ _id: 'party' }, { ...ctx, actorToDdb: new Map(), party: { actorId: 'party', campaignId: 9 } }), null, 'no carrier -> not synced');
});

// --- planner ---------------------------------------------------------------
test('planCreate: definition -> add; unmatched -> custom or skip; quantity 0 and non-inventory ignored', () => {
  const add = planCreate(rope, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op;
  assert.deepEqual([add.kind, add.quantity, add.scope, add.definition.id], ['add', 2, 'character', 3]);
  const custom = planCreate(
    { _id: 'i2', name: 'Bonegrinder Bell', type: 'loot', system: { quantity: 1, weight: { value: 2 }, price: { value: 25, denomination: 'sp' }, description: { value: '<p>Cold <b>iron</b></p>' } } },
    CHAR,
    { definition: null }
  ).op;
  assert.deepEqual([custom.custom.cost, custom.custom.weight, custom.custom.description], [2.5, 2, 'Cold iron']);
  const skip = planCreate(rope, CHAR, { definition: null, unmatched: 'skip' });
  assert.equal(skip.op, null);
  assert.equal(skip.unmatched, true);
  assert.equal(planCreate({ ...rope, system: { quantity: 0 } }, CHAR, { definition: { id: 3, entityTypeId: 20 } }).op, null);
  assert.equal(planCreate({ _id: 's', name: 'Fireball', type: 'spell' }, CHAR, { definition: null }).op, null);
  assert.equal(planCreate(rope, null, { definition: null }).op, null);
});

test('planUpdate: quantity with delta, 0 removes, unchanged is nothing, equipped only for characters', () => {
  const [q] = planUpdate(rope, { system: { quantity: 5 } }, CHAR, { ...opts, previousQuantity: 2 });
  assert.deepEqual([q.kind, q.quantity, q.delta], ['quantity', 5, 3]);
  assert.equal(planUpdate(rope, { system: { quantity: 5 } }, CHAR, opts)[0].delta, null, 'unknown previous -> no delta');
  const [r] = planUpdate(rope, { system: { quantity: 0 } }, CHAR, { ...opts, previousQuantity: 2 });
  assert.deepEqual([r.kind, r.quantity], ['remove', 2]);
  assert.deepEqual(planUpdate(rope, { system: { quantity: 2 } }, CHAR, { ...opts, previousQuantity: 2 }), []);
  assert.deepEqual(planUpdate(rope, { system: { equipped: true, attuned: true } }, CHAR, opts).map((o) => o.kind), ['equipped', 'attuned']);
  assert.deepEqual(planUpdate(rope, { system: { equipped: true } }, PARTY, opts), []);
  assert.deepEqual(planUpdate(rope, { name: 'Rope' }, CHAR, opts), []);
  assert.deepEqual(planUpdate(rope, { 'system.quantity': 4 }, CHAR, { ...opts, previousQuantity: 2 })[0].delta, 2, 'dotted keys');
});

test('planDelete carries the stack that left and the ref for linking', () => {
  const op = planDelete({ ...rope, flags: { ddbimporter: { definitionId: 3 } } }, CHAR, opts);
  assert.deepEqual([op.kind, op.quantity, op.ref.definitionId], ['remove', 2, 3]);
  assert.equal(planDelete(rope, null, opts), null);
});

test('planCurrency: delta from the previous purse, nothing when nothing moved', () => {
  const op = planCurrency({ gp: 12.7, sp: 3, cp: -4 }, { system: { currency: { gp: 12 } } }, PARTY, { gp: 20, sp: 3 });
  assert.deepEqual(op.coins, { cp: 0, sp: 3, ep: 0, gp: 12, pp: 0 });
  assert.deepEqual(op.delta, { cp: 0, sp: 0, ep: 0, gp: -8, pp: 0 });
  assert.deepEqual(op.destination, { id: 999, typeId: ENTITY_TYPES.CAMPAIGN });
  assert.equal(planCurrency({ gp: 5 }, { system: { currency: { gp: 5 } } }, CHAR, { gp: 5 }), null);
  assert.equal(planCurrency({ gp: 5 }, { system: { currency: { gp: 5 } } }, CHAR).delta, null);
  assert.equal(planCurrency({ gp: 1 }, { system: { attributes: {} } }, CHAR), null);
});

test('foreign updates: an import touches more than inventory fields', () => {
  assert.deepEqual(changedPaths({ system: { quantity: 2 }, 'flags.x.y': 1 }), ['system.quantity', 'flags.x.y']);
  assert.equal(isForeignItemUpdate({ system: { quantity: 3 }, _stats: { modifiedTime: 1 } }), false);
  assert.equal(isForeignItemUpdate({ system: { quantity: 3, description: { value: 'x' } } }), true);
  assert.equal(isForeignItemUpdate({ name: 'Renamed' }), true);
  assert.equal(isForeignCurrencyUpdate({ system: { currency: { gp: 3 } } }), false);
  assert.equal(isForeignCurrencyUpdate({ system: { currency: { gp: 3 }, attributes: { hp: { value: 4 } } } }), true);
});

test('coalesce and merge: latest value, summed deltas, unknown delta stays unknown', () => {
  assert.equal(coalesceKey({ kind: 'add', itemId: 'x' }), null);
  assert.equal(coalesceKey({ kind: 'quantity', itemId: 'x' }), 'quantity:x');
  const q = mergeOps({ kind: 'quantity', quantity: 3, delta: 1, previousQuantity: 2 }, { kind: 'quantity', quantity: 5, delta: 2, previousQuantity: 3 });
  assert.deepEqual([q.quantity, q.delta, q.previousQuantity], [5, 3, 2]);
  assert.equal(mergeOps({ kind: 'quantity', delta: null }, { kind: 'quantity', delta: 2 }).delta, null);
  const c = mergeOps({ kind: 'currency', delta: { gp: -5 } }, { kind: 'currency', coins: { gp: 1 }, delta: { gp: -4 } });
  assert.equal(c.delta.gp, -9);
});

test('helpers: priceInGp, plainDescription', () => {
  assert.equal(priceInGp({ value: 3, denomination: 'pp' }), 30);
  assert.equal(priceInGp({ value: 0 }), null);
  assert.equal(plainDescription('<p>a</p><p>b &amp; c</p>'), 'a\n\nb & c');
});

// --- queue -----------------------------------------------------------------
test('SyncQueue: one lane per character, in order, merges waiting ops', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const q = new SyncQueue(
    async (op) => {
      if (op.n === 1) await gate;
      seen.push(`${op.n}:${op.delta ?? ''}`);
    },
    { coalesceKey, merge: mergeOps }
  );
  q.push({ characterId: 1, kind: 'add', n: 1 });
  q.push({ characterId: 1, kind: 'quantity', itemId: 'a', n: 2, delta: 1 });
  q.push({ characterId: 1, kind: 'quantity', itemId: 'a', n: 3, delta: 2 });
  q.push({ characterId: 2, kind: 'add', n: 9 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['9:']);
  release();
  await q.idle();
  assert.deepEqual(seen, ['9:', '1:', '3:3']);
});

test('SyncQueue: failures are kept and can be retried', async () => {
  let failing = true;
  const seen = [];
  const q = new SyncQueue(async (op) => {
    if (op.fail && failing) throw new Error('boom');
    seen.push(op.n);
  });
  q.push({ characterId: 1, fail: true, n: 1 });
  q.push({ characterId: 1, n: 2 });
  await q.idle();
  assert.deepEqual(seen, [2]);
  assert.equal(q.failed[0].error, 'boom');
  failing = false;
  assert.equal(q.retryFailed(), 1);
  await q.idle();
  assert.deepEqual(seen, [2, 1]);
  assert.equal(q.failed.length, 0);
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

test('findRowFor: definition first, skips claimed rows, prefers matching quantity', () => {
  const rows = [
    { id: 1, definitionId: 3, name: 'Rope', quantity: 1 },
    { id: 2, definitionId: 3, name: 'Rope', quantity: 4 },
    { id: 3, definitionId: null, name: 'Bell', quantity: 1 }
  ];
  assert.equal(findRowFor(rows, { definitionId: 3, name: 'Rope' }, { quantity: 4 }).id, 2);
  assert.equal(findRowFor(rows, { definitionId: 3, name: 'Rope' }, { isClaimed: (id) => id === 2, quantity: 4 }).id, 1);
  assert.equal(findRowFor(rows, { name: 'bell' }).id, 3);
  assert.equal(findRowFor(rows, { name: 'Nothing' }), null);
});

test('looksLikeImport: only big bursts of DDB-imported items', () => {
  const imported = Array.from({ length: 12 }, () => ({ flags: { ddbimporter: { id: 1 } } }));
  const loot = Array.from({ length: 12 }, () => ({ flags: {} }));
  assert.equal(looksLikeImport(imported, 8), true);
  assert.equal(looksLikeImport(loot, 8), false);
  assert.equal(looksLikeImport(imported.slice(0, 5), 8), false);
});

// --- engine ----------------------------------------------------------------
function fakeDeps({ rows = [], currencies = { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 }, responses = {}, dry = false, mode = 'delta', verify = true, planAdd = null } = {}) {
  const calls = [];
  const store = new Map();
  const ddb = { rows: rows.map((r) => ({ ...r })), currencies: { ...currencies }, nextId: 5000 };
  const client = {
    async call(characterId, op, payload) {
      calls.push({ characterId, op, payload });
      if (responses[op]) {
        const r = typeof responses[op] === 'function' ? responses[op](payload) : responses[op];
        if (r) return r;
      }
      if (op === 'read') return { success: true, data: { inventory: ddb.rows.map((r) => ({ ...r })), currencies: { ...ddb.currencies } } };
      if (op === 'add' || op === 'customItem') {
        const e = payload.equipment?.[0] ?? payload;
        const row = { id: ddb.nextId++, definitionId: e.entityId ?? null, name: payload.name ?? 'x', quantity: e.quantity };
        if (!e.containerEntityTypeId) ddb.rows.push(row);
        return { success: true, data: { addItems: [row] } };
      }
      if (op === 'quantity') ddb.rows.find((r) => r.id === payload.id).quantity = payload.quantity;
      if (op === 'remove') {
        const i = ddb.rows.findIndex((r) => r.id === payload.id);
        if (i === -1) return { success: false, ddbStatus: 404, message: 'Item not found' };
        ddb.rows.splice(i, 1);
      }
      if (op === 'equipped') ddb.rows.find((r) => r.id === payload.id).equipped = payload.value;
      if (op === 'currency') for (const c of ['cp', 'sp', 'ep', 'gp', 'pp']) if (payload[c] !== undefined) ddb.currencies[c] = payload[c];
      return { success: true, data: {} };
    }
  };
  client.read = (id) => client.call(id, 'read');
  const missing = new Set();
  const ids = {
    get: (k) => (store.has(k) ? { ddbId: store.get(k) } : null),
    set: async (k, v) => {
      store.set(k, v);
      missing.delete(k);
    },
    forget: (k) => {
      store.delete(k);
      missing.add(k);
    },
    release: (k) => missing.delete(k),
    knownMissing: (k) => missing.has(k),
    isClaimed: (id, op) => [...store.entries()].some(([k, v]) => v === id && k !== op.itemId)
  };
  const logs = [];
  const engine = new SyncEngine({
    client,
    ids,
    planAddFor: async (itemId) => (planAdd ? { ...planAdd, itemId } : null),
    log: (l, m) => logs.push([l, m]),
    dryRun: () => dry,
    mode: () => mode,
    verify: () => verify,
    sleep: async () => {}
  });
  return { engine, calls, store, logs, ddb, missing, writes: () => calls.filter((c) => c.op !== 'read') };
}

const addOp = (target = CHAR) => planCreate(rope, target, { definition: { id: 3, entityTypeId: 20 } }).op;

test('engine add: character omits the container, stores the row id, verifies', async () => {
  const { engine, writes, store, ddb } = fakeDeps();
  await engine.run(addOp());
  assert.deepEqual(writes()[0], { characterId: 111, op: 'add', payload: { equipment: [{ entityId: 3, entityTypeId: 20, quantity: 2 }] } });
  assert.equal(store.get('i1'), ddb.rows[0].id);
});

test('engine add: no row id in the answer -> found by reading, newest unclaimed row', async () => {
  const { engine, store } = fakeDeps({
    rows: [{ id: 10, definitionId: 3, name: 'Rope', quantity: 1 }],
    responses: { add: () => null }
  });
  store.set('other', 10);
  // make add answer without addItems but still create a row
  engine.client.call = ((orig) => async (cid, op, payload) => {
    const r = await orig(cid, op, payload);
    return op === 'add' ? { success: true, data: {} } : r;
  })(engine.client.call);
  await engine.run(addOp());
  assert.equal(store.get('i1'), 5000);
});

test('engine add to the party: campaign container; custom items carry partyId; no reads', async () => {
  const { engine, calls } = fakeDeps();
  await engine.run(addOp(PARTY));
  assert.deepEqual(calls[0].payload.equipment[0], { entityId: 3, entityTypeId: 20, quantity: 2, containerEntityId: 999, containerEntityTypeId: ENTITY_TYPES.CAMPAIGN });
  await engine.run(planCreate(rope, PARTY, { definition: null }).op);
  assert.equal(calls[1].op, 'customItem');
  assert.equal(calls[1].payload.partyId, 999);
  assert.equal(calls.filter((c) => c.op === 'read').length, 0);
});

test('engine quantity in delta mode keeps what a player changed on D&D Beyond', async () => {
  const { engine, writes, store, ddb } = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1 }] });
  store.set('i1', 77);
  // Foundry 2 -> 5 (+3) while the player had used one on D&D Beyond (2 -> 1)
  await engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 5, delta: 3 });
  assert.deepEqual(writes().at(-1), { characterId: 111, op: 'quantity', payload: { id: 77, quantity: 4 } });
  assert.equal(ddb.rows[0].quantity, 4);
});

test('engine quantity in absolute mode, or without a known delta, sets the Foundry value', async () => {
  for (const [mode, delta] of [['absolute', 3], ['delta', null]]) {
    const { engine, writes, store } = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1 }], mode });
    store.set('i1', 77);
    await engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 5, delta });
    assert.equal(writes().at(-1).payload.quantity, 5, mode);
  }
});

test('engine quantity: delta to 0 on D&D Beyond removes the row', async () => {
  const { engine, writes, store, ddb } = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1 }] });
  store.set('i1', 77);
  await engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 1, delta: -2 });
  assert.equal(writes().at(-1).op, 'remove');
  assert.equal(ddb.rows.length, 0);
});

test('engine quantity on an unlinked item links it by definition first', async () => {
  const { engine, store } = fakeDeps({ rows: [{ id: 41, definitionId: 3, name: 'Rope, Hempen', quantity: 2 }] });
  await engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope, Hempen', characterId: 111, scope: 'character', quantity: 3, delta: 1, previousQuantity: 2, ref: { definitionId: 3, name: 'Rope, Hempen' } });
  assert.equal(store.get('i1'), 41);
});

test('engine quantity on an item not on D&D Beyond adds it (delta mode)', async () => {
  const { engine, writes } = fakeDeps({ planAdd: addOp() });
  await engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 3, delta: 1, ref: { name: 'Nope' } });
  assert.equal(writes()[0].op, 'add');
});

test('engine remove: only the stack that left; extra on D&D Beyond stays', async () => {
  const { engine, writes, store, ddb } = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 5 }] });
  store.set('i1', 77);
  await engine.run({ kind: 'remove', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 2 });
  assert.deepEqual(writes().at(-1), { characterId: 111, op: 'quantity', payload: { id: 77, quantity: 3 } });
  assert.equal(ddb.rows[0].quantity, 3);
});

test('engine remove: whole row; already gone is fine; known-missing never links by name', async () => {
  const a = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 2 }] });
  a.store.set('i1', 77);
  await a.engine.run({ kind: 'remove', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 2 });
  assert.equal(a.ddb.rows.length, 0);

  const b = fakeDeps({ rows: [] });
  b.store.set('i1', 77); // stored id, but the player already deleted it on D&D Beyond
  await b.engine.run({ kind: 'remove', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 2 });
  assert.equal(b.writes().length, 0);

  const c = fakeDeps({ rows: [{ id: 50, definitionId: 3, name: 'Rope', quantity: 2 }] });
  c.missing.add('i1'); // this item never got a row; the Rope row is someone else's
  await c.engine.run({ kind: 'remove', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 2, ref: { definitionId: 3, name: 'Rope' } });
  assert.equal(c.writes().length, 0);
  assert.equal(c.ddb.rows.length, 1);
});

test('engine remove on the party uses the stored id only', async () => {
  const { engine, calls, store } = fakeDeps();
  await engine.run({ kind: 'remove', itemId: 'p1', name: 'Rope', characterId: 111, scope: 'party', quantity: 1 });
  assert.equal(calls.length, 0, 'unknown party row: nothing to do, no read');
  store.set('p1', 9);
  await engine.run({ kind: 'remove', itemId: 'p1', name: 'Rope', characterId: 111, scope: 'party', quantity: 1 });
  assert.deepEqual(calls.map((c) => c.op), ['remove']);
});

test('engine currency: delta applied to D&D Beyond coins, never below 0; party is absolute', async () => {
  const { engine, writes, ddb } = fakeDeps({ currencies: { cp: 0, sp: 0, ep: 0, gp: 3, pp: 0 } });
  // Foundry 10 -> 5 gp (-5), but the player spent 7 on D&D Beyond already (3 left)
  await engine.run({ kind: 'currency', characterId: 111, scope: 'character', destination: { id: 111, typeId: ENTITY_TYPES.CHARACTER }, coins: { cp: 0, sp: 0, ep: 0, gp: 5, pp: 0 }, delta: { cp: 0, sp: 0, ep: 0, gp: -5, pp: 0 } });
  assert.equal(ddb.currencies.gp, 0);
  const p = fakeDeps();
  await p.engine.run({ kind: 'currency', characterId: 111, scope: 'party', destination: { id: 999, typeId: ENTITY_TYPES.CAMPAIGN }, coins: { cp: 0, sp: 0, ep: 0, gp: 7, pp: 0 }, delta: { gp: 7 } });
  assert.deepEqual(p.calls.map((c) => c.op), ['currency']);
  assert.equal(p.calls[0].payload.gp, 7);
  assert.ok(writes().length === 1);
});

test('engine verify catches a write D&D Beyond did not apply', async () => {
  const { engine, store } = fakeDeps({
    rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1 }],
    responses: { quantity: () => ({ success: true, data: {} }) } // accepted but ignored
  });
  store.set('i1', 77);
  await assert.rejects(
    engine.run({ kind: 'quantity', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', quantity: 4, delta: 3 }),
    /Verify failed: Rope quantity is 1/
  );
});

test('engine retries transient failures, not rejections', async () => {
  let n = 0;
  const flaky = fakeDeps({ responses: { add: () => (n++ < 2 ? { success: false, ddbStatus: 503, message: 'busy' } : null) } });
  await flaky.engine.run(addOp());
  assert.equal(flaky.calls.filter((c) => c.op === 'add').length, 3);

  let m = 0;
  const rejected = fakeDeps({ responses: { add: () => (m++, { success: false, ddbStatus: 400, message: 'Bad Request' }) } });
  await assert.rejects(rejected.engine.run(addOp()), (err) => err.ddbStatus === 400 && !err.transient);
  assert.equal(m, 1);

  const down = fakeDeps();
  let k = 0;
  down.engine.client.call = async () => {
    k++;
    throw new Error('fetch failed');
  };
  await assert.rejects(down.engine.run(addOp()), (err) => err.transient);
  assert.equal(k, 3);
});

test('engine dry run never writes (reads are allowed)', async () => {
  const { engine, writes, logs } = fakeDeps({ dry: true, rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1 }] });
  await engine.run(addOp());
  await engine.run({ kind: 'quantity', itemId: 'x', name: 'Rope', characterId: 111, scope: 'character', quantity: 3, delta: 1, ref: { definitionId: 3 } });
  await engine.run({ kind: 'currency', characterId: 111, scope: 'character', destination: { id: 111, typeId: ENTITY_TYPES.CHARACTER }, coins: { gp: 1 }, delta: { gp: 1 } });
  assert.equal(writes().length, 0);
  assert.ok(logs.filter(([, m]) => m.startsWith('[dry-run]')).length >= 3);
});

test('engine equipped: skips when unchanged, verifies otherwise', async () => {
  const { engine, writes, store } = fakeDeps({ rows: [{ id: 77, definitionId: 3, name: 'Rope', quantity: 1, equipped: true }] });
  store.set('i1', 77);
  await engine.run({ kind: 'equipped', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', value: true });
  assert.equal(writes().length, 0);
  await engine.run({ kind: 'equipped', itemId: 'i1', name: 'Rope', characterId: 111, scope: 'character', value: false });
  assert.deepEqual(writes()[0].payload, { id: 77, value: false });
});

test('addedRows tolerates both wrapper shapes', () => {
  assert.equal(addedRows({ data: { addItems: [{ id: 1 }] } }).length, 1);
  assert.equal(addedRows({ success: true }).length, 0);
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

test('ProxyClient marks a non-2xx answer as failed and times out', async () => {
  const c = new ProxyClient({
    proxyUrl: () => 'http://p',
    cobaltFor: () => 'x',
    fetch: async () => ({ ok: false, status: 502, json: async () => ({ message: 'bad gateway' }) })
  });
  assert.equal((await c.call(1, 'read')).success, false);
  const slow = new ProxyClient({
    proxyUrl: () => 'http://p',
    cobaltFor: () => 'x',
    timeoutMs: 20,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  });
  await assert.rejects(slow.call(1, 'read'), /timed out/);
});
