/**
 * DDB Inventory Sync — runtime (everything but the bootstrap in main.js).
 *
 * Loaded by main.js on ready, either from this file or, in dev mode, as a
 * bundle from the local dev server, and re-loadable in place: start()
 * registers every hook through `on()` and the returned stop() removes them,
 * so a new build can replace the running one without reloading Foundry.
 * Each load is a fresh module instance with its own queue and snapshots;
 * row ids live in item flags and survive.
 *
 *
 * Listens to core document hooks rather than Item Piles' own hooks: a
 * merchant purchase, a loot pile "take", a trade and a GM drag all end as
 * createItem / updateItem / deleteItem / updateActor on the receiving actor,
 * so one listener covers Item Piles, other merchant sheets and manual edits.
 * Only the active GM client acts, so each change is sent once.
 *
 * The GM client keeps a snapshot of every synced item's quantity and every
 * synced actor's coins, so it knows the delta of a change even when a player
 * client made it (preUpdate hooks run only on the client that changes).
 */
import { MODULE_ID, SKIP_OPTION } from './core/constants.js';
import { buildIndex, matchDefinition } from './core/matcher.js';
import {
  coalesceKey,
  mergeOps,
  isForeignCurrencyUpdate,
  isForeignItemUpdate,
  isPhysical,
  planCreate,
  planCurrency,
  planDelete,
  planUpdate,
  quantityOf
} from './core/planner.js';
import { SyncQueue } from './core/queue.js';
import { SyncEngine } from './core/engine.js';
import { invertMapping, resolveTarget } from './core/targets.js';
import { ProxyClient } from './core/client.js';
import { linkRows, looksLikeImport } from './core/linker.js';
import { runDiagnostics, runSelfTest, renderReport } from './core/selftest.js';
import { runScenarios } from './core/scenarios.js';
import { registerSettings, setting, foreignSetting } from './settings.js';

const LOG_SIZE = 300;
const BATCH_MS = 300;
const syncLog = [];

function log(level, message, op) {
  const entry = { at: new Date().toISOString(), level, message, characterId: op?.characterId ?? null };
  syncLog.push(entry);
  if (syncLog.length > LOG_SIZE) syncLog.shift();
  if (level === 'debug' && !setting('debug')) return;
  (console[level] ?? console.log)(`${MODULE_ID} | ${message}`);
}

let paused = false;
const isActiveGM = () => !!game.users.activeGM?.isSelf;
const enabled = () => setting('enabled') && isActiveGM() && !paused;
const skipped = (options) => !!options?.[SKIP_OPTION]?.skip;

function partyConfig() {
  return {
    actorId: setting('partyActorId') || null,
    campaignId: setting('partyCampaignId') || foreignSetting('ddb-sync', 'campaignId') || null,
    carrierCharacterId: setting('partyCarrierCharacterId') || null
  };
}

function actorToDdb() {
  return invertMapping(foreignSetting('ddb-sync', 'characterMapping'));
}

function targetFor(actor) {
  if (!actor || actor.documentName !== 'Actor') return null;
  // An unlinked token's synthetic actor shares its base actor's id; its items are not the PC's.
  if (actor.isToken && !actor.token?.actorLink) return null;
  return resolveTarget(actor.toObject(false), { moduleId: MODULE_ID, actorToDdb: actorToDdb(), party: partyConfig() });
}

function cobaltFor(characterId) {
  return (
    setting('characterCobalts')?.[String(characterId)] ||
    setting('cobalt') ||
    foreignSetting('ddb-sync', 'cobaltCookie') ||
    ''
  );
}

const client = new ProxyClient({
  proxyUrl: () => setting('proxyUrl') || foreignSetting('ddb-sync', 'proxyUrl') || '',
  cobaltFor
});

