/**
 * Diagnostics (read-only) and the live self-test (writes to a TEST character
 * and cleans up). Both return a report: [{ name, status, detail }] with
 * status 'ok' | 'warn' | 'fail' | 'info'. No Foundry globals, so tests run
 * them against the mock proxy.
 */
import { COINS, ENTITY_TYPES } from './constants.js';
import { addedRows } from './engine.js';
import { normalizeName } from './matcher.js';

const step = (name, status, detail = '') => ({ name, status, detail });

async function readCharacter(client, characterId) {
  const json = await client.read(characterId);
  if (!json?.success || !json.data) throw new Error(json?.message ?? `read failed (${json?.ddbStatus ?? '?'})`);
  return json.data;
}

/**
 * @param {object} ctx see diagnosticsContext() in main.js
 */
export async function runDiagnostics(ctx) {
  const report = [];
  const s = ctx.settings;
  report.push(step('Sync', s.enabled ? (s.dryRun ? 'warn' : 'ok') : 'warn', s.enabled ? (s.dryRun ? 'on, DRY RUN (nothing is written)' : 'on, live') : 'off'));
  report.push(step('Mode', 'info', `${s.currencyMode}${s.verifyWrites ? ', verify writes' : ''}`));
  report.push(step('This client sends', ctx.isActiveGM ? 'ok' : 'warn', ctx.isActiveGM ? 'active GM' : 'not the active GM — another GM client sends'));
  if (ctx.paused) report.push(step('Paused', 'warn', 'api.resume() to continue'));
  if (ctx.modules.ddbImporterDynamicSync) report.push(step('DDB Importer dynamic sync', 'fail', 'also on: changes would be sent twice'));
  report.push(step('Item Piles', ctx.modules.itemPiles ? 'ok' : 'info', ctx.modules.itemPiles ? 'active' : 'not active (other sheets still sync)'));

  if (!s.proxyUrl) {
    report.push(step('Proxy URL', 'fail', 'not set here or in ddb-sync'));
    return report;
  }
  try {
    const ping = await ctx.client.fetch(`${s.proxyUrl.replace(/\/+$/, '')}/ping`);
    report.push(step('Proxy', ping.ok ? 'ok' : 'fail', `${s.proxyUrl} answered ${ping.status}`));
  } catch (err) {
    report.push(step('Proxy', 'fail', `${s.proxyUrl} unreachable: ${err.message}`));
    return report;
  }

  if (!ctx.actors.length) report.push(step('Synced actors', 'warn', 'none — map characters in ddb-sync or set the party actor'));
  const seen = new Map();
  let firstCharacterId = null;
  for (const actor of ctx.actors) {
    const t = actor.target;
    const label = `${actor.name} → ${t.kind === 'party' ? `party of campaign ${t.container.id} via #${t.characterId}` : `#${t.characterId}`}`;
    if (t.kind === 'character') {
      if (seen.has(t.characterId)) report.push(step(label, 'warn', `same D&D Beyond character as ${seen.get(t.characterId)} — changes would be sent twice`));
      seen.set(t.characterId, actor.name);
      firstCharacterId ??= t.characterId;
    }
    if (!actor.hasCobalt) {
      report.push(step(label, 'fail', 'no cobalt cookie'));
      continue;
    }
    try {
      const data = await readCharacter(ctx.client, t.characterId);
      if (t.kind === 'party' && data.campaignId !== t.container.id) {
        report.push(step(label, 'fail', `carrier ${data.name} is in campaign ${data.campaignId ?? 'none'}, not ${t.container.id}`));
      } else {
        report.push(step(label, 'ok', `${data.name}: ${data.inventory.length} rows, campaign ${data.campaignId ?? 'none'}`));
      }
    } catch (err) {
      report.push(step(label, 'fail', err.message));
    }
  }

  if (ctx.party.actorId && !ctx.partyActorExists) report.push(step('Party actor', 'fail', `no actor with id ${ctx.party.actorId}`));
  if (ctx.party.actorId && !ctx.party.campaignId) report.push(step('Party actor', 'fail', 'no campaign id (here or in ddb-sync)'));

  if (firstCharacterId) {
    try {
      const defs = await ctx.loadItems(firstCharacterId);
      report.push(step('Item definitions', defs.length ? 'ok' : 'fail', `${defs.length} available for name matching`));
    } catch (err) {
      report.push(step('Item definitions', 'fail', err.message));
    }
  }
  return report;
}

