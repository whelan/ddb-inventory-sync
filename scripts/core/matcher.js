/**
 * Item matcher: finds the D&D Beyond definition for a Foundry item.
 *
 * Pure — no Foundry globals. The definition list is whatever the proxy's
 * /proxy/items returns (raw D&D Beyond item definitions, homebrew included
 * when the campaign shares it).
 */

/** Lowercase, drop punctuation and apostrophes, collapse whitespace. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
}

/** Name variants tried in order: as written, without a trailing "(...)", "+1 X" ⇄ "X, +1". */
export function nameVariants(name) {
  const base = normalizeName(name);
  const out = new Set([base]);
  const noParen = normalizeName(String(name ?? '').replace(/\s*\([^)]*\)\s*$/, ''));
  if (noParen) out.add(noParen);
  const lead = base.match(/^\+(\d) (.+)$/);
  if (lead) out.add(`${lead[2]} +${lead[1]}`);
  const trail = base.match(/^(.+) \+(\d)$/);
  if (trail) out.add(`+${trail[2]} ${trail[1]}`);
  return [...out].filter(Boolean);
}

/**
 * Build a name → definition index. When several definitions share a name the
 * best one wins: homebrew (a vault item pushed to D&D Beyond is the one this
 * campaign means) over a current official item over a legacy one (2014 and
 * 2024 printings of "Potion of Healing" share the name).
 * @param {Array<{id:number, entityTypeId:number, name:string, isHomebrew?:boolean, isLegacy?:boolean}>} definitions
 */
export function buildIndex(definitions) {
  const rank = (d) => (d.isHomebrew ? 3 : d.isLegacy ? 1 : 2);
  const index = new Map();
  for (const def of definitions ?? []) {
    const d = def?.definition ?? def; // tolerate wrapped rows
    if (!d || !Number.isInteger(d.id) || !Number.isInteger(d.entityTypeId) || !d.name) continue;
    const key = normalizeName(d.name);
    const entry = { id: d.id, entityTypeId: d.entityTypeId, name: d.name, isHomebrew: !!d.isHomebrew, isLegacy: !!d.isLegacy };
    const existing = index.get(key);
    if (!existing || rank(entry) > rank(existing)) index.set(key, entry);
  }
  return index;
}

/**
 * Resolve the definition for an item.
 * @param {{name:string, flags?:object}} item  plain data (item.toObject() or a test double)
 * @param {Map} index  from buildIndex
 * @param {string} moduleId
 * @returns {{id:number, entityTypeId:number, source:'flag'|'ddbimporter'|'name'} | null}
 */
export function matchDefinition(item, index, moduleId) {
  const own = item?.flags?.[moduleId]?.definition;
  if (Number.isInteger(own?.id) && Number.isInteger(own?.entityTypeId)) {
    return { id: own.id, entityTypeId: own.entityTypeId, source: 'flag' };
  }
  const imp = item?.flags?.ddbimporter;
  if (Number.isInteger(imp?.definitionId) && Number.isInteger(imp?.definitionEntityTypeId)) {
    return { id: imp.definitionId, entityTypeId: imp.definitionEntityTypeId, source: 'ddbimporter' };
  }
  if (!index) return null;
  for (const variant of nameVariants(item?.name)) {
    const hit = index.get(variant);
    if (hit) return { id: hit.id, entityTypeId: hit.entityTypeId, source: 'name' };
  }
  return null;
}