// --- Row ids: Foundry item uuid -> D&D Beyond inventory row ---------------------
const memory = new Map(); // uuid -> { ddbId } | null (null: known to have no row yet)
const storedId = (item) => item?.getFlag?.(MODULE_ID, 'ddbId') ?? item?.flags?.ddbimporter?.id ?? null;
const ids = {
  get(uuid) {
    if (memory.has(uuid)) return memory.get(uuid);
    const ddbId = storedId(fromUuidSync(uuid));
    return ddbId ? { ddbId } : null;
  },
  async set(uuid, ddbId) {
    memory.set(uuid, { ddbId });
    const item = fromUuidSync(uuid);
    if (item) await item.update({ [`flags.${MODULE_ID}.ddbId`]: ddbId }, { [SKIP_OPTION]: { skip: true } });
  },
  forget(uuid) {
    memory.set(uuid, null);
  },
  release(uuid) {
    memory.delete(uuid);
  },
  knownMissing(uuid) {
    return memory.has(uuid) && memory.get(uuid) === null;
  },
  /** Is this row already owned by another item synced to the same character? */
  isClaimed(ddbId, op) {
    for (const [uuid, ref] of memory) if (uuid !== op.itemId && ref?.ddbId === ddbId) return true;
    for (const actor of game.actors) {
      if (targetFor(actor)?.characterId !== op.characterId) continue;
      for (const item of actor.items) if (item.uuid !== op.itemId && !memory.has(item.uuid) && storedId(item) === ddbId) return true;
    }
    return false;
  }
};

// --- Item definitions (name -> D&D Beyond definition), loaded once per session ---
let indexPromise = null;
function definitionIndex(characterId) {
  indexPromise ??= client.items(characterId, partyConfig().campaignId).then((defs) => {
    if (!defs.length) throw new Error('D&D Beyond returned no item definitions (proxy, cobalt or campaign?)');
    log('info', `Loaded ${defs.length} D&D Beyond item definitions`);
    return buildIndex(defs);
  });
  // A failure is not cached: the next add tries again instead of turning everything into custom items.
  indexPromise.catch(() => (indexPromise = null));
  return indexPromise;
}

/** Items created this session whose add has not been planned yet. */
const pendingCreates = new Set();

/** Plan an add from the item as it is now (used when the queue reaches it). */
async function planAddFor(uuid) {
  pendingCreates.delete(uuid);
  const item = fromUuidSync(uuid);
  if (!item) return null; // gone before its turn
  const target = targetFor(item.parent);
  if (!target) return null;
  const itemData = item.toObject(false);
  let definition = matchDefinition(itemData, null, MODULE_ID);
  if (!definition) definition = matchDefinition(itemData, await definitionIndex(target.characterId), MODULE_ID);
  const { op, reason, unmatched } = planCreate(itemData, target, { definition, unmatched: setting('unmatched') });
  if (!op) {
    log(unmatched ? 'warn' : 'debug', `${item.name}: ${reason}`);
    if (unmatched && setting('notifyFailures')) ui.notifications.warn(`D&D Beyond sync: ${reason} — not sent`);
    return null;
  }
  return { ...op, itemId: uuid };
}

const engine = new SyncEngine({
  client,
  ids,
  planAddFor,
  log,
  dryRun: () => setting('dryRun'),
  mode: () => setting('currencyMode'),
  verify: () => setting('verifyWrites')
});
const queue = new SyncQueue((op) => engine.run(op), {
  coalesceKey,
  merge: mergeOps,
  onError(op, err) {
    log('error', `${op.kind} ${op.name ?? ''} failed: ${err.message}`, op);
    if (setting('notifyFailures')) {
      ui.notifications.error(`D&D Beyond sync: ${op.kind} ${op.name ?? ''} failed — ${err.message}. Retry with the module API (retryFailed).`);
    }
  }
});

// --- Snapshots: quantities and coins as the GM client last saw them -------------
const quantities = new Map(); // item uuid -> quantity
const purses = new Map(); // actor uuid -> currency
function snapshotActor(actor) {
  if (!targetFor(actor)) return;
  purses.set(actor.uuid, { ...(actor.system?.currency ?? {}) });
  for (const item of actor.items) if (isPhysical(item)) quantities.set(item.uuid, quantityOf(item));
}

