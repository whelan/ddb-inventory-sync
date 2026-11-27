/**
 * The scenario runner end to end: the test macro (as foundry-mcp-bridge's
 * run_macro would run it) -> api.runScenarios -> fake Item Piles -> the
 * module's hooks -> tools/mock-proxy.js over HTTP.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installFoundry } from './foundry-fake.js';
import { createMockProxy } from '../tools/mock-proxy.js';

const MODULE_ID = 'ddb-inventory-sync';
const F = installFoundry();
const mock = createMockProxy({ characters: [{ id: 111, name: 'Ireena' }, { id: 222, name: 'Ismark' }] });
let url;
let api;

/** What foundry-mcp-bridge's runMacro does: find by name, execute(args), JSON round trip. */
async function runMacroLikeTheBridge(name, args) {
  const macro = game.macros.find((m) => m.name === name);
  assert.ok(macro, `macro "${name}" exists`);
  const returned = await macro.execute({ ...args });
  return JSON.parse(JSON.stringify(returned ?? null));
}

before(async () => {
  await new Promise((r) => mock.server.listen(0, r));
  url = `http://127.0.0.1:${mock.server.address().port}`;
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
  F.installItemPiles();
  F.Hooks.call('ready');
  await main.ready;
  api = game.modules.get(MODULE_ID).api;
  await new Promise((r) => setTimeout(r, 20)); // ensureTestMacro
});

after(() => mock.server.close());

beforeEach(() => {
  mock.state.config.currencyIsDelta = false;
  F.set(MODULE_ID, 'dryRun', false);
  game.modules.get('item-piles').active = true;
});

const failures = (report) => report.steps.filter((s) => s.status === 'fail');

test('the module installs the test macro', () => {
  const macro = game.macros.find((m) => m.name === 'DDB Inventory Sync: Test');
  assert.equal(macro.type, 'script');
  assert.match(macro.command, /api\.runScenarios/);
});

test('every Item Piles scenario passes and D&D Beyond is back where it was', async () => {
  const before = JSON.stringify({ inv: mock.state.characters.get(111).inventory, cur: mock.state.characters.get(111).currencies });
  const report = await runMacroLikeTheBridge('DDB Inventory Sync: Test', { actor: 'Ireena' });
  assert.deepEqual(failures(report), [], JSON.stringify(report.steps, null, 1));
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'mock');
  const names = report.steps.map((s) => s.name);
  for (const expected of ['Merchant: buy a Potion of Healing', 'Merchant: sell one back', 'Loot pile: take everything (torches + a custom item)', 'Give the Dagger to Ismark', 'Party inventory on D&D Beyond', 'Player edits on D&D Beyond, then buys in Foundry', 'Cleanup: D&D Beyond back to where it was']) {
    assert.ok(names.includes(expected), `ran "${expected}"`);
  }
  assert.equal(JSON.stringify({ inv: mock.state.characters.get(111).inventory, cur: mock.state.characters.get(111).currencies }), before);
  assert.equal(game.actors.find((a) => a.name === 'DDB Sync Test Merchant'), undefined, 'fixtures deleted');
  assert.match(F.chat.at(-1).content, /scenarios \(mock\)/);
});

test('without Item Piles the same scenarios run on plain Foundry operations', async () => {
  game.modules.get('item-piles').active = false;
  const report = await api.runScenarios({ actor: 'Ireena', chat: false });
  assert.deepEqual(failures(report), [], JSON.stringify(report.steps, null, 1));
  assert.match(report.steps[0].detail, /NO Item Piles/);
});

test('only: runs a subset', async () => {
  const report = await api.runScenarios({ actor: 'Ireena', only: ['loot'], chat: false });
  assert.equal(report.ok, true);
  assert.ok(!report.steps.some((s) => s.name.startsWith('Merchant')));
  assert.ok(report.steps.some((s) => s.name.startsWith('Loot pile')));
});

test('a sync fault shows up as a failed step (mock currency call that adds)', async () => {
  mock.state.config.currencyIsDelta = true;
  const report = await api.runScenarios({ actor: 'Ireena', only: ['buy'], chat: false });
  mock.state.config.currencyIsDelta = false;
  assert.equal(report.ok, false);
  assert.ok(failures(report).some((s) => /coins moved differently/.test(s.detail)));
  // repair the mock for the next tests
  mock.state.characters.get(111).currencies = { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 };
});

test('refuses: dry run on, leftovers on the character', async () => {
  F.set(MODULE_ID, 'dryRun', true);
  let report = await api.runScenarios({ actor: 'Ireena', chat: false });
  assert.match(failures(report)[0].detail, /dry run is on/);
  F.set(MODULE_ID, 'dryRun', false);

  const pc = game.actors.get('pc1');
  const leftover = await pc.createItem({ name: 'Torch', type: 'consumable', system: { quantity: 1 } }, { [MODULE_ID]: { skip: true } });
  report = await api.runScenarios({ actor: 'Ireena', chat: false });
  assert.match(failures(report)[0].detail, /already carries Torch/);
  await leftover.delete({ [MODULE_ID]: { skip: true } });
});

test('refuses a real proxy unless live: true and an actor are given', async () => {
  const real = http.createServer((req, res) => {
    res.writeHead(req.url === '/ping' ? 200 : 404, { 'Access-Control-Allow-Origin': '*' });
    res.end(req.url === '/ping' ? 'pong' : '{}');
  });
  await new Promise((r) => real.listen(0, r));
  const report = await api.runScenarios({ chat: false, configure: { proxyUrl: `http://127.0.0.1:${real.address().port}` } });
  real.close();
  await game.settings.set(MODULE_ID, 'proxyUrl', '');
  assert.equal(report.ok, false);
  assert.match(failures(report)[0].detail, /live: true/);
});

test('configure sets the module settings first (what a local Claude needs)', async () => {
  await api.runScenarios({ actor: 'Ireena', only: [], chat: false, configure: { currencyMode: 'absolute' } });
  assert.equal(game.settings.get(MODULE_ID, 'currencyMode'), 'absolute');
  await game.settings.set(MODULE_ID, 'currencyMode', 'delta');
});
