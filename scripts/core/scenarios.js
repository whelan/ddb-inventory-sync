/**
 * Scenario runner: plays real table situations through Item Piles' own API
 * (merchant buy and sell, loot pile take, give, party stash, coins) on a
 * synced test character, and after every step checks that D&D Beyond
 * matches Foundry. Cleans up after itself. Built to be driven by a local
 * Claude through foundry-mcp-bridge's `run_macro`:
 *
 *   run_macro { name: "DDB Inventory Sync: Test", args: { actor: "Ireena" } }
 *
 * It returns { ok, mode, steps: [{ name, status, detail }], log } as plain JSON.
 *
 * Safety: against the mock (`npm run mock`) it runs on its own. Against a real
 * proxy it needs `live: true` AND an explicit `actor`, because it writes to
 * that character on D&D Beyond (and removes it all again).
 *
 * Every Foundry / Item Piles dependency comes in through `deps`, so the runner
 * itself is tested against a fake Foundry and a fake Item Piles.
 */
import { COINS } from './constants.js';

export const SCENARIO_ITEMS = {
  potion: { name: 'Potion of Healing', type: 'consumable', system: { quantity: 1, price: { value: 50, denomination: 'gp' } } },
  dagger: { name: 'Dagger', type: 'weapon', system: { quantity: 1, price: { value: 2, denomination: 'gp' } } },
  torch: { name: 'Torch', type: 'consumable', system: { quantity: 3, price: { value: 1, denomination: 'cp' } } },
  trinket: { name: 'DDB Sync Test Trinket', type: 'loot', system: { quantity: 1, price: { value: 1, denomination: 'gp' }, description: { value: '<p>Created by the DDB Inventory Sync scenario test.</p>' } } }
};
const TEST_NAMES = new Set(Object.values(SCENARIO_ITEMS).map((i) => i.name));

/**
 * @param {object} args  { actor?, otherActor?, live?, only?: string[], keep?: boolean }
 * @param {object} deps  see buildScenarioDeps() in main.js
 */
