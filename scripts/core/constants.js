export const MODULE_ID = 'ddb-inventory-sync';

/** D&D Beyond container entity type ids (from its character-app bundle). */
export const ENTITY_TYPES = Object.freeze({
  CHARACTER: 1581111423,
  ITEM: 1439493548,
  CAMPAIGN: 618115330 // the campaign's party inventory
});

/** dnd5e item types that live in a D&D Beyond inventory. */
export const PHYSICAL_TYPES = Object.freeze(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container']);

export const COINS = Object.freeze(['cp', 'sp', 'ep', 'gp', 'pp']);

/** Pass `{ [MODULE_ID]: { skip: true } }` in a document operation's options to keep it out of the sync. */
export const SKIP_OPTION = MODULE_ID;
