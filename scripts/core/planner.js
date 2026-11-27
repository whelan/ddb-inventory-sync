/**
 * Planner: turns a Foundry document change into sync operations.
 *
 * Pure — callers pass plain data (`item.toObject()`, the hook's `changes`)
 * and the already-resolved sync target, so every rule here is unit-tested.
 *
 * A target is where an actor's inventory lives on D&D Beyond:
 *   { characterId, container: { id, typeId }, kind: 'character' | 'party' }
 * For a character the container is the character itself; for the party it is
 * the campaign's party inventory, reached through a carrier character that
 * is a member of the campaign.
 */
import { COINS, PHYSICAL_TYPES } from './constants.js';

const has = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined;
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function isPhysical(itemData) {
  return PHYSICAL_TYPES.includes(itemData?.type);
}

function quantityOf(itemData) {
  const q = Number(itemData?.system?.quantity ?? 1);
  return Number.isInteger(q) && q > 0 ? q : 1;
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
  const base = {
    kind: 'add',
    itemId: itemData._id,
    name: itemData.name,
    characterId: target.characterId,
    container: target.container,
    quantity: quantityOf(itemData)
  };
  if (definition) return { op: { ...base, definition: { id: definition.id, entityTypeId: definition.entityTypeId } } };
  if (unmatched === 'skip') return { op: null, reason: `no D&D Beyond item named "${itemData.name}"` };
  return {
    op: {
      ...base,
      custom: {
        name: itemData.name,
        description: plainDescription(itemData.system?.description?.value),
        cost: priceInGp(itemData.system?.price),
        weight: Number.isFinite(Number(itemData.system?.weight?.value ?? itemData.system?.weight))
          ? Number(itemData.system?.weight?.value ?? itemData.system?.weight)
          : null
      }
    }
  };
}

/**
 * An item on a synced actor changed.
 * @returns {object[]} operations (possibly empty)
 */
export function planUpdate(itemData, changes, target, { syncEquipped = true } = {}) {
  if (!target || !isPhysical(itemData)) return [];
  const ops = [];
  const ref = { itemId: itemData._id, name: itemData.name, characterId: target.characterId };
  if (has(changes, 'system.quantity')) {
    const quantity = Number(get(changes, 'system.quantity'));
    if (Number.isInteger(quantity) && quantity > 0) ops.push({ kind: 'quantity', ...ref, quantity });
    else if (quantity === 0) ops.push({ kind: 'remove', ...ref });
  }
  if (syncEquipped && target.kind === 'character') {
    if (has(changes, 'system.equipped')) ops.push({ kind: 'equipped', ...ref, value: !!get(changes, 'system.equipped') });
    if (has(changes, 'system.attunement') || has(changes, 'system.attuned')) {
      const attuned = get(changes, 'system.attuned');
      if (attuned !== undefined) ops.push({ kind: 'attuned', ...ref, value: !!attuned });
    }
  }
  return ops;
}

/** An item left a synced actor (sold, given away, used up, dropped). */
export function planDelete(itemData, target) {
  if (!target || !isPhysical(itemData)) return null;
  return { kind: 'remove', itemId: itemData._id, name: itemData.name, characterId: target.characterId };
}

/**
 * A synced actor's coins changed. Sends the actor's full purse, because
 * D&D Beyond's currency call sets absolute values.
 * @param {object} currency  actor.system.currency after the update
 * @param {object} changes   the hook's changes
 */
export function planCurrency(currency, changes, target) {
  if (!target || !has(changes, 'system.currency')) return null;
  const coins = {};
  for (const coin of COINS) {
    const n = Math.max(0, Math.floor(Number(currency?.[coin] ?? 0)));
    coins[coin] = Number.isFinite(n) ? n : 0;
  }
  return {
    kind: 'currency',
    characterId: target.characterId,
    destination: { id: target.container.id, typeId: target.container.typeId },
    coins
  };
}

/** Key used by the queue to drop a pending op that a newer one supersedes. */
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
