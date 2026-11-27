/**
 * Linker: pairs Foundry items that already exist with the D&D Beyond
 * inventory rows they correspond to, so later quantity changes and removals
 * reach the right row. Pure.
 */
import { normalizeName } from './matcher.js';

/**
 * @param {Array<{uuid:string, name:string, quantity:number, ddbId?:number|null, definitionId?:number|null}>} items
 * @param {Array<{id:number, definitionId:number, name:string, quantity:number}>} rows  from proxy op "read"
 * @returns {{links: Array<{uuid:string, ddbId:number}>, unmatchedItems: string[], unmatchedRows: string[]}}
 */
export function linkRows(items, rows) {
  const free = new Map(rows.map((r) => [r.id, r]));
  const links = [];
  const pending = [];

  for (const item of items) {
    if (item.ddbId && free.has(item.ddbId)) {
      free.delete(item.ddbId);
      continue; // already linked and still there
    }
    pending.push(item);
  }

  const take = (pred) => {
    for (const row of free.values()) {
      if (pred(row)) {
        free.delete(row.id);
        return row;
      }
    }
    return null;
  };

  const unmatchedItems = [];
  for (const item of pending) {
    const name = normalizeName(item.name);
    const row =
      (item.definitionId && take((r) => r.definitionId === item.definitionId && r.quantity === item.quantity)) ||
      (item.definitionId && take((r) => r.definitionId === item.definitionId)) ||
      take((r) => normalizeName(r.name) === name && r.quantity === item.quantity) ||
      take((r) => normalizeName(r.name) === name);
    if (row) links.push({ uuid: item.uuid, ddbId: row.id });
    else unmatchedItems.push(item.name);
  }

  return { links, unmatchedItems, unmatchedRows: [...free.values()].map((r) => r.name ?? `#${r.id}`) };
}

/**
 * Decide whether a burst of item creations on one actor is a character import
 * (DDB Importer rebuilding the sheet) rather than loot: big, and mostly items
 * that already carry a D&D Beyond inventory id.
 */
export function looksLikeImport(batch, limit) {
  if (batch.length <= limit) return false;
  const imported = batch.filter((d) => Number.isInteger(d?.flags?.ddbimporter?.id)).length;
  return imported * 2 >= batch.length;
}
