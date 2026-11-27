/**
 * Scenario tests: scripts/main.js inside a Foundry stand-in, talking over
 * HTTP to tools/mock-proxy.js. Each test plays one table situation and reads
 * the fake D&D Beyond afterwards.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFoundry } from './foundry-fake.js';
import { createMockProxy } from '../tools/mock-proxy.js';

const MODULE_ID = 'ddb-inventory-sync';
const F = installFoundry();
const mock = createMockProxy({ characters: [{ id: 111, name: 'Ireena' }, { id: 222, name: 'Ismark' }] });
let api;

const settle = async () => {
  await new Promise((r) => setTimeout(r, 360)); // batch window
  await api.idle();
};
const ddb = (id = 111) => mock.state.characters.get(id);
const party = () => mock.state.party.get(999) ?? { inventory: [], currencies: {} };
const writes = () => mock.state.calls.filter((c) => c.op !== 'read');
const potion = (quantity = 1, extra = {}) => ({ name: 'Potion of Healing', type: 'consumable', system: { quantity }, ...extra });

before(async () => {
  await new Promise((r) => mock.server.listen(0, r));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const main = await import('../scripts/main.js');
  F.Hooks.call('init');
  F.set('ddb-sync', 'characterMapping', { 111: 'pc1', 222: 'pc2' });
  F.set('ddb-sync', 'proxyUrl', url);
  F.set('ddb-sync', 'cobaltCookie', 'COBALT');
  F.set('ddb-sync', 'campaignId', '999');
  F.set(MODULE_ID, 'enabled', true);
  F.set(MODULE_ID, 'dryRun', false);
  F.set(MODULE_ID, 'partyActorId', 'party');
  F.addActor({ id: 'pc1', name: 'Ireena', currency: { gp: 10 } });
  F.addActor({ id: 'pc2', name: 'Ismark', currency: { gp: 10 } });
  F.addActor({ id: 'party', name: 'Party Stash' });
  F.addActor({ id: 'merchant', name: 'Bildrath', currency: { gp: 500 } });
  F.Hooks.call('ready');
  await main.ready;
  api = game.modules.get(MODULE_ID).api;
});

after(() => mock.server.close());

beforeEach(async () => {
  await api.idle();
  mock.reset();
  mock.addCharacter(111, 'Ireena');
  mock.addCharacter(222, 'Ismark');
  F.set(MODULE_ID, 'dryRun', false);
  F.set(MODULE_ID, 'currencyMode', 'delta');
  api.resume();
  for (const id of ['pc1', 'pc2', 'party']) {
    const a = game.actors.get(id);
    for (const item of [...a.items]) await item.delete({ [MODULE_ID]: { skip: true } });
    await a.update({ system: { currency: { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 } } }, { [MODULE_ID]: { skip: true } });
  }
  ddb(111).currencies.gp = 10;
  ddb(222).currencies.gp = 10;
  F.notes.length = 0;
  F.chat.length = 0;
});

test('merchant purchase: potion arrives, gold leaves, then the stack grows and is sold', async () => {
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(1));
  await pc.update({ system: { currency: { gp: 5 } } }); // paid 5 gp
  await settle();
  assert.equal(ddb().inventory.length, 1);
  assert.equal(ddb().inventory[0].name, 'Potion of Healing');
  assert.equal(ddb().inventory[0].definitionId, 2, 'the current printing, not the legacy one');
  assert.equal(ddb().currencies.gp, 5);
  assert.equal(item.getFlag(MODULE_ID, 'ddbId'), ddb().inventory[0].id);

  await item.update({ system: { quantity: 3 } });
  await settle();
  assert.equal(ddb().inventory[0].quantity, 3);

  await item.delete();
  await settle();
  assert.equal(ddb().inventory.length, 0);
});

test('stack changed before its add went out: one add with the final stack', async () => {
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(1));
  await item.update({ system: { quantity: 4 } });
  await settle();
  assert.equal(ddb().inventory.length, 1);
  assert.equal(ddb().inventory[0].quantity, 4);
  assert.equal(writes().filter((c) => c.op === 'add').length, 1);
});

test('created and removed at once: nothing reaches D&D Beyond, an existing stack is untouched', async () => {
  ddb().inventory.push({ id: 1, definitionId: 2, name: 'Potion of Healing', quantity: 2, entityTypeId: 1439493548 });
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(1));
  await item.delete();
  await settle();
  assert.equal(writes().length, 0);
  assert.equal(ddb().inventory[0].quantity, 2);
});

test('a player used a potion on the D&D Beyond sheet: Foundry buying one more keeps that', async () => {
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(2));
  await settle();
  const rowId = ddb().inventory[0].id;
  await fetch(`http://127.0.0.1:${mock.server.address().port}/mock/edit`, { method: 'POST', body: JSON.stringify({ characterId: 111, rowId, quantity: 1 }) });
  await item.update({ system: { quantity: 3 } }); // Foundry: 2 -> 3
  await settle();
  assert.equal(ddb().inventory[0].quantity, 2, '1 on D&D Beyond + 1 bought');
});

test('coins: delta keeps gold spent on D&D Beyond; absolute mode overwrites', async () => {
  const pc = game.actors.get('pc1');
  ddb().currencies.gp = 4; // spent 6 on the D&D Beyond sheet
  await pc.update({ system: { currency: { gp: 7 } } }); // Foundry 10 -> 7
  await settle();
  assert.equal(ddb().currencies.gp, 1);

  F.set(MODULE_ID, 'currencyMode', 'absolute');
  await pc.update({ system: { currency: { gp: 6 } } });
  await settle();
  assert.equal(ddb().currencies.gp, 6);
});

test('several quick coin changes fold into one write per lane', async () => {
  const pc = game.actors.get('pc1');
  const gate = mock.state.config;
  gate.latencyMs = 150;
  await pc.createItem(potion(1)); // occupies the lane
  await new Promise((r) => setTimeout(r, 330));
  for (const gp of [9, 8, 7]) await pc.update({ system: { currency: { gp } } });
  gate.latencyMs = 0;
  await settle();
  assert.equal(ddb().currencies.gp, 7);
  assert.ok(writes().filter((c) => c.op === 'currency').length <= 2);
});

test('DDB Importer rebuild: a burst of deletes and creates of imported items is not sent', async () => {
  const pc = game.actors.get('pc1');
  const imported = [];
  for (let i = 0; i < 12; i++) imported.push(await pc.createItem(potion(1, { flags: { ddbimporter: { id: 500 + i } } }), { [MODULE_ID]: { skip: true } }));
  for (const item of imported) await item.delete();
  for (let i = 0; i < 12; i++) await pc.createItem(potion(1, { flags: { ddbimporter: { id: 600 + i } } }));
  await settle();
  assert.equal(writes().length, 0);
  assert.ok(api.log.some((e) => /looks like a character import/.test(e.message)));
});

test('an import updating many fields is not sent back, and the next real change has the right delta', async () => {
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(2));
  await settle();
  await item.update({ system: { quantity: 5, description: { value: 'from D&D Beyond' } } }); // import
  await pc.update({ system: { currency: { gp: 50 }, attributes: { hp: { value: 3 } } } }); // import
  await settle();
  assert.equal(ddb().inventory[0].quantity, 2);
  assert.equal(ddb().currencies.gp, 10);
  await item.update({ system: { quantity: 6 } }); // a real +1
  await settle();
  assert.equal(ddb().inventory[0].quantity, 3);
});

test('a loot pile take of many plain items is still sent (not mistaken for an import)', async () => {
  const pc = game.actors.get('pc1');
  const names = ['Torch', 'Dagger', 'Rations (1 day)', 'Rope, Hempen (50 feet)', "Healer's Kit", 'Longsword', 'Chain Mail', 'Bonegrinder Bell', 'Odd Coin', 'Bone Flute'];
  for (const name of names) await pc.createItem({ name, type: 'loot', system: { quantity: 1 } });
  await settle();
  assert.deepEqual(ddb().inventory.map((r) => r.name).sort(), [...names].sort(), 'every item, each once');
});

test('trade between two synced PCs: the copy gets its own row, the source row goes', async () => {
  const a = game.actors.get('pc1');
  const b = game.actors.get('pc2');
  const given = await a.createItem({ name: 'Dagger', type: 'weapon', system: { quantity: 1 } });
  await settle();
  const copy = await b.createItem(given.toObject()); // carries A's row id flag
  await given.delete();
  await settle();
  assert.equal(ddb(111).inventory.length, 0);
  assert.equal(ddb(222).inventory.length, 1);
  assert.notEqual(copy.getFlag(MODULE_ID, 'ddbId'), given.getFlag(MODULE_ID, 'ddbId'));
});

test('party loot: real item and custom item to the party inventory, party coins absolute', async () => {
  const stash = game.actors.get('party');
  await stash.createItem({ name: 'Rope, Hempen (50 feet)', type: 'loot', system: { quantity: 1 } });
  await stash.createItem({ name: 'Strahd’s Letter', type: 'loot', system: { quantity: 1 } });
  await stash.update({ system: { currency: { gp: 30 } } });
  await settle();
  assert.deepEqual(party().inventory.map((r) => [r.name, r.custom]), [['Rope, Hempen (50 feet)', false], ['Strahd’s Letter', true]]);
  assert.equal(party().currencies.gp, 30);
  assert.equal(ddb(111).inventory.length, 0, 'not on the carrier character');
});

test('ignored: merchant, unlinked token copy, spells, skip option, another GM client, pause', async () => {
  await game.actors.get('merchant').createItem(potion(1));
  const token = new F.Actor({ id: 'pc1', name: 'Ireena (token)', isToken: true, actorLink: false }); // synthetic, same id
  await token.createItem(potion(1));
  const pc = game.actors.get('pc1');
  await pc.createItem({ name: 'Fireball', type: 'spell', system: {} });
  await pc.createItem(potion(1), { [MODULE_ID]: { skip: true } });
  game.users.activeGM.isSelf = false;
  await pc.update({ system: { currency: { gp: 1 } } });
  game.users.activeGM.isSelf = true;
  api.pause();
  await pc.createItem(potion(1));
  api.resume();
  await settle();
  assert.deepEqual(writes(), []);
});

test('dry run reads but never writes', async () => {
  F.set(MODULE_ID, 'dryRun', true);
  const pc = game.actors.get('pc1');
  await pc.createItem(potion(1));
  await pc.update({ system: { currency: { gp: 2 } } });
  await settle();
  assert.deepEqual(writes(), []);
  assert.ok(api.log.some((e) => /\[dry-run\] add/.test(e.message)));
});

test('D&D Beyond busy (503): retried and delivered', async () => {
  mock.state.failures.push({ status: 503, count: 1, op: 'add' });
  await game.actors.get('pc1').createItem(potion(1));
  await new Promise((r) => setTimeout(r, 1500)); // one backoff
  await settle();
  assert.equal(ddb().inventory.length, 1);
  assert.equal(api.failed.length, 0);
});

test('rejected write: reported, kept, delivered by retryFailed', async () => {
  mock.state.failures.push({ status: 400, count: 1, op: 'add' });
  await game.actors.get('pc1').createItem(potion(1));
  await settle();
  assert.equal(ddb().inventory.length, 0);
  assert.equal(api.failed.length, 1);
  assert.ok(F.notes.some(([level, m]) => level === 'error' && /failed/.test(m)));
  api.retryFailed();
  await settle();
  assert.equal(ddb().inventory.length, 1);
});

test('items list unavailable: the add fails instead of becoming a custom item, and retries cleanly', async () => {
  api.reloadItems();
  const url = game.settings.get('ddb-sync', 'proxyUrl');
  game.settings.set('ddb-sync', 'proxyUrl', 'http://127.0.0.1:1'); // proxy down
  await game.actors.get('pc1').createItem(potion(1));
  await new Promise((r) => setTimeout(r, 400));
  await api.idle();
  await game.settings.set('ddb-sync', 'proxyUrl', url);
  assert.equal(api.failed.length, 1);
  api.retryFailed();
  await settle();
  assert.equal(ddb().inventory[0].custom, false);
});

test('equip and attune follow on characters', async () => {
  const pc = game.actors.get('pc1');
  const sword = await pc.createItem({ name: 'Longsword', type: 'weapon', system: { quantity: 1 } });
  await settle();
  await sword.update({ system: { equipped: true } });
  await sword.update({ system: { attuned: true } });
  await settle();
  assert.equal(ddb().inventory[0].equipped, true);
  assert.equal(ddb().inventory[0].isAttuned, true);
});

test('link pairs existing items with their rows', async () => {
  ddb().inventory.push({ id: 1, definitionId: 2, name: 'Potion of Healing', quantity: 2, entityTypeId: 1439493548 });
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(2), { [MODULE_ID]: { skip: true } });
  const result = await api.link(pc);
  assert.deepEqual(result.links, [{ uuid: item.uuid, ddbId: 1 }]);
  assert.equal(item.getFlag(MODULE_ID, 'ddbId'), 1);
});

test('diagnose reports no failures against the mock', async () => {
  const report = await api.diagnose();
  const fails = report.filter((r) => r.status === 'fail');
  assert.deepEqual(fails, []);
  assert.match(F.chat.at(-1).content, /diagnostics/);
});

test('self-test passes against a well-behaved D&D Beyond and leaves nothing behind', async () => {
  const report = await api.selfTest(game.actors.get('pc1'));
  assert.deepEqual(report.filter((r) => r.status === 'fail'), []);
  assert.equal(ddb().inventory.length, 0);
  assert.equal(ddb().currencies.gp, 10);
  assert.equal(party().inventory.length, 0);
});

test('self-test catches a currency call that adds instead of setting', async () => {
  mock.state.config.currencyIsDelta = true;
  const report = await api.selfTest(game.actors.get('pc1'), { chat: false });
  const coins = report.find((r) => r.name.startsWith('Coins'));
  assert.equal(coins.status, 'fail');
  assert.match(coins.detail, /ADDS instead of setting/);
  assert.match(coins.detail, /Purse restored/);
  assert.equal(ddb().currencies.gp, 10, 'the opposite call put the gold back');
  assert.equal(ddb().currencies.cp, 0);
});

test('D&D Beyond answers an add without row ids: the row is found by reading', async () => {
  mock.state.config.dropRowIds = true;
  const pc = game.actors.get('pc1');
  const item = await pc.createItem(potion(1));
  await settle();
  assert.equal(item.getFlag(MODULE_ID, 'ddbId'), ddb().inventory[0].id);
  await item.update({ system: { quantity: 2 } });
  await settle();
  assert.equal(ddb().inventory[0].quantity, 2);
  const report = await api.selfTest(pc, { chat: false });
  assert.deepEqual(report.filter((r) => r.status === 'fail').map((r) => r.name), ['Party inventory: add and remove'], 'only the party step cannot read its row back');
});

test('the mock status page and state endpoint answer', async () => {
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  assert.match(await (await fetch(`${base}/`)).text(), /Mock D&amp;D Beyond/);
  assert.ok(Array.isArray((await (await fetch(`${base}/mock/state`)).json()).characters));
  const pre = await fetch(`${base}/proxy/inventory`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});
