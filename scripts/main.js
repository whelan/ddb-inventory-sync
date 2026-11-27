/**
 * DDB Inventory Sync — bootstrap.
 *
 * Kept deliberately small and stable: it registers the settings and menus on
 * init and loads the runtime on ready. Everything else lives in runtime.js,
 * which can be swapped while Foundry keeps running:
 *
 *  - normally the runtime is ./runtime.js;
 *  - with the client setting "Dev runtime URL" (e.g. http://localhost:3997/runtime.js
 *    from `npm run dev`) it is loaded from the local dev server instead, and
 *    `reload` fetches a fresh build and replaces the running runtime in place —
 *    in a local world and on The Forge alike.
 *
 * The world macro "DDB Inventory Sync: Dev" exposes this to a local Claude
 * through foundry-mcp-bridge's run_macro (status, reload, reloadPage,
 * configure, diagnose, log, failed, retryFailed).
 */
import { MODULE_ID } from './core/constants.js';
import { registerSettings, setting } from './settings.js';

const DEV_MACRO = 'DDB Inventory Sync: Dev';
const DEV_MACRO_BODY = `// Dev control for DDB Inventory Sync, for a local Claude via foundry-mcp-bridge run_macro.
// args: { action: "status" | "reload" | "reloadPage" | "configure" | "diagnose" | "selfTest" | "scenarios" | "log" | "failed" | "retryFailed", ... }
// selfTest: { actor, party }   scenarios: same args as the "DDB Inventory Sync: Test" macro
// configure: { module: { proxyUrl, enabled, dryRun, currencyMode, verifyWrites, partyActorId, partyCampaignId, partyCarrierCharacterId, devRuntimeUrl },
//              ddbSync: { proxyUrl, campaignId, mapping: { "<ddbCharacterId>": "<actor name or id>" } } }
// module.cobalt accepts only "MOCK" (for the mock) or "" — real cookies are entered by Lars.
return await game.modules.get('ddb-inventory-sync').dev(scope ?? {});
`;

let current = null; // { api, stop }
let loaded = null; // { source, at, url }
let readyResolve;
/** Resolves once the first runtime is running (tests await it). */
export const ready = new Promise((r) => (readyResolve = r));

const moduleEntry = () => game.modules.get(MODULE_ID);

/** Settings-menu launchers (Foundry calls `new type().render(true)`). */
class DiagnosticsMenu {
  render() {
    moduleEntry()
      .api?.diagnose()
      .catch((err) => ui.notifications.error(`Diagnostics failed: ${err.message}`));
    ui.notifications.info('DDB Inventory Sync: diagnostics sent to chat (GM whisper).');
  }
}

class SelfTestMenu {
  async render() {
    const api = moduleEntry().api;
    const actors = game.actors.filter((a) => api?.targetFor(a)?.kind === 'character');
    if (!actors.length) return ui.notifications.warn('No synced characters to test on.');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const options = actors.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    const actorId = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'D&D Beyond live self-test' },
      content: `<p>Writes to the chosen character on D&amp;D Beyond (a test item, one copper, a test custom item, and the party inventory) and removes it all again. Use a test character.</p>
        <label>Character <select name="actor">${options}</select></label>`,
      ok: { label: 'Run', callback: (event, button) => button.form.elements.actor.value }
    }).catch(() => null);
    if (!actorId) return;
    ui.notifications.info('DDB Inventory Sync: self-test running…');
    api.selfTest(game.actors.get(actorId)).catch((err) => ui.notifications.error(`Self-test failed: ${err.message}`));
  }
}

const MENUS = { DiagnosticsMenu, SelfTestMenu };