// --- Batching: tells a character import (DDB Importer) apart from loot ----------
const batches = new Map(); // `${kind}:${actorUuid}` -> { entries, timer }
function batch(kind, actor, data, send, onSkip = () => {}) {
  const key = `${kind}:${actor.uuid}`;
  let b = batches.get(key);
  if (!b) batches.set(key, (b = { entries: [], timer: null }));
  b.entries.push({ data, send, onSkip }); // each entry keeps its own callbacks
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    batches.delete(key);
    if (looksLikeImport(b.entries.map((e) => e.data), setting('importBurstLimit'))) {
      log('warn', `Skipped ${b.entries.length} ${kind === 'create' ? 'new' : 'removed'} items on ${actor.name}: looks like a character import`);
      for (const e of b.entries) e.onSkip();
      return;
    }
    for (const e of b.entries) e.send();
  }, BATCH_MS);
}

const hookIds = [];
const on = (name, fn) => hookIds.push([name, Hooks.on(name, fn)]);

function registerHooks() {
  on('createItem', (item, options) => {
    if (!isPhysical(item) || !targetFor(item.parent)) return;
    quantities.set(item.uuid, quantityOf(item));
    if (!enabled() || skipped(options)) return;
    const target = targetFor(item.parent);
    // A copy made by a transfer carries the source's row id; it gets its own row.
    memory.set(item.uuid, null);
    pendingCreates.add(item.uuid);
    batch(
      'create',
      item.parent,
      item.toObject(false),
      () => queue.push({ kind: 'planAdd', itemId: item.uuid, name: item.name, characterId: target.characterId, scope: target.kind }),
      () => {
        // An imported item already has its D&D Beyond row: keep the id it carries.
        pendingCreates.delete(item.uuid);
        memory.delete(item.uuid);
      }
    );
  });

  on('updateItem', (item, changes, options) => {
    if (!isPhysical(item)) return;
    const target = targetFor(item.parent);
    if (!target) return;
    const previousQuantity = quantities.has(item.uuid) ? quantities.get(item.uuid) : null;
    quantities.set(item.uuid, quantityOf(item));
    if (!enabled() || skipped(options)) return;
    if (isForeignItemUpdate(changes)) {
      log('debug', `${item.name}: update with non-inventory fields (an import?) not sent`);
      return;
    }
    // Its add is still waiting and will send the stack as it is then.
    if (pendingCreates.has(item.uuid)) return;
    const ops = planUpdate(item.toObject(false), changes, target, {
      syncEquipped: setting('syncEquipped'),
      previousQuantity,
      moduleId: MODULE_ID
    });
    for (const op of ops) queue.push({ ...op, itemId: item.uuid });
  });

  on('deleteItem', (item, options) => {
    if (!isPhysical(item)) return;
    const target = targetFor(item.parent);
    if (!target) return;
    const previousQuantity = quantities.get(item.uuid);
    quantities.delete(item.uuid);
    if (pendingCreates.delete(item.uuid)) return; // created and removed before its add was sent
    if (!enabled() || skipped(options)) return;
    const op = planDelete(item.toObject(false), target, { moduleId: MODULE_ID });
    if (!op) return;
    if (previousQuantity) op.quantity = previousQuantity;
    // Resolve the row now: the item is gone by the time the queue reaches it.
    if (!memory.has(item.uuid)) {
      const ddbId = storedId(item);
      memory.set(item.uuid, ddbId ? { ddbId } : null);
    }
    const data = item.toObject(false);
    batch('delete', item.parent, data, () => queue.push({ ...op, itemId: item.uuid }));
  });

  on('updateActor', (actor, changes, options) => {
    const target = targetFor(actor);
    if (!target) return;
    const previous = purses.get(actor.uuid) ?? null;
    purses.set(actor.uuid, { ...(actor.system?.currency ?? {}) });
    if (!enabled() || skipped(options) || !setting('syncCurrency')) return;
    if (isForeignCurrencyUpdate(changes)) {
      if (foundry.utils.hasProperty(changes, 'system.currency')) log('debug', `${actor.name}: coins changed with other data (an import?) not sent`);
      return;
    }
    const op = planCurrency(actor.system?.currency, changes, target, previous);
    if (op) queue.push(op);
  });

  // Snapshot actors that appear mid-session (a new PC, the party actor).
  on('createActor', (actor) => snapshotActor(actor));
}