export async function runScenarios(args = {}, deps) {
  const steps = [];
  const out = (name, status, detail = '') => {
    steps.push({ name, status, detail });
    deps.log(status === 'fail' ? 'error' : 'info', `Scenario "${name}": ${status}${detail ? ` — ${detail}` : ''}`);
  };
  const result = (extra = {}) => ({
    ok: !steps.some((s) => s.status === 'fail'),
    steps,
    ...extra
  });

  // --- preflight -------------------------------------------------------------
  const s = deps.settings();
  if (!s.enabled) out('Preflight', 'fail', 'sync is disabled — enable it first');
  if (s.dryRun) out('Preflight', 'fail', 'dry run is on — scenarios need real writes (to the mock or a test character)');
  if (!deps.isActiveGM()) out('Preflight', 'fail', 'run this on the active GM client');
  if (deps.paused()) out('Preflight', 'fail', 'sync is paused (api.resume())');
  if (steps.length) return result({ mode: 'none' });

  const mock = await deps.isMock();
  const mode = mock ? 'mock' : 'live';
  if (!mock && (args.live !== true || !args.actor)) {
    out('Preflight', 'fail', 'the proxy is not the mock: pass { live: true, actor: "<test character>" } to write to a real D&D Beyond character');
    return result({ mode });
  }
  const pc = args.actor ? deps.findActor(args.actor) : deps.syncedCharacters()[0];
  const pcTarget = pc && deps.targetFor(pc);
  if (!pc || pcTarget?.kind !== 'character') {
    out('Preflight', 'fail', `${args.actor ?? 'no synced character'} is not a synced character`);
    return result({ mode });
  }
  const other = args.otherActor ? deps.findActor(args.otherActor) : deps.syncedCharacters().find((a) => a !== pc && deps.targetFor(a)?.characterId !== pcTarget.characterId);
  const party = deps.partyActor();
  const piles = deps.itemPiles();
  out('Preflight', 'ok', `${mode}; test character ${pc.name} (#${pcTarget.characterId})${other ? `, other ${other.name}` : ''}${party ? `, party ${party.name}` : ''}; ${piles ? 'Item Piles API' : 'NO Item Piles — plain Foundry operations'}`);

  const leftovers = [...pc.items].filter((i) => TEST_NAMES.has(i.name));
  if (leftovers.length) {
    out('Preflight', 'fail', `${pc.name} already carries ${leftovers.map((i) => i.name).join(', ')} — remove them (or use another test character) so the checks are exact`);
    return result({ mode });
  }

  const want = (key) => !args.only || args.only.includes(key);
  const fixtures = [];
  const ddbBase = await deps.readDdb(pcTarget.characterId);
  const foundryBase = purse(pc.system?.currency);
  let failedBefore = deps.failed().length;

  // --- the invariant ------------------------------------------------------------
  /** After a step: every test item on the PC has a D&D Beyond row with the same stack; coins moved by the same amount. */
  const check = async (name, expect = {}) => {
    await deps.settle();
    const problems = [];
    const ddb = await deps.readDdb(pcTarget.characterId);
    const items = [...pc.items].filter((i) => TEST_NAMES.has(i.name));
    for (const item of items) {
      const rowId = deps.rowIdOf(item);
      const row = rowId && ddb.inventory.find((r) => r.id === rowId);
      if (!row) problems.push(`${item.name} has no D&D Beyond row`);
      else if (row.quantity !== deps.quantityOf(item)) problems.push(`${item.name}: Foundry ${deps.quantityOf(item)}, D&D Beyond ${row.quantity}`);
    }
    const ownRows = new Set(items.map((i) => deps.rowIdOf(i)).filter(Boolean));
    const strays = ddb.inventory.filter((r) => TEST_NAMES.has(r.name) && !ownRows.has(r.id) && !ddbBase.inventory.some((b) => b.id === r.id));
    if (strays.length) problems.push(`extra D&D Beyond rows: ${strays.map((r) => `${r.name} #${r.id}`).join(', ')}`);
    const fNow = purse(pc.system?.currency);
    const dNow = purse(ddb.currencies);
    const dBase = purse(ddbBase.currencies);
    const off = COINS.filter((c) => fNow[c] - foundryBase[c] !== dNow[c] - dBase[c]);
    if (off.length) problems.push(`coins moved differently: ${off.map((c) => `${c} Foundry ${signed(fNow[c] - foundryBase[c])}, D&D Beyond ${signed(dNow[c] - dBase[c])}`).join('; ')}`);
    for (const [label, fn] of Object.entries(expect)) {
      const msg = fn(ddb);
      if (msg) problems.push(`${label}: ${msg}`);
    }
    const fresh = deps.failed().slice(failedBefore);
    if (fresh.length) problems.push(`${fresh.length} failed sync operation(s): ${fresh.map((f) => f.error).join(' | ')}`);
    failedBefore += fresh.length;
    out(name, problems.length ? 'fail' : 'ok', problems.join('; ') || summary(items, deps));
    return !problems.length;
  };

  const ops = itemOps(piles, deps);
  let merchant;
  let pile;
  try {
    // --- fixtures ---------------------------------------------------------------
    merchant = await deps.createActor({ name: 'DDB Sync Test Merchant', type: 'npc' });
    fixtures.push(merchant);
    await deps.createItems(merchant, [{ ...SCENARIO_ITEMS.potion, system: { ...SCENARIO_ITEMS.potion.system, quantity: 10 } }, { ...SCENARIO_ITEMS.dagger, system: { ...SCENARIO_ITEMS.dagger.system, quantity: 5 } }]);
    pile = await deps.createActor({ name: 'DDB Sync Test Loot', type: 'npc' });
    fixtures.push(pile);
    await deps.createItems(pile, [SCENARIO_ITEMS.torch, SCENARIO_ITEMS.trinket]);
    if (piles) {
      await piles.updateItemPile(merchant, { enabled: true, type: 'merchant' }).catch((e) => out('Fixtures', 'warn', `merchant flags: ${e.message}`));
      await piles.updateItemPile(pile, { enabled: true, type: 'pile' }).catch((e) => out('Fixtures', 'warn', `loot pile flags: ${e.message}`));
    }
    out('Fixtures', 'ok', 'merchant with potions and daggers, loot pile with torches and a trinket');

    // --- scenarios ---------------------------------------------------------------
    await ops.addCoins(pc, { gp: 250 }); // pocket money for the purchases, taken back in cleanup
    await check('Coins: GM gives 250 gp');
    if (want('buy')) {
      await ops.buy(merchant, pc, 'Potion of Healing', 1);
      await check('Merchant: buy a Potion of Healing', { 'one row': rowsNamed('Potion of Healing', 1, ddbBase) });
      await ops.buy(merchant, pc, 'Potion of Healing', 1);
      await check('Merchant: buy another — same stack', { 'one row': rowsNamed('Potion of Healing', 1, ddbBase) });
    }
    if (want('sell') && pcItem(pc, 'Potion of Healing')) {
      await ops.sell(pc, merchant, 'Potion of Healing', 1);
      await check('Merchant: sell one back');
    }
    if (want('loot')) {
      await ops.takeAll(pile, pc);
      await check('Loot pile: take everything (torches + a custom item)', {
        custom: (ddb) => (ddb.inventory.some((r) => r.name === 'DDB Sync Test Trinket') ? null : 'the trinket was not created as a custom item')
      });
    }
    if (want('use') && pcItem(pc, 'Torch')) {
      const torch = pcItem(pc, 'Torch');
      await deps.updateItem(torch, { system: { quantity: deps.quantityOf(torch) - 1 } });
      await check('Use a torch (stack 3 → 2)');
    }
    if (want('playerEdit') && mock && pcItem(pc, 'Potion of Healing')) {
      const potion = pcItem(pc, 'Potion of Healing');
      const rowId = deps.rowIdOf(potion);
      const before = deps.quantityOf(potion);
      await deps.mockEdit({ characterId: pcTarget.characterId, rowId, quantity: before + 2 }); // the player adds 2 on D&D Beyond
      await ops.buy(merchant, pc, 'Potion of Healing', 1);
      await deps.settle();
      const row = (await deps.readDdb(pcTarget.characterId)).inventory.find((r) => r.id === rowId);
      const expected = before + 3;
      const deltaOk = row?.quantity === expected;
      out('Player edits on D&D Beyond, then buys in Foundry', deltaOk ? 'ok' : s.currencyMode === 'delta' ? 'fail' : 'info', `D&D Beyond ${row?.quantity}, expected ${expected} in delta mode (Foundry ${deps.quantityOf(potion)})`);
      if (row) await deps.mockEdit({ characterId: pcTarget.characterId, rowId, quantity: deps.quantityOf(potion) }); // back in step
    }
    if (want('give') && other) {
      await ops.buy(merchant, pc, 'Dagger', 1);
      await check('Merchant: buy a Dagger');
      const otherTarget = deps.targetFor(other);
      const otherBefore = (await deps.readDdb(otherTarget.characterId)).inventory.filter((r) => r.name === 'Dagger').length;
      await ops.give(pc, other, 'Dagger', 1);
      await check(`Give the Dagger to ${other.name}`);
      const otherAfter = (await deps.readDdb(otherTarget.characterId)).inventory.filter((r) => r.name === 'Dagger').length;
      out(`${other.name} received the Dagger on D&D Beyond`, otherAfter === otherBefore + 1 ? 'ok' : 'fail', `${otherBefore} → ${otherAfter} Dagger rows`);
      const given = pcItem(other, 'Dagger');
      if (given) await ops.remove(other, given, deps.quantityOf(given));
      await deps.settle();
    } else if (want('give')) out('Give to another character', 'info', 'no second synced character');

    if (want('party') && party) {
      const before = mock ? await deps.mockParty() : null;
      await ops.give(pc, party, 'DDB Sync Test Trinket', 1);
      await ops.moveCoins(pc, party, { gp: 5 });
      await check('Party stash: trinket and 5 gp from the character');
      if (mock) {
        const after = await deps.mockParty();
        const gotItem = after.inventory.some((r) => r.name === 'DDB Sync Test Trinket');
        out('Party inventory on D&D Beyond', gotItem ? 'ok' : 'fail', `trinket ${gotItem ? 'present' : 'missing'}; party gp ${before?.currencies?.gp ?? 0} → ${after.currencies?.gp ?? 0} (party coins are set absolutely from the party actor)`);
      } else out('Party inventory on D&D Beyond', 'info', 'cannot be read through a character — look at Party Inventory in the campaign');
      const back = pcItem(party, 'DDB Sync Test Trinket');
      if (back) await ops.remove(party, back, deps.quantityOf(back));
      await ops.moveCoins(party, pc, { gp: 5 }).catch(() => {});
      await deps.settle();
    } else if (want('party')) out('Party stash', 'info', 'no party actor configured');
  } catch (err) {
    out('Scenario run', 'fail', `stopped: ${err.message}`);
  } finally {
    // --- cleanup -------------------------------------------------------------------
    if (!args.keep) {
      try {
        for (const item of [...pc.items].filter((i) => TEST_NAMES.has(i.name))) await ops.remove(pc, item, deps.quantityOf(item));
        await deps.setCoins(pc, foundryBase);
        await deps.settle();
        for (const actor of fixtures) await deps.deleteActor(actor);
        const ddb = await deps.readDdb(pcTarget.characterId);
        const strays = ddb.inventory.filter((r) => TEST_NAMES.has(r.name) && !ddbBase.inventory.some((b) => b.id === r.id));
        const dNow = purse(ddb.currencies);
        const dBase = purse(ddbBase.currencies);
        const off = COINS.filter((c) => dNow[c] !== dBase[c]);
        out(
          'Cleanup: D&D Beyond back to where it was',
          strays.length || off.length ? 'fail' : 'ok',
          [strays.length ? `left: ${strays.map((r) => `${r.name} #${r.id}`).join(', ')}` : '', off.length ? `coins differ: ${off.map((c) => `${c} ${dNow[c]}≠${dBase[c]}`).join(', ')}` : ''].filter(Boolean).join('; ')
        );
      } catch (err) {
        out('Cleanup', 'fail', `${err.message} — check ${pc.name} on D&D Beyond by hand`);
      }
    } else out('Cleanup', 'info', 'keep: true — fixtures and items left in place');
  }
  return result({ mode, character: pc.name, log: deps.recentLog() });
}

// --- helpers -------------------------------------------------------------------

function purse(c) {
  return Object.fromEntries(COINS.map((k) => [k, Math.floor(Number(c?.[k]) || 0)]));
}
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const pcItem = (actor, name) => [...actor.items].find((i) => i.name === name) ?? null;

function rowsNamed(name, count, base) {
  return (ddb) => {
    const n = ddb.inventory.filter((r) => r.name === name && !base.inventory.some((b) => b.id === r.id)).length;
    return n === count ? null : `${n} rows named ${name}, expected ${count}`;
  };
}

function summary(items, deps) {
  return items.length ? items.map((i) => `${i.name} ×${deps.quantityOf(i)}`).join(', ') : 'no test items on the character';
}

const coinString = (coins) => Object.entries(coins).map(([c, n]) => `${n}${c}`).join(' ');

/** Item Piles when present, plain Foundry document operations otherwise. */
function itemOps(piles, deps) {
  const find = (actor, name) => {
    const item = pcItem(actor, name);
    if (!item) throw new Error(`${actor.name} has no ${name}`);
    return item;
  };
  if (piles) {
    return {
      addCoins: (actor, coins) => piles.addCurrencies(actor, coinString(coins)),
      moveCoins: (from, to, coins) => piles.transferCurrencies(from, to, coinString(coins)),
      buy: (merchant, buyer, name, quantity) => piles.tradeItems(merchant, buyer, [{ item: find(merchant, name), quantity }]),
      sell: (seller, merchant, name, quantity) => piles.tradeItems(seller, merchant, [{ item: find(seller, name), quantity }]),
      takeAll: (pile, actor) => piles.transferAllItems(pile, actor),
      give: (from, to, name, quantity) => piles.transferItems(from, to, [{ _id: find(from, name).id, quantity }]),
      remove: (actor, item, quantity) => piles.removeItems(actor, [{ _id: item.id, quantity }])
    };
  }
  // Without Item Piles: the same document changes Item Piles would make.
  const price = (item) => {
    const p = item.system?.price ?? {};
    return { [p.denomination ?? 'gp']: Number(p.value) || 0 };
  };
  const shift = async (actor, coins, sign) => {
    const now = purse(actor.system?.currency);
    for (const [c, n] of Object.entries(coins)) now[c] = Math.max(0, now[c] + sign * n);
    await deps.setCoins(actor, now);
  };
  const receive = async (actor, item, quantity) => {
    const existing = pcItem(actor, item.name);
    if (existing) await deps.updateItem(existing, { system: { quantity: deps.quantityOf(existing) + quantity } });
    else await deps.createItems(actor, [{ ...deps.itemData(item), system: { ...deps.itemData(item).system, quantity } }]);
  };
  const lose = async (actor, item, quantity) => {
    const left = deps.quantityOf(item) - quantity;
    if (left > 0) await deps.updateItem(item, { system: { quantity: left } });
    else await deps.deleteItem(item);
  };
  return {
    addCoins: (actor, coins) => shift(actor, coins, +1),
    moveCoins: async (from, to, coins) => {
      await shift(from, coins, -1);
      await shift(to, coins, +1);
    },
    buy: async (merchant, buyer, name, quantity) => {
      const item = find(merchant, name);
      await receive(buyer, item, quantity);
      await shift(buyer, Object.fromEntries(Object.entries(price(item)).map(([c, n]) => [c, n * quantity])), -1);
      await lose(merchant, item, quantity);
    },
    sell: async (seller, merchant, name, quantity) => {
      const item = find(seller, name);
      await receive(merchant, item, quantity);
      await shift(seller, Object.fromEntries(Object.entries(price(item)).map(([c, n]) => [c, Math.floor((n * quantity) / 2)])), +1);
      await lose(seller, item, quantity);
    },
    takeAll: async (pile, actor) => {
      for (const item of [...pile.items]) {
        await receive(actor, item, deps.quantityOf(item));
        await deps.deleteItem(item);
      }
    },
    give: async (from, to, name, quantity) => {
      const item = find(from, name);
      await receive(to, item, quantity);
      await lose(from, item, quantity);
    },
    remove: (actor, item, quantity) => lose(actor, item, quantity)
  };
}