async function importRuntime() {
  const devUrl = setting('devRuntimeUrl');
  if (devUrl) {
    const url = `${devUrl}${devUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    return { mod: await import(url), source: 'dev', url: devUrl };
  }
  return { mod: await import('./runtime.js'), source: 'file', url: null };
}

async function load({ reloaded = false } = {}) {
  // Import first: a build that does not load leaves the running runtime alone.
  const { mod, source, url } = await importRuntime();
  if (current) await current.stop();
  current = await mod.start({ menus: MENUS, reloaded });
  loaded = { source, url, at: new Date().toISOString(), build: mod.BUILD ?? null };
  moduleEntry().api = current.api;
  return loaded;
}

async function ensureDevMacro() {
  if (!game.user.isGM || !setting('provideTestMacro')) return;
  const existing = game.macros.find((m) => m.name === DEV_MACRO);
  if (existing) {
    if (existing.command !== DEV_MACRO_BODY) await existing.update({ command: DEV_MACRO_BODY });
  } else {
    await Macro.create({ name: DEV_MACRO, type: 'script', command: DEV_MACRO_BODY, img: 'icons/svg/gear.svg' });
  }
}

const MODULE_SETTINGS = ['proxyUrl', 'enabled', 'dryRun', 'currencyMode', 'verifyWrites', 'partyActorId', 'partyCampaignId', 'partyCarrierCharacterId', 'unmatched', 'syncCurrency', 'syncEquipped', 'devRuntimeUrl', 'debug'];

/** Apply settings for a test run. Cookies are never set this way: Lars enters them. */
async function configure({ module = {}, ddbSync = {} } = {}) {
  const changed = [];
  for (const [key, value] of Object.entries(module)) {
    if (key === 'cobalt') {
      if (value !== 'MOCK' && value !== '') throw new Error('configure.module.cobalt: only "MOCK" or "" — real cookies are entered by Lars in the settings');
      await game.settings.set(MODULE_ID, key, value);
      changed.push(`${MODULE_ID}.cobalt`);
      continue;
    }
    if (!MODULE_SETTINGS.includes(key)) throw new Error(`configure.module: "${key}" cannot be set here`);
    await game.settings.set(MODULE_ID, key, value);
    changed.push(`${MODULE_ID}.${key}`);
  }
  if (Object.keys(ddbSync).length && !game.modules.get('ddb-sync')?.active) throw new Error('configure.ddbSync: ddb-sync is not active');
  for (const key of ['proxyUrl', 'campaignId']) {
    if (ddbSync[key] === undefined) continue;
    await game.settings.set('ddb-sync', key, ddbSync[key]);
    changed.push(`ddb-sync.${key}`);
  }
  if (ddbSync.mapping) {
    const mapping = { ...(game.settings.get('ddb-sync', 'characterMapping') ?? {}) };
    for (const [ddbId, who] of Object.entries(ddbSync.mapping)) {
      if (who === null) {
        delete mapping[ddbId];
        continue;
      }
      const actor = game.actors.get(who) ?? game.actors.getName(who);
      if (!actor) throw new Error(`configure.ddbSync.mapping: no actor "${who}"`);
      for (const [k, v] of Object.entries(mapping)) if (v === actor.id && k !== ddbId) delete mapping[k];
      mapping[ddbId] = actor.id;
    }
    await game.settings.set('ddb-sync', 'characterMapping', mapping);
    changed.push('ddb-sync.characterMapping');
  }
  return changed;
}

function status() {
  const api = moduleEntry().api;
  const get = (mod, key) => {
    try {
      return game.settings.get(mod, key);
    } catch {
      return undefined;
    }
  };
  return {
    version: moduleEntry().version ?? null,
    runtime: loaded,
    activeGM: !!game.users.activeGM?.isSelf,
    foundry: game.version ?? null,
    system: game.system ? `${game.system.id} ${game.system.version}` : null,
    modules: Object.fromEntries(['item-piles', 'ddb-sync', 'ddb-importer'].map((id) => [id, game.modules.get(id)?.active ? game.modules.get(id).version ?? true : false])),
    settings: Object.fromEntries(MODULE_SETTINGS.map((k) => [k, get(MODULE_ID, k)])),
    ddbSync: {
      proxyUrl: get('ddb-sync', 'proxyUrl') ?? null,
      campaignId: get('ddb-sync', 'campaignId') ?? null,
      mapping: get('ddb-sync', 'characterMapping') ?? null,
      hasCobalt: !!get('ddb-sync', 'cobaltCookie')
    },
    hasOwnCobalt: !!get(MODULE_ID, 'cobalt'),
    synced: game.actors
      .map((a) => ({ name: a.name, id: a.id, target: api?.targetFor(a) ?? null }))
      .filter((a) => a.target),
    pending: api?.pending ?? null,
    failed: api?.failed?.length ?? null,
    paused: api?.paused ?? null
  };
}

/** The Dev macro's entry point. Returns plain JSON. */
async function dev(args = {}) {
  if (!game.user.isGM) return { ok: false, error: 'GM only' };
  const api = () => moduleEntry().api;
  try {
    switch (args.action ?? 'status') {
      case 'status':
        return { ok: true, ...status() };
      case 'reload':
        return { ok: true, reloaded: await load({ reloaded: true }), ...status() };
      case 'reloadPage':
        setTimeout(() => window.location.reload(), 500);
        return { ok: true, reloading: true };
      case 'configure': {
        const changed = await configure(args);
        if (args.module?.devRuntimeUrl !== undefined || args.reload) await load({ reloaded: true });
        return { ok: true, changed, ...status() };
      }
      case 'diagnose':
        return { ok: true, report: await api().diagnose({ chat: args.chat ?? false }) };
      case 'selfTest': {
        const actor = game.actors.get(args.actor) ?? game.actors.getName(args.actor);
        if (!actor) return { ok: false, error: `no actor "${args.actor}"` };
        const report = await api().selfTest(actor, { party: args.party ?? true, chat: args.chat ?? true });
        return { ok: !report.some((r) => r.status === 'fail'), report };
      }
      case 'scenarios':
        return await api().runScenarios({ ...args, action: undefined });
      case 'log':
        return { ok: true, log: api().log.slice(-(args.lines ?? 60)) };
      case 'failed':
        return { ok: true, failed: api().failed };
      case 'retryFailed':
        return { ok: true, retried: api().retryFailed() };
      default:
        return { ok: false, error: `unknown action "${args.action}"` };
    }
  } catch (err) {
    return { ok: false, error: err.message, stack: String(err.stack ?? '').split('\n').slice(0, 6) };
  }
}

Hooks.once('init', () => {
  registerSettings(MENUS);
  moduleEntry().dev = dev;
});

Hooks.once('ready', async () => {
  try {
    await load();
  } catch (err) {
    console.error(`${MODULE_ID} | runtime failed to load`, err);
    if (setting('devRuntimeUrl')) {
      ui.notifications.error(`DDB Inventory Sync: dev runtime failed to load (${err.message}). Is "npm run dev" running? Falling back to the installed code.`);
      try {
        const mod = await import('./runtime.js');
        current = await mod.start({ menus: MENUS });
        loaded = { source: 'file (dev fallback)', url: null, at: new Date().toISOString(), build: null };
        moduleEntry().api = current.api;
      } catch (inner) {
        console.error(`${MODULE_ID} | installed runtime failed too`, inner);
      }
    }
  }
  await ensureDevMacro().catch((err) => console.warn(`${MODULE_ID} | dev macro: ${err.message}`));
  readyResolve();
});