/**
 * Live round trip. Writes only rows it creates and one copper it restores.
 * @param {{client, characterId:number, party:{campaignId}|null, index:Map, log?:Function}} opts
 */
export async function runSelfTest({ client, characterId, party, index, log = () => {} }) {
  const report = [];
  const created = []; // row ids to clean up
  const call = async (op, payload) => {
    const json = await client.call(characterId, op, payload);
    if (json?.success === false) throw new Error(`${op}: ${json.message ?? 'rejected'} (${json.ddbStatus ?? '?'})`);
    return json;
  };
  const rowOf = async (id) => (await readCharacter(client, characterId)).inventory.find((r) => r.id === id) ?? null;
  const attempt = async (name, fn) => {
    try {
      const detail = await fn();
      report.push(step(name, 'ok', detail ?? ''));
      return true;
    } catch (err) {
      report.push(step(name, 'fail', err.message));
      log('error', `Self-test "${name}": ${err.message}`);
      return false;
    }
  };

  let baseline;
  if (!(await attempt('Read character', async () => {
    baseline = await readCharacter(client, characterId);
    return `${baseline.name}, ${baseline.inventory.length} rows, campaign ${baseline.campaignId ?? 'none'}`;
  }))) return report;

  const definition =
    index?.get(normalizeName('Potion of Healing')) ?? [...(index?.values() ?? [])].find((d) => !d.isHomebrew) ?? null;
  let rowId = null;
  if (!definition) report.push(step('Add item', 'fail', 'no item definitions loaded'));
  else {
    const ok = await attempt(`Add ${definition.name}`, async () => {
      const json = await call('add', { equipment: [{ entityId: definition.id, entityTypeId: definition.entityTypeId, quantity: 1 }] });
      rowId = addedRows(json).find((r) => r.definitionId === definition.id)?.id ?? addedRows(json)[0]?.id ?? null;
      if (!rowId) {
        const after = await readCharacter(client, characterId);
        const fresh = after.inventory.filter((r) => r.definitionId === definition.id && !baseline.inventory.some((b) => b.id === r.id));
        rowId = fresh.at(-1)?.id ?? null;
        if (!rowId) throw new Error('added, but no new row found on the character');
        created.push(rowId);
        return `row #${rowId} (found by reading; the answer had no addItems)`;
      }
      created.push(rowId);
      const row = await rowOf(rowId);
      if (row?.quantity !== 1) throw new Error(`row #${rowId} reads quantity ${row?.quantity}`);
      return `row #${rowId}`;
    });
    if (ok) {
      await attempt('Change quantity 1 → 3', async () => {
        await call('quantity', { id: rowId, quantity: 3 });
        const row = await rowOf(rowId);
        if (row?.quantity !== 3) throw new Error(`reads ${row?.quantity}`);
      });
      await attempt('Remove item', async () => {
        await call('remove', { id: rowId, removeContainerContents: false });
        if (await rowOf(rowId)) throw new Error('still there');
        created.splice(created.indexOf(rowId), 1);
      });
    }
  }

  await attempt('Coins: +1 cp and back (absolute set?)', async () => {
    // Always all five coins: an omitted coin might be zeroed by D&D Beyond.
    const base = Object.fromEntries(COINS.map((c) => [c, Number(baseline.currencies?.[c]) || 0]));
    const dest = { destinationEntityId: characterId, destinationEntityTypeId: ENTITY_TYPES.CHARACTER };
    const purse = async () => {
      const now = (await readCharacter(client, characterId)).currencies ?? {};
      return Object.fromEntries(COINS.map((c) => [c, Number(now[c]) || 0]));
    };
    const differs = (a, b) => COINS.filter((c) => a[c] !== b[c]);
    const show = (p) => COINS.map((c) => `${p[c]} ${c}`).join(', ');

    const expected = { ...base, cp: base.cp + 1 };
    await call('currency', { ...expected, ...dest });
    const after = await purse();
    if (!differs(after, expected).length) {
      await call('currency', { ...base, ...dest });
      const restored = await purse();
      if (differs(restored, base).length) throw new Error(`restore failed: D&D Beyond shows ${show(restored)}, was ${show(base)} — fix by hand`);
      return 'absolute set confirmed, purse restored';
    }
    // Not an absolute set. If it added, the opposite amounts put the purse back.
    const additive = COINS.every((c) => after[c] === base[c] + expected[c]);
    if (additive) {
      await call('currency', { ...Object.fromEntries(COINS.map((c) => [c, base[c] - after[c]])), ...dest });
      const restored = await purse();
      const ok = !differs(restored, base).length;
      throw new Error(`the currency call ADDS instead of setting — set "How changes are applied" with care and report this. Purse ${ok ? 'restored' : `NOT restored (${show(restored)}, was ${show(base)}) — fix by hand`}`);
    }
    throw new Error(`unexpected purse after setting ${show(expected)}: ${show(after)} (was ${show(base)}) — check and fix by hand`);
  });

  let customId = null;
  if (await attempt('Add custom item', async () => {
    const json = await call('customItem', { name: 'DDB Inventory Sync test', description: 'Self-test, removed again.', quantity: 1, cost: null, weight: 0 });
    customId = addedRows(json)[0]?.id ?? null;
    const after = await readCharacter(client, characterId);
    if (!customId) {
      customId = after.inventory.find((r) => r.name === 'DDB Inventory Sync test' && !baseline.inventory.some((b) => b.id === r.id))?.id ?? null;
    }
    if (!customId) {
      const inCustom = (after.customItems ?? []).some((r) => r.name === 'DDB Inventory Sync test');
      throw new Error(inCustom ? 'created as a custom item but not as an inventory row — remove "DDB Inventory Sync test" by hand' : 'no row found');
    }
    created.push(customId);
    return `row #${customId}`;
  })) {
    await attempt('Custom item quantity 1 → 2', async () => {
      await call('quantity', { id: customId, quantity: 2 });
      const row = await rowOf(customId);
      if (row?.quantity !== 2) throw new Error(`reads ${row?.quantity}`);
    });
    await attempt('Remove custom item', async () => {
      await call('remove', { id: customId, removeContainerContents: false });
      if (await rowOf(customId)) throw new Error('still there');
      created.splice(created.indexOf(customId), 1);
    });
  }

  if (party?.campaignId) {
    const campaignId = Number(party.campaignId);
    if (baseline.campaignId !== campaignId) {
      report.push(step('Party inventory', 'warn', `${baseline.name} is in campaign ${baseline.campaignId ?? 'none'}, not ${campaignId} — test with a campaign member`));
    } else if (definition) {
      await attempt('Party inventory: add and remove', async () => {
        const json = await call('add', {
          equipment: [{ entityId: definition.id, entityTypeId: definition.entityTypeId, quantity: 1, containerEntityId: campaignId, containerEntityTypeId: ENTITY_TYPES.CAMPAIGN }]
        });
        const id = addedRows(json)[0]?.id;
        if (!id) throw new Error('added, but D&D Beyond returned no row id — check Party Inventory by hand and remove the test potion');
        await call('remove', { id, removeContainerContents: false });
        return `row #${id} added and removed — party coins are not touched by the self-test`;
      });
    }
  } else report.push(step('Party inventory', 'info', 'no party configured'));

  for (const id of created) {
    try {
      await call('remove', { id, removeContainerContents: false });
      report.push(step(`Cleanup row #${id}`, 'ok'));
    } catch (err) {
      report.push(step(`Cleanup row #${id}`, 'fail', `${err.message} — remove it by hand`));
    }
  }
  return report;
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderReport(title, report) {
  const fails = report.filter((r) => r.status === 'fail').length;
  const warns = report.filter((r) => r.status === 'warn').length;
  const rows = report.map((r) => `<li>${ICON[r.status] ?? ''} <b>${esc(r.name)}</b>${r.detail ? ` — ${esc(r.detail)}` : ''}</li>`).join('');
  return `<h3>${esc(title)}</h3><p>${fails ? `${fails} failed` : 'No failures'}${warns ? `, ${warns} warnings` : ''}</p><ul style="padding-left:1em">${rows}</ul>`;
}