// --- Public API: game.modules.get('ddb-inventory-sync').api --------------------
const api = {
  get log() {
    return [...syncLog];
  },
  get failed() {
    return [...queue.failed];
  },
  get pending() {
    return queue.size;
  },
  get paused() {
    return paused;
  },
  idle: () => queue.idle(),
  targetFor: (actor) => targetFor(actor),

  /** Stop sending (e.g. while re-importing characters with DDB Importer). Snapshots keep updating. */
  pause() {
    paused = true;
    log('info', 'Paused');
  },
  resume() {
    paused = false;
    log('info', 'Resumed');
  },
  retryFailed() {
    const n = queue.retryFailed();
    log('info', `Retrying ${n} failed operations`);
    return n;
  },
  reloadItems() {
    indexPromise = null;
  },

  /** Check settings, proxy, cookies, mappings and the party — writes nothing. */
  async diagnose({ chat = true } = {}) {
    const report = await runDiagnostics(diagnosticsContext());
    if (chat) await postReport('DDB Inventory Sync — diagnostics', report);
    return report;
  },

  /**
   * Live round trip on a TEST character: add, change, remove an item, move a
   * coin and back, custom item, party. Cleans up after itself. Ignores dry run.
   */
  async selfTest(actor, { party = true, chat = true } = {}) {
    const target = targetFor(actor);
    if (!target || target.kind !== 'character') throw new Error(`${actor?.name ?? 'That actor'} is not a synced character`);
    const index = await definitionIndex(target.characterId);
    const report = await runSelfTest({
      client,
      characterId: target.characterId,
      party: party ? partyConfig() : null,
      index,
      log
    });
    if (chat) await postReport(`DDB Inventory Sync — self-test on ${actor.name}`, report);
    return report;
  },

  /**
   * Play Item Piles scenarios on a synced test character and check D&D Beyond
   * after each step. Returns plain JSON (for foundry-mcp-bridge run_macro).
   * args: { actor, otherActor, live, only, keep, configure: { proxyUrl, enabled, dryRun, currencyMode } }
   */
  async runScenarios(args = {}) {
    if (!game.user.isGM) return { ok: false, steps: [{ name: 'Preflight', status: 'fail', detail: 'GM only' }] };
    if (args.configure) {
      for (const key of ['proxyUrl', 'enabled', 'dryRun', 'currencyMode', 'verifyWrites']) {
        if (args.configure[key] !== undefined) await game.settings.set(MODULE_ID, key, args.configure[key]);
      }
    }
    const report = await runScenarios(args, scenarioDeps());
    if (args.chat !== false) await postReport(`DDB Inventory Sync — scenarios (${report.mode})`, report.steps);
    return report;
  },

  /** Check the proxy route and the cobalt for one actor without writing anything. */
  async test(actor) {
    const target = targetFor(actor);
    if (!target) return { ok: false, message: `${actor?.name} is not synced to a D&D Beyond character` };
    const json = await client.read(target.characterId);
    if (!json?.success) return { ok: false, message: json?.message ?? 'read failed' };
    return { ok: true, character: json.data.name, campaignId: json.data.campaignId, rows: json.data.inventory.length, currencies: json.data.currencies };
  },

  /** Pair this actor's existing items with its D&D Beyond inventory rows. */
  async link(actor) {
    const target = targetFor(actor);
    if (!target || target.kind !== 'character') throw new Error(`${actor?.name} is not a synced character`);
    const json = await client.read(target.characterId);
    if (!json?.success) throw new Error(json?.message ?? 'read failed');
    const items = actor.items
      .filter((i) => isPhysical(i))
      .map((i) => ({
        uuid: i.uuid,
        name: i.name,
        quantity: quantityOf(i),
        ddbId: storedId(i),
        definitionId: i.flags?.ddbimporter?.definitionId ?? i.getFlag(MODULE_ID, 'definition')?.id ?? null
      }));
    const result = linkRows(items, json.data.inventory);
    for (const { uuid, ddbId } of result.links) await ids.set(uuid, ddbId);
    log('info', `Linked ${result.links.length} items on ${actor.name}; ${result.unmatchedItems.length} Foundry-only, ${result.unmatchedRows.length} DDB-only`);
    return result;
  },

  /** Store a player's own cobalt cookie in this (GM) browser for writes to their character. */
  async setCharacterCobalt(characterId, cobalt) {
    const map = { ...setting('characterCobalts') };
    if (cobalt) map[String(characterId)] = cobalt;
    else delete map[String(characterId)];
    await game.settings.set(MODULE_ID, 'characterCobalts', map);
  },

  /** Pin a Foundry item to a D&D Beyond definition (e.g. a vault homebrew item). */
  async setDefinition(item, id, entityTypeId) {
    await item.update({ [`flags.${MODULE_ID}.definition`]: { id, entityTypeId } }, { [SKIP_OPTION]: { skip: true } });
  }
};

