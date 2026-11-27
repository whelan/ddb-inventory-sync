/**
 * Planner: turns a Foundry document change into sync operations.
 *
 * Pure — callers pass plain data (`item.toObject()`, the hook's `changes`),
 * the previous value they remember, and the already-resolved sync target, so
 * every rule here is unit-tested.
 *
 * A target is where an actor's inventory lives on D&D Beyond:
 *   { characterId, container: { id, typeId }, kind: 'character' | 'party' }
 * For a character the container is the character itself; for the party it is
 * the campaign's party inventory, reached through a carrier character that
 * is a member of the campaign.
 *
 * Quantities and coins carry both the new value and the delta from the
 * previous one. The engine applies the delta to what D&D Beyond holds now
 * (players also use the D&D Beyond sheet), and falls back to the absolute
 * value where it cannot read the current one.
 */
import { COINS, PHYSICAL_TYPES } from './constants.js';

/** Read a path from a change object, whether it is nested or uses dotted keys. */
const get = (obj, path) => {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const dot = path.indexOf('.');
  if (dot === -1) return undefined;
  for (let i = dot; i !== -1; i = path.indexOf('.', i + 1)) {
    const head = path.slice(0, i);
    if (obj[head] !== undefined && typeof obj[head] === 'object') {
      const v = get(obj[head], path.slice(i + 1));
      if (v !== undefined) return v;
    }
  }
  return undefined;
};
const has = (obj, path) => get(obj, path) !== undefined;

/** Every leaf path in a (possibly nested, possibly dotted) change object. */
export function changedPaths(changes, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(changes ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      out.push(...changedPaths(value, path));
    } else out.push(path);
  }
  return out;
}

const BOOKKEEPING = /^(_id|_stats(\.|$)|flags(\.|$)|sort$|ownership(\.|$))/;
const ITEM_FIELDS = /^system\.(quantity|equipped|attuned|container)$/;
const CURRENCY_FIELDS = /^system\.currency(\.|$)/;

/**
 * True when an item update touches more than inventory bookkeeping — the
 * shape of DDB Importer re-importing a sheet, whose values D&D Beyond
 * already holds. Item Piles and sheet edits change only these fields.
 */
export function isForeignItemUpdate(changes) {
  return changedPaths(changes).some((p) => !BOOKKEEPING.test(p) && !ITEM_FIELDS.test(p));
}

/** True when an actor update changes coins together with other data (an import, not a trade). */
export function isForeignCurrencyUpdate(changes) {
  return changedPaths(changes).some((p) => !BOOKKEEPING.test(p) && !CURRENCY_FIELDS.test(p));
}

export function isPhysical(itemData) {
  return PHYSICAL_TYPES.includes(itemData?.type);
}

