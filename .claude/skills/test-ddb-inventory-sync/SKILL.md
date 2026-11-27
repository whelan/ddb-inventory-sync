---
name: test-ddb-inventory-sync
description: Test DDB Inventory Sync end to end in a running Foundry world from a local Claude — play Item Piles merchant, loot, give, party and coin scenarios through foundry-mcp-bridge's run_macro against the mock D&D Beyond (or, only when Lars says so, a live test character), read the JSON report, inject faults and re-run. Use for "test the DDB sync", "kør scenarierne", "tjek at Item Piles synker til DDB", "/test-ddb-inventory-sync".
---

# Test DDB Inventory Sync through Foundry

You drive the module's own scenario runner. It uses Item Piles' API (`tradeItems`,
`transferItems`, `transferAllItems`, `addCurrencies`, `transferCurrencies`, `removeItems`) on a
synced test character, waits for the sync, and after every step checks that D&D Beyond matches
Foundry. It cleans up and returns a JSON report. You never write items to D&D Beyond yourself.

## Needs

- Foundry running with the GM logged in, and these modules active: DDB Inventory Sync, Item Piles, ddb-sync (for the
  character mapping), and the foundry-mcp-bridge module (the `mcp__foundry__*` tools are present).
- Lars has switched on **"Allow the bridge to run macros"** in the bridge module's settings. You
  cannot do this yourself. If `run_macro` answers `UNSUPPORTED`, ask him to turn it on, and
  remind him to turn it off afterwards.
- The world macro **`DDB Inventory Sync: Test`**. The module creates it on GM login (setting *Provide
  the test macro*). If `run_macro` answers `NOT_FOUND`, ask Lars to reload Foundry once.

## 1. Against the mock (default — no risk)

1. Start the mock **on the machine whose browser runs Foundry**. The browser calls it, not
   the bridge. Run it in the background from this repo:
   `npm run mock` → `http://localhost:3999` (status page at `/`, state at `/mock/state`).
2. Run every scenario and point the module at the mock in the same call:
   ```
   mcp__foundry__run_macro {
     name: "DDB Inventory Sync: Test",
     timeoutMs: 300000,
     args: {
       configure: { proxyUrl: "http://localhost:3999", enabled: true, dryRun: false },
       actor: "<a synced PC>"            // optional against the mock
     }
   }
   ```
3. Read `result.ok` and `result.steps` (`{ name, status: ok|warn|fail|info, detail }`).
   `result.log` holds the module's last log lines. The same report is whispered to the GM; read it
   with `mcp__foundry__get_chat_log` if you lost the result.
4. On a ❌, look at the mock: `curl -s localhost:3999/mock/state | jq '.calls[-15:]'` shows what
   was sent and what came back. `docs/EDGE-CASES.md` lists the expected behaviour and the unit
   test for each situation. If you change code, run `npm test` before you trust a fix.

### Narrower runs and fault injection

- `args.only`: any of `"buy"`, `"sell"`, `"loot"`, `"use"`, `"playerEdit"`, `"give"`, `"party"`.
  The 250 gp pocket-money step always runs first.
- `args.keep: true` leaves the fixtures (merchant, loot pile) and the items in place so you can inspect them.
- `args.otherActor: "<name>"` picks the receiver for the give step.
- Faults go to the mock, then you re-run:
  ```bash
  curl -s -XPOST localhost:3999/mock/fail   -d '{"status":503,"count":2}'   # transient: retried, steps should pass
  curl -s -XPOST localhost:3999/mock/fail   -d '{"status":400,"count":1,"op":"add"}'  # rejected: a step should fail
  curl -s -XPOST localhost:3999/mock/config -d '{"dropRowIds":true}'        # add without row ids: should still pass
  curl -s -XPOST localhost:3999/mock/config -d '{"currencyIsDelta":true}'   # wrong coin semantics: coin steps must fail
  curl -s -XPOST localhost:3999/mock/config -d '{"latencyMs":1500}'         # slow D&D Beyond
  curl -s -XPOST localhost:3999/mock/reset
  ```
  Reset `/mock/config` afterwards (`{"dropRowIds":false,"currencyIsDelta":false,"latencyMs":0}`).
- `configure.currencyMode: "absolute"` runs the scenarios in absolute mode. In that mode the
  *Player edits* step reports `info` rather than `ok`, which is expected.

### Other read-only checks

- *Diagnostics* has no macro of its own. Lars clicks **Run diagnostics** in the module
  settings, and you read the whisper with `get_chat_log`.

## 2. Live, on a D&D Beyond test character (only when Lars asks)

This writes to a real character on D&D Beyond (and removes it all again). Never use a player's
character. Always name the actor explicitly.

```
mcp__foundry__run_macro {
  name: "DDB Inventory Sync: Test",
  timeoutMs: 600000,
  args: { live: true, actor: "<test character Lars named>", configure: { proxyUrl: "", enabled: true, dryRun: false } }
}
```

`proxyUrl: ""` falls back to ddb-sync's real proxy. Without `live: true` and `actor`, the runner
refuses to touch a real proxy. The *Player edits* step runs only against the mock. On a live
run, also ask Lars to run **Run live self-test** from the settings and paste the whisper. That
self-test checks the coin call semantics directly.

## 3. Leave it as you found it

After testing, ask Lars which state he wants. The usual choice is the real proxy with dry run on:
`configure: { proxyUrl: "", dryRun: true }`. You can apply it with a run that executes no scenarios:
`args: { only: [], configure: {...}, chat: false }`. Stop the mock process, and remind him to
switch off *Allow the bridge to run macros*.

## Rules

- Never call the D&D Beyond proxy directly with write ops. Only the runner writes, and only to a
  test character.
- Never uncheck the safety flags: no `live: true` without Lars naming the test character in this
  conversation.
- Report failures verbatim (`name — detail`) and do not paraphrase them into "mostly works".
