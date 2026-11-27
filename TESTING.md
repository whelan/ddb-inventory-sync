# Testing DDB Inventory Sync

Three levels, from no risk to a real character. Do them in order.

| Level | What it proves | Touches D&D Beyond? | Time |
|---|---|---|---|
| 1. `npm test` | All logic and 25+ table scenarios | No | 15 s |
| 2. Foundry against the mock | The module in your real world, Item Piles included | No | 15 min |
| 3. Live self-test + table check | D&D Beyond accepts the calls the way we assume | A **test** character | 15 min |

Every edge case and the test that covers it: [docs/EDGE-CASES.md](docs/EDGE-CASES.md).

---

## 1. Automated

```bash
npm test
```

`tests/core.test.js` covers the pure logic. `tests/glue.test.js` loads the real `scripts/main.js`
into a Foundry stand-in (`tests/foundry-fake.js`) and plays table situations (merchant purchase,
loot take, trade, import, player editing on D&D Beyond, outages) against
`tools/mock-proxy.js` over HTTP. The proxy side has its own suite in `whelan/ddb-proxy`
(`npm test`: real proxy process → mock D&D Beyond).

## 2. In Foundry, against the mock (no risk)

1. On the computer whose browser runs Foundry (also works for The Forge):
   ```bash
   npm run mock          # http://localhost:3999 — open it in a tab to watch
   ```
   Any cobalt is accepted; character ids are created on first use, so your existing ddb-sync
   mapping works as is.
2. In Foundry, **Module Settings → DDB Inventory Sync**:
   - *Proxy URL*: `http://localhost:3999`
   - *Enable sync*: on, *Dry run*: **off** (it is the mock)
3. *Run diagnostics* (settings button) → the GM whisper should show no ❌.
4. Play these with the status page open next to Foundry. Each line should show up there within a
   second:

   | # | Do in Foundry | Expect on the mock page |
   |---|---|---|
   | 1 | Buy a Potion of Healing from an Item Piles merchant | Potion row on the PC, gold down by the price |
   | 2 | Buy two more | Same row, quantity 3 (no second row) |
   | 3 | Sell one back | Quantity 2 |
   | 4 | On the mock page, *edit on DDB* the potion to 5 (a player did it on D&D Beyond), then buy one in Foundry | Quantity 6 — the player's change survives |
   | 5 | *set gp on DDB* to 3, then buy something for 1 gp | 2 gp |
   | 6 | Take everything from an Item Piles loot pile | Every item once; unknown names marked *(custom)* |
   | 7 | Give an item from one PC to another | Gone from the first, new row on the second |
   | 8 | Drop loot and coins on the party actor | Rows and coins under *Party inventory* |
   | 9 | Equip / attune a weapon | ✔ in the columns |
   | 10 | Re-import a character with DDB Importer | **No** calls (log: "looks like a character import") |
   | 11 | Press *Next 5 calls 503*, then buy something | Red rows, then a green one after the retries |
   | 12 | Press *Next call 400*, buy something | Error notification; `…api.retryFailed()` delivers it |
   | 13 | *Run live self-test* on a PC | All ✅ in the whisper; nothing left on the page |
   | 14 | Press *Toggle delta currency*, run the self-test again | ❌ "the currency call ADDS instead of setting", purse restored |

   Console helpers:
   ```js
   const api = game.modules.get('ddb-inventory-sync').api;
   api.log.slice(-20);   // what was sent, skipped, linked
   api.failed;           // failed operations
   api.retryFailed();
   api.pause(); api.resume();
   ```

## 3. Live, on a D&D Beyond TEST character

Use a throwaway character in the campaign (the self-test writes to it and cleans up).

1. Proxy: deploy `whelan/ddb-proxy` with `/proxy/inventory` and restart it.
2. *Proxy URL* back to your proxy (or empty to use ddb-sync's). Keep *Dry run* **on** for now.
3. Map the test character in ddb-sync. *Run diagnostics* → no ❌.
4. *Run live self-test* on the test character (it ignores dry run). It checks, on D&D Beyond:
   add/quantity/remove of a real item, that the coin call **sets** (and puts the purse back),
   a custom item, and add/remove in the party inventory. Anything ❌ is a finding — send me the
   whisper.
5. Turn *Dry run* off, then play rows 1–9 of the table above on the test character and compare
   with its D&D Beyond sheet instead of the mock page.
6. Only then enable it for the players' characters (*Run link* first, see the README).

### What the live run settles

These are the assumptions the mock cannot prove:

- [ ] The coin call sets values (self-test step *Coins*).
- [ ] Add answers with the new row (`addItems`) — if not, the module finds the row by reading.
- [ ] Quantity and remove work on custom items through the normal inventory calls.
- [ ] The party inventory accepts items through a member character.
- [ ] Your cobalt may write to a player's character — if not, store theirs with
      `api.setCharacterCobalt(id, cobalt)`.
