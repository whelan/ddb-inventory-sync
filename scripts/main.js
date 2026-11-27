/**
 * DDB Inventory Sync — Foundry glue.
 *
 * Listens to core document hooks rather than Item Piles' own hooks: a
 * merchant purchase, a loot pile "take", a trade and a GM drag all end as
 * createItem / updateItem / deleteItem / updateActor on the receiving actor,
 * so one listener covers Item Piles, other merchant sheets and manual edits.
 * Only the active GM client acts, so each change is sent once.
 */
import { MODULE_ID, SKIP_OPTION } from './core/constants.js';
import { buildIndex, matchDefinition } from './core/matcher.js';
import { coalesceKey, planCreate, planCurrency, planDelete, planUpdate, isPhysical } from './core/planner.js';
import { SyncQueue } from './core/queue.js';
import { SyncEngine } from './core/engine.js';
import { invertMapping, resolveTarget } from './core/targets.js';
import { ProxyClient } from './core/client.js';
import { linkRows, looksLikeImport } from './core/linker.js';
import { registerSettings, setting, foreignSetting } from './settings.js';

const LOG_SIZE = 200;
const syncLog = [];

function log(level, message, op) {
  const entry = { at: new Date().toISOString(), level, message, characterId: op?.characterId ?? null };
  syncLog.push(entry);
  if (syncLog.length > LOG_SIZE) syncLog.shift();
  if (level === 'debug') {
    console.debug(`${MODULE_ID} | ${message}`);
    return;
  }
  (console[level] ?? console.log)(`${MODULE_ID} | ${message}`);
}

const isActiveGM = () => !!game.users.activeGM?.isSelf;
const enabled = () => setting('enabled') && isActiveGM();
const skipped = (options) => !!options?.[SKIP_OPTION]?.skip;

function partyConfig() {
  return {
    actorId: setting('partyActorId') || null,
    campaignId: setting('partyCampaignId') || foreignSetting('ddb-sync', 'campaignId') || null,
    carrierCharacterId: setting('partyCarrierCharacterId') || null
  };
}

function targetFor(actor) {
  if (!actor || actor.documentName !== 'Actor') return null;
  return resolveTarget(actor.toObject(false), {
    moduleId: MODULE_ID,
    actorToDdb: invertMapping(foreignSetting('ddb-sync', 'characterMapping')),
    party: partyConfig()
  });
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

/** Foundry item uuid -> D&D Beyond inventory row id. Memory first, then the item's flags. */
const memory = new Map();
const ids = {
  get(uuid) {
    if (memory.has(uuid)) return memory.get(uuid);
    const item = fromUuidSync(uuid);
    const ddbId = item?.getFlag(MODULE_ID, 'ddbId') ?? item?.flags?.ddbimporter?.id ?? null;
    return ddbId ? { ddbId } : null;
  },
  async set(uuid, ddbId) {
    memory.set(uuid, { ddbId });
    const item = fromUuidSync(uuid);
    if (item) await item.update({ [`flags.${MODULE_ID}.ddbId`]: ddbId }, { [SKIP_OPTION]: { skip: true } });
  },
  forget(uuid) {
    memory.delete(uuid);
  }
};

const engine = new SyncEngine({ client, ids, log, dryRun: () => setting('dryRun') });
const queue = new SyncQueue((op) => engine.run(op), {
  coalesceKey,
  onError(op, err) {
    log('error', `${op.kind} ${op.name ?? ''} failed: ${err.message}`, op);
    if (setting('notifyFailures')) ui.notifications.warn(`D&D Beyond sync: ${op.kind} ${op.name ?? ''} failed — ${err.message}`);
  }
});

// --- Item definitions (name -> D&D Beyond definition), loaded once per session ---
let indexPromise = null;
function definitionIndex(characterId) {
  indexPromise ??= client
    .items(characterId, partyConfig().campaignId)
    .then((defs) => {
      log('info', `Loaded ${defs.length} D&D Beyond item definitions`);
      return buildIndex(defs);
    })
    .catch((err) => {
      log('warn', `Could not load D&D Beyond items: ${err.message}`);
      indexPromise = null;
      return new Map();
    });
  return indexPromise;
}

// --- Create batching: tells a character import apart from loot ---
const createBatches = new Map(); // actor uuid -> { items: Item[], timer }
function enqueueCreate(item, target) {
  const key = item.parent.uuid;
  let batch = createBatches.get(key);
  if (!batch) {
    batch = { items: [], target, timer: null };
    createBatches.set(key, batch);
  }
  batch.items.push(item);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => flushCreates(key), 300);
}

