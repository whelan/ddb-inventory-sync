import { MODULE_ID } from './core/constants.js';

export function registerSettings(menus = {}) {
  if (menus.DiagnosticsMenu) {
    game.settings.registerMenu(MODULE_ID, 'diagnostics', {
      name: 'Diagnostics',
      label: 'Run diagnostics',
      hint: 'Checks proxy, cookies, character mapping, party and item list. Writes nothing; the report is whispered to the GM.',
      icon: 'fas fa-stethoscope',
      type: menus.DiagnosticsMenu,
      restricted: true
    });
  }
  if (menus.SelfTestMenu) {
    game.settings.registerMenu(MODULE_ID, 'selfTest', {
      name: 'Live self-test',
      label: 'Run live self-test',
      hint: 'Round trip against a D&D Beyond TEST character: adds, changes and removes a test item, a copper and a custom item, and cleans up.',
      icon: 'fas fa-vial',
      type: menus.SelfTestMenu,
      restricted: true
    });
  }
  const world = (key, data) => game.settings.register(MODULE_ID, key, { scope: 'world', config: true, ...data });
  const client = (key, data) => game.settings.register(MODULE_ID, key, { scope: 'client', ...data });

  world('enabled', {
    name: 'Enable sync to D&D Beyond',
    hint: 'Send loot, merchant trades and coin changes on synced actors to their D&D Beyond characters. Runs on the active GM client only.',
    type: Boolean,
    default: false
  });
  world('dryRun', {
    name: 'Dry run',
    hint: 'Log what would be sent (console and sync log) without writing to D&D Beyond. Turn off once the log looks right.',
    type: Boolean,
    default: true
  });
  world('proxyUrl', {
    name: 'Proxy URL',
    hint: 'Your ddb-proxy with the /proxy/inventory route. Empty uses ddb-sync\'s proxy URL.',
    type: String,
    default: ''
  });
  world('unmatched', {
    name: 'Items not found on D&D Beyond',
    hint: 'What to do when no D&D Beyond item has the Foundry item\'s name (push vault homebrew to D&D Beyond first to get real items).',
    type: String,
    choices: { custom: 'Create a custom item', skip: 'Skip and warn' },
    default: 'custom'
  });
  world('currencyMode', {
    name: 'How changes are applied',
    hint: 'Delta: read the character on D&D Beyond and apply the Foundry change to it, so what a player changed on the D&D Beyond sheet survives. Absolute: overwrite D&D Beyond with the Foundry value. The party inventory is always absolute.',
    type: String,
    choices: { delta: 'Delta (recommended)', absolute: 'Absolute' },
    default: 'delta'
  });
  world('verifyWrites', {
    name: 'Verify writes',
    hint: 'Read every character write back from D&D Beyond and report a mismatch. One extra call per change; turn off once trusted.',
    type: Boolean,
    default: true
  });
  world('syncCurrency', { name: 'Sync coins', type: Boolean, default: true });
  world('syncEquipped', { name: 'Sync equipped / attuned', type: Boolean, default: true });
  world('importBurstLimit', {
    name: 'Import guard',
    hint: 'More new items than this on one actor at once, mostly carrying D&D Beyond ids, is treated as a character import and not sent back.',
    type: Number,
    default: 8
  });
  world('partyActorId', {
    name: 'Party actor ID',
    hint: 'Foundry actor (an Item Piles vault or a dnd5e group) whose items and coins are the campaign\'s party inventory on D&D Beyond.',
    type: String,
    default: ''
  });
  world('partyCampaignId', {
    name: 'D&D Beyond campaign ID',
    hint: 'Empty uses ddb-sync\'s campaign ID.',
    type: String,
    default: ''
  });
  world('partyCarrierCharacterId', {
    name: 'Party carrier character',
    hint: 'D&D Beyond character ID (a member of the campaign) whose endpoint party-inventory writes go through. Empty uses the first mapped character.',
    type: String,
    default: ''
  });
  world('notifyFailures', { name: 'Notify GM on sync failures', type: Boolean, default: true });

  // Secrets live in the GM's browser only, never in world data that players receive.
  client('cobalt', {
    name: 'D&D Beyond cobalt cookie (this browser)',
    hint: 'Used for every character without its own cookie. Empty falls back to ddb-sync\'s cookie.',
    type: String,
    default: '',
    config: true
  });
  client('characterCobalts', { type: Object, default: {}, config: false });
  client('debug', { name: 'Debug logging', hint: 'Also print skipped changes to the console.', type: Boolean, default: false, config: true });
}

export const setting = (key) => game.settings.get(MODULE_ID, key);

/** Read another module's setting without throwing when it is absent. */
export function foreignSetting(moduleId, key) {
  try {
    return game.settings.get(moduleId, key);
  } catch {
    return undefined;
  }
}
