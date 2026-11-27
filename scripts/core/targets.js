/**
 * Targets: which D&D Beyond inventory a Foundry actor's items belong to.
 *
 * Pure. Sources, first hit wins:
 *  1. the party actor set in this module's settings -> the campaign's party inventory
 *  2. this module's actor flag  flags[MODULE_ID].characterId
 *  3. ddb-sync's character mapping  { [ddbCharacterId]: actorId }
 *  4. DDB Importer's flag  flags.ddbimporter.dndbeyond.characterId
 */
import { ENTITY_TYPES } from './constants.js';

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Invert ddb-sync's mapping into actorId -> ddbCharacterId. */
export function invertMapping(mapping) {
  const out = new Map();
  for (const [ddbId, actorId] of Object.entries(mapping ?? {})) {
    const id = toId(ddbId);
    if (id && actorId) out.set(actorId, id);
  }
  return out;
}

/**
 * @param {{_id?:string, id?:string, flags?:object}} actor
 * @param {{moduleId:string, actorToDdb:Map, party?:{actorId?:string, campaignId?:number|string, carrierCharacterId?:number|string}}} ctx
 * @returns {{kind:'character'|'party', characterId:number, container:{id:number,typeId:number}} | null}
 */
export function resolveTarget(actor, ctx) {
  const actorId = actor?._id ?? actor?.id;
  if (!actorId) return null;

  const party = ctx.party ?? {};
  if (party.actorId && party.actorId === actorId) {
    const campaignId = toId(party.campaignId);
    const carrier = toId(party.carrierCharacterId) ?? [...(ctx.actorToDdb?.values() ?? [])][0] ?? null;
    if (!campaignId || !carrier) return null;
    return { kind: 'party', characterId: carrier, container: { id: campaignId, typeId: ENTITY_TYPES.CAMPAIGN } };
  }

  const characterId =
    toId(actor.flags?.[ctx.moduleId]?.characterId) ??
    toId(ctx.actorToDdb?.get(actorId)) ??
    toId(actor.flags?.ddbimporter?.dndbeyond?.characterId);
  if (!characterId) return null;
  return { kind: 'character', characterId, container: { id: characterId, typeId: ENTITY_TYPES.CHARACTER } };
}