const TEST_MACRO = 'DDB Inventory Sync: Test';
const TEST_MACRO_BODY = `// Plays merchant, loot, give, party and coin scenarios through Item Piles on a
// synced test character and checks D&D Beyond after each step (see TESTING.md).
// From a local Claude: foundry-mcp-bridge run_macro { name: "${TEST_MACRO}", args: { actor: "<name>" } }
// Args: actor, otherActor, live (needed against a real proxy), only: ["buy","sell","loot","use","playerEdit","give","party"], keep, configure: { proxyUrl, enabled, dryRun, currencyMode }
return await game.modules.get('ddb-inventory-sync').api.runScenarios(scope ?? {});
`;

const proxyBase = () => (setting('proxyUrl') || foreignSetting('ddb-sync', 'proxyUrl') || '').replace(/\/+$/, '');
async function mockCall(path, body) {
  const r = await fetch(`${proxyBase()}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!r.ok) throw new Error(`mock ${path} answered ${r.status}`);
  return r.json();
}

/** Wait until the batch window has passed and the queue is empty. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, BATCH_MS + 100));
    await queue.idle();
    if (!batches.size && !queue.size) return;
  }
}

function scenarioDeps() {
  const readDdb = async (characterId) => {
    const json = await client.read(characterId);
    if (!json?.success) throw new Error(`D&D Beyond read failed: ${json?.message ?? json?.ddbStatus ?? '?'}`);
    return json.data;
  };
  return {
    settings: () => ({ enabled: setting('enabled'), dryRun: setting('dryRun'), currencyMode: setting('currencyMode') }),
    isActiveGM,
    paused: () => paused,
    isMock: async () => {
      try {
        const r = await fetch(`${proxyBase()}/mock/state`);
        return r.ok && Array.isArray((await r.json())?.characters);
      } catch {
        return false;
      }
    },
    findActor: (name) => game.actors.getName?.(name) ?? game.actors.get(name) ?? null,
    syncedCharacters: () => game.actors.filter((a) => targetFor(a)?.kind === 'character'),
    targetFor,
    partyActor: () => (partyConfig().actorId ? game.actors.get(partyConfig().actorId) ?? null : null),
    itemPiles: () => (game.modules.get('item-piles')?.active ? game.itempiles?.API ?? null : null),
    readDdb,
    settle,
    rowIdOf: (item) => ids.get(item.uuid)?.ddbId ?? null,
    quantityOf: (item) => quantityOf(item),
    failed: () => queue.failed,
    createActor: (data) => Actor.create(data),
    deleteActor: (actor) => actor.delete(),
    createItems: (actor, items) => actor.createEmbeddedDocuments('Item', items),
    updateItem: (item, changes) => item.update(changes),
    deleteItem: (item) => item.delete(),
    itemData: (item) => item.toObject(),
    setCoins: (actor, coins) => actor.update({ system: { currency: coins } }),
    mockEdit: (body) => mockCall('/mock/edit', body),
    mockParty: async () => {
      const state = await mockCall('/mock/state');
      return state.party?.[String(partyConfig().campaignId)] ?? { inventory: [], currencies: {} };
    },
    log,
    recentLog: () => syncLog.slice(-60).map((e) => `${e.level} ${e.message}`)
  };
}

async function ensureTestMacro() {
  if (!game.user.isGM || !setting('provideTestMacro')) return;
  const existing = game.macros.find((m) => m.name === TEST_MACRO);
  if (existing) {
    if (existing.command !== TEST_MACRO_BODY) await existing.update({ command: TEST_MACRO_BODY });
    return;
  }
  await Macro.create({ name: TEST_MACRO, type: 'script', command: TEST_MACRO_BODY, img: 'icons/svg/dice-target.svg' });
  log('info', `Created the macro "${TEST_MACRO}"`);
}

function diagnosticsContext() {
  const mapping = actorToDdb();
  return {
    settings: {
      enabled: setting('enabled'),
      dryRun: setting('dryRun'),
      currencyMode: setting('currencyMode'),
      verifyWrites: setting('verifyWrites'),
      proxyUrl: setting('proxyUrl') || foreignSetting('ddb-sync', 'proxyUrl') || ''
    },
    isActiveGM: isActiveGM(),
    paused,
    modules: {
      itemPiles: !!game.modules.get('item-piles')?.active,
      ddbSync: !!game.modules.get('ddb-sync')?.active,
      ddbImporterDynamicSync: !!(game.modules.get('ddb-importer')?.active && foreignSetting('ddb-importer', 'dynamic-sync'))
    },
    actors: game.actors
      .map((a) => ({ name: a.name, id: a.id, target: targetFor(a), hasCobalt: !!cobaltFor(targetFor(a)?.characterId) }))
      .filter((a) => a.target),
    mappedIds: [...mapping.entries()],
    party: partyConfig(),
    partyActorExists: !!(partyConfig().actorId && game.actors.get(partyConfig().actorId)),
    client,
    loadItems: (characterId) => client.items(characterId, partyConfig().campaignId)
  };
}

async function postReport(title, report) {
  await ChatMessage.create({
    content: renderReport(title, report),
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    speaker: { alias: 'DDB Inventory Sync' }
  });
}

/**
 * Start the runtime: snapshot, hooks, macros. Returns the API and a stop()
 * that unhooks everything and lets the queue drain (at most 10 s).
 * @param {{menus?: object, reloaded?: boolean}} [opts]
 */
export async function start({ menus = {}, reloaded = false } = {}) {
  if (reloaded) registerSettings(menus); // pick up settings added since the page loaded
  for (const actor of game.actors) snapshotActor(actor);
  registerHooks();
  await ensureTestMacro().catch((err) => log('warn', `Could not create the test macro: ${err.message}`));
  if (!reloaded && game.user.isGM && diagnosticsContext().modules.ddbImporterDynamicSync) {
    ui.notifications.warn('DDB Inventory Sync: DDB Importer dynamic sync is on as well — inventory changes would be sent twice.');
  }
  log('info', `${reloaded ? 'Reloaded' : 'Ready'} (${setting('enabled') ? (setting('dryRun') ? 'dry run' : 'live') : 'disabled'}, ${setting('currencyMode')} mode)`);
  return {
    api,
    async stop() {
      for (const [name, id] of hookIds.splice(0)) Hooks.off(name, id);
      for (const b of batches.values()) clearTimeout(b.timer);
      batches.clear();
      await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 10000))]);
    }
  };
}
