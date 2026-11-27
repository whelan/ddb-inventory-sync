/**
 * Hot reload: the bootstrap swaps the runtime for a fresh esbuild bundle
 * without a page reload, the old hooks go, and the Dev macro drives it all
 * the way foundry-mcp-bridge's run_macro would.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installFoundry } from './foundry-fake.js';
import { createMockProxy } from '../tools/mock-proxy.js';

const MODULE_ID = 'ddb-inventory-sync';
const F = installFoundry();
const mock = createMockProxy({ characters: [{ id: 111, name: 'Ireena' }] });
const dir = mkdtempSync(join(tmpdir(), 'ddb-dev-'));
const bundlePath = join(dir, 'runtime.mjs');
let main;

/** Build the runtime like `npm run dev` does, optionally patching a source line. */
async function buildBundle(patch = (code) => code, build = 'test-build') {
  const result = await esbuild.build({ entryPoints: ['scripts/runtime.js'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  writeFileSync(bundlePath, `${patch(result.outputFiles[0].text)}\nexport const BUILD = ${JSON.stringify(build)};\n`);
}

const devMacro = async (args) => {
  const macro = game.macros.find((m) => m.name === 'DDB Inventory Sync: Dev');
  return JSON.parse(JSON.stringify(await macro.execute({ ...args })));
};
const settle = async () => {
  await new Promise((r) => setTimeout(r, 360));
  await game.modules.get(MODULE_ID).api.idle();
};
const adds = () => mock.state.calls.filter((c) => c.op === 'add').length;

before(async () => {
  await new Promise((r) => mock.server.listen(0, r));
  main = await import('../scripts/main.js');
  F.Hooks.call('init');
  F.set('ddb-sync', 'characterMapping', { 111: 'pc1' });
  F.set('ddb-sync', 'proxyUrl', `http://127.0.0.1:${mock.server.address().port}`);
  F.set('ddb-sync', 'cobaltCookie', 'COBALT');
  F.set('ddb-sync', 'campaignId', '999');
  F.set(MODULE_ID, 'enabled', true);
  F.set(MODULE_ID, 'dryRun', false);
  F.addActor({ id: 'pc1', name: 'Ireena', currency: { gp: 10 } });
  F.Hooks.call('ready');
  await main.ready;
});

after(() => mock.server.close());

test('the Dev macro exists and reports status', async () => {
  const s = await devMacro({ action: 'status' });
  assert.equal(s.ok, true);
  assert.equal(s.runtime.source, 'file');
  assert.equal(s.synced[0].target.characterId, 111);
  assert.equal(s.ddbSync.hasCobalt, true);
});

test('configure sets module and ddb-sync settings, maps by actor name, refuses cookies', async () => {
  F.addActor({ id: 'pc9', name: 'Test Hero' });
  const r = await devMacro({ action: 'configure', module: { currencyMode: 'absolute' }, ddbSync: { campaignId: '4242', mapping: { 555: 'Test Hero' } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(game.settings.get(MODULE_ID, 'currencyMode'), 'absolute');
  assert.equal(game.settings.get('ddb-sync', 'campaignId'), '4242');
  assert.equal(game.settings.get('ddb-sync', 'characterMapping')[555], 'pc9');
  const bad = await devMacro({ action: 'configure', module: { cobalt: 'real-cookie' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /entered by Lars/);
  assert.equal((await devMacro({ action: 'configure', module: { cobalt: 'MOCK' } })).ok, true);
  await devMacro({ action: 'configure', module: { cobalt: '' } });
  assert.match((await devMacro({ action: 'configure', module: { nope: 1 } })).error, /cannot be set here/);
  await devMacro({ action: 'configure', module: { currencyMode: 'delta' }, ddbSync: { campaignId: '999', mapping: { 555: null } } });
});

test('hot reload: switching to the dev bundle replaces the runtime, hooks are not doubled', async () => {
  await buildBundle(undefined, 'build-1');
  const r = await devMacro({ action: 'configure', module: { devRuntimeUrl: pathToFileURL(bundlePath).href } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.runtime.source, 'dev');
  assert.equal(r.runtime.build, 'build-1');

  const before = adds();
  await game.actors.get('pc1').createItem({ name: 'Potion of Healing', type: 'consumable', system: { quantity: 1 } });
  await settle();
  assert.equal(adds() - before, 1, 'one add, not one per loaded runtime');
});

test('hot reload picks up a code change without a page reload', async () => {
  await buildBundle((code) => code.replace('`${reloaded ? "Reloaded"', '`PATCHED ${reloaded ? "Reloaded"'), 'build-2');
  const r = await devMacro({ action: 'reload' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reloaded.build, 'build-2');
  const log = await devMacro({ action: 'log', lines: 5 });
  assert.ok(log.log.some((e) => e.message.startsWith('PATCHED Reloaded')));
  const before = adds();
  await game.actors.get('pc1').createItem({ name: 'Dagger', type: 'weapon', system: { quantity: 1 } });
  await settle();
  assert.equal(adds() - before, 1);
});

test('a broken build is refused and the running runtime keeps going', async () => {
  writeFileSync(bundlePath, 'export const start = (;\n');
  const r = await devMacro({ action: 'reload' });
  assert.equal(r.ok, false);
  const s = await devMacro({ action: 'status' });
  assert.equal(s.runtime.build, 'build-2', 'still the last good build');
  const before = adds();
  await game.actors.get('pc1').createItem({ name: 'Torch', type: 'consumable', system: { quantity: 1 } });
  await settle();
  assert.equal(adds() - before, 1);
});

test('selfTest and scenarios run through the Dev macro', async () => {
  const pc = game.actors.get('pc1');
  for (const item of [...pc.items]) await item.delete(); // earlier tests left items (the runner refuses leftovers)
  await settle();
  const st = await devMacro({ action: 'selfTest', actor: 'Ireena', chat: false });
  assert.equal(st.ok, true, JSON.stringify(st.report));
  const sc = await devMacro({ action: 'scenarios', actor: 'Ireena', only: ['loot'], chat: false });
  assert.equal(sc.ok, true, JSON.stringify(sc.steps));
});

test('diagnose, log and failed answer through the macro', async () => {
  const d = await devMacro({ action: 'diagnose' });
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.report));
  assert.ok(Array.isArray((await devMacro({ action: 'failed' })).failed));
  assert.equal((await devMacro({ action: 'nope' })).ok, false);
  assert.ok(readFileSync(bundlePath, 'utf8').length > 0);
});