export function quantityOf(itemData) {
  const q = Math.floor(Number(itemData?.system?.quantity ?? 1));
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/** What identifies the item on D&D Beyond when no row id is stored. */
export function refOf(itemData, moduleId) {
  return {
    definitionId: itemData?.flags?.[moduleId]?.definition?.id ?? itemData?.flags?.ddbimporter?.definitionId ?? null,
    name: itemData?.name ?? ''
  };
}

/** Plain-text description for a custom item, trimmed to what D&D Beyond accepts. */
export function plainDescription(html, max = 2000) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** dnd5e price → gold pieces, or null. */
export function priceInGp(price) {
  const value = Number(price?.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rate = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 }[price?.denomination ?? 'gp'] ?? 1;
  return Math.round(value * rate * 100) / 100;
}

function weightOf(itemData) {
  const w = Number(itemData?.system?.weight?.value ?? itemData?.system?.weight);
  return Number.isFinite(w) && w >= 0 ? w : null;
}

/**
 * An item appeared on a synced actor (loot taken, merchant purchase, GM drop).
 * @param {object} itemData
 * @param {object} target
 * @param {{definition: object|null, unmatched: 'custom'|'skip'}} match
 * @returns {{op: object|null, reason?: string}}
 */
export function planCreate(itemData, target, { definition, unmatched = 'custom' }) {
  if (!target) return { op: null, reason: 'actor is not synced' };
  if (!isPhysical(itemData)) return { op: null, reason: `type "${itemData?.type}" is not inventory` };
  const quantity = quantityOf(itemData);
  if (quantity === 0) return { op: null, reason: 'quantity is 0' };
  const base = {
    kind: 'add',
    itemId: itemData._id,
    name: itemData.name,
    characterId: target.characterId,
    scope: target.kind,
    container: target.container,
    quantity
  };
  if (definition) return { op: { ...base, definition: { id: definition.id, entityTypeId: definition.entityTypeId } } };
  if (unmatched === 'skip') return { op: null, reason: `no D&D Beyond item named "${itemData.name}"`, unmatched: true };
  return {
    op: {
      ...base,
      custom: {
        name: String(itemData.name ?? 'Item').slice(0, 256),
        description: plainDescription(itemData.system?.description?.value),
        cost: priceInGp(itemData.system?.price),
        weight: weightOf(itemData)
      }
    }
  };
}

/**
 * An item on a synced actor changed.
 * @param {number|null} previousQuantity  what the item held before, if known
 * @returns {object[]} operations (possibly empty)
 */
export function planUpdate(itemData, changes, target, { syncEquipped = true, previousQuantity = null, moduleId } = {}) {
  if (!target || !isPhysical(itemData)) return [];
  const ops = [];
  const ref = { itemId: itemData._id, name: itemData.name, characterId: target.characterId, scope: target.kind, ref: refOf(itemData, moduleId) };
  if (has(changes, 'system.quantity')) {
    const quantity = Math.max(0, Math.floor(Number(get(changes, 'system.quantity'))));
    if (Number.isFinite(quantity) && quantity !== previousQuantity) {
      const delta = Number.isFinite(previousQuantity) ? quantity - previousQuantity : null;
      if (quantity > 0) ops.push({ kind: 'quantity', ...ref, quantity, delta, previousQuantity });
      else ops.push({ kind: 'remove', ...ref, quantity: previousQuantity ?? null });
    }
  }
  if (syncEquipped && target.kind === 'character') {
    if (has(changes, 'system.equipped')) ops.push({ kind: 'equipped', ...ref, value: !!get(changes, 'system.equipped') });
    if (has(changes, 'system.attuned')) ops.push({ kind: 'attuned', ...ref, value: !!get(changes, 'system.attuned') });
  }
  return ops;
}

/**
 * An item left a synced actor (sold, given away, used up, dropped).
 * `quantity` is the stack that left, so D&D Beyond keeps anything extra a
 * player added there.
 */
export function planDelete(itemData, target, { moduleId } = {}) {
  if (!target || !isPhysical(itemData)) return null;
  return {
    kind: 'remove',
    itemId: itemData._id,
    name: itemData.name,
    characterId: target.characterId,
    scope: target.kind,
    ref: refOf(itemData, moduleId),
    quantity: quantityOf(itemData) || null
  };
}

function purse(currency) {
  const coins = {};
  for (const coin of COINS) {
    const n = Math.max(0, Math.floor(Number(currency?.[coin] ?? 0)));
    coins[coin] = Number.isFinite(n) ? n : 0;
  }
  return coins;
}

/**
 * A synced actor's coins changed.
 * @param {object} currency  actor.system.currency after the update
 * @param {object} changes   the hook's changes
 * @param {object|null} previous  actor.system.currency before, if known
 */
export function planCurrency(currency, changes, target, previous = null) {
  if (!target || !has(changes, 'system.currency')) return null;
  const coins = purse(currency);
  let delta = null;
  if (previous) {
    const before = purse(previous);
    delta = {};
    for (const coin of COINS) delta[coin] = coins[coin] - before[coin];
    if (COINS.every((c) => delta[c] === 0)) return null; // nothing actually moved
  }
  return {
    kind: 'currency',
    characterId: target.characterId,
    scope: target.kind,
    destination: { id: target.container.id, typeId: target.container.typeId },
    coins,
    delta
  };
}

/** Key used by the queue to fold a waiting op into a newer one. */
export function coalesceKey(op) {
  switch (op.kind) {
    case 'currency':
      return `currency:${op.destination.typeId}:${op.destination.id}`;
    case 'quantity':
    case 'equipped':
    case 'attuned':
      return `${op.kind}:${op.itemId}`;
    default:
      return null;
  }
}

const addDeltas = (a, b) => (a == null || b == null ? null : a + b);

/** Fold a waiting op into the newer one with the same key: latest value, summed deltas. */
export function mergeOps(older, newer) {
  if (newer.kind === 'quantity') {
    return { ...newer, delta: addDeltas(older.delta, newer.delta), previousQuantity: older.previousQuantity };
  }
  if (newer.kind === 'currency') {
    if (!older.delta || !newer.delta) return { ...newer, delta: null };
    const delta = {};
    for (const coin of COINS) delta[coin] = (older.delta[coin] ?? 0) + (newer.delta[coin] ?? 0);
    return { ...newer, delta };
  }
  return newer;
}