async function flushCreates(key) {
  const batch = createBatches.get(key);
  createBatches.delete(key);
  if (!batch) return;
  const data = batch.items.map((i) => i.toObject(false));
  if (looksLikeImport(data, setting('importBurstLimit'))) {
    log('warn', `Skipped ${data.length} new items on ${batch.items[0].parent.name}: looks like a character import`);
    return;
  }
  const index = await definitionIndex(batch.target.characterId);
  for (const item of batch.items) {
    if (!fromUuidSync(item.uuid)) continue; // created and removed again within the batch window
    const itemData = item.toObject(false);
    const definition = matchDefinition(itemData, index, MODULE_ID);
    const { op, reason } = planCreate(itemData, batch.target, { definition, unmatched: setting('unmatched') });
    if (!op) {
      log(reason?.startsWith('no D&D Beyond item') ? 'warn' : 'debug', `${item.name}: ${reason}`);
      if (reason?.startsWith('no D&D Beyond item') && setting('notifyFailures')) {
        ui.notifications.warn(`D&D Beyond sync: ${reason} — not sent`);
      }
      continue;
    }
    queue.push({ ...op, itemId: item.uuid });
  }
}

function registerHooks() {
  Hooks.on('createItem', (item, options) => {
    if (!enabled() || skipped(options) || !isPhysical(item)) return;
    const target = targetFor(item.parent);
    if (!target) return;
    // A copy made by a transfer carries the source's row id; it gets its own row.
    memory.set(item.uuid, null);
    enqueueCreate(item, target);
  });

  Hooks.on('updateItem', (item, changes, options) => {
    if (!enabled() || skipped(options)) return;
    const target = targetFor(item.parent);
    for (const op of planUpdate(item.toObject(false), changes, target, { syncEquipped: setting('syncEquipped') })) {
      queue.push({ ...op, itemId: item.uuid });
    }
  });

  Hooks.on('deleteItem', (item, options) => {
    if (!enabled() || skipped(options)) return;
    const op = planDelete(item.toObject(false), targetFor(item.parent));
    if (!op) return;
    // Resolve the row now: the item is gone by the time the queue reaches it.
    if (!memory.has(item.uuid)) {
      const ddbId = item.getFlag(MODULE_ID, 'ddbId') ?? item.flags?.ddbimporter?.id ?? null;
      memory.set(item.uuid, ddbId ? { ddbId } : null);
    }
    queue.push({ ...op, itemId: item.uuid });
  });

  Hooks.on('updateActor', (actor, changes, options) => {
    if (!enabled() || skipped(options) || !setting('syncCurrency')) return;
    const op = planCurrency(actor.system?.currency, changes, targetFor(actor));
    if (op) queue.push(op);
  });
}

// --- Public API: game.modules.get('ddb-inventory-sync').api ---
const api = {
  get log() {
    return [...syncLog];
  },
  get pending() {
    return queue.size;
  },
  idle: () => queue.idle(),
  targetFor: (actor) => targetFor(actor),

  /** Check the proxy route and the cobalt for one actor without writing anything. */
  async test(actor) {
    const target = targetFor(actor);
    if (!target) return { ok: false, message: `${actor?.name} is not synced to a D&D Beyond character` };
    const json = await client.read(target.characterId);
    if (!json?.success) return { ok: false, message: json?.message ?? 'read failed' };
    return {
      ok: true,
      character: json.data.name,
      campaignId: json.data.campaignId,
      rows: json.data.inventory.length,
      currencies: json.data.currencies
    };
  },

  /**
   * Pair this actor's existing items with its D&D Beyond inventory rows
   * (run once per character before the first session with sync on).
   */
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
        quantity: i.system.quantity ?? 1,
        ddbId: i.getFlag(MODULE_ID, 'ddbId') ?? i.flags?.ddbimporter?.id ?? null,
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

Hooks.once('init', () => {
  registerSettings();
});

Hooks.once('ready', () => {
  game.modules.get(MODULE_ID).api = api;
  registerHooks();
  if (game.user.isGM && game.modules.get('ddb-importer')?.active && foreignSetting('ddb-importer', 'dynamic-sync')) {
    ui.notifications.warn('DDB Inventory Sync: DDB Importer dynamic sync is on as well — inventory changes would be sent twice.');
  }
  log('info', `Ready (${setting('enabled') ? (setting('dryRun') ? 'dry run' : 'live') : 'disabled'})`);
});
