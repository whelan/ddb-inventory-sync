---
name: test-ddb-inventory-sync
description: Run DDB Inventory Sync's test plan (docs/TEST-PLAN.md) from a local Claude — local Foundry against the mock, then a D&D Beyond test campaign, then The Forge with a second campaign — through foundry-mcp-bridge's run_macro, with hot reload so Foundry and the proxy never need a manual reload. Use for "kør testplanen", "test the DDB sync", "fase 1/2/3", "tjek at Item Piles synker til DDB", "/test-ddb-inventory-sync".
---

# Run the DDB Inventory Sync test plan

`docs/TEST-PLAN.md` is the plan: phases, what Lars sets up, and the exit criteria. This skill is
how you execute it. You drive two world macros through `mcp__foundry__run_macro` (both are
created by the module on GM login):

- **`DDB Inventory Sync: Dev`** — `args.action`:
  - `status`: the runtime source and build, settings, mapping, synced actors, and pending/failed counts
  - `configure` `{ module: {...}, ddbSync: { proxyUrl, campaignId, mapping: { "<ddbId>": "<actor name>"|null } } }`
  - `reload`: hot-swaps the runtime from the dev server; a broken build is refused
  - `reloadPage`: the last resort, for bootstrap changes
  - `diagnose`, `selfTest` `{ actor, party }`, `scenarios` (same args as the Test macro)
  - `log` `{ lines }`, `failed`, `retryFailed`
- **`DDB Inventory Sync: Test`** — the Item Piles scenario runner (`actor`, `otherActor`,
  `live`, `only`, `keep`, `configure`).

Every call returns JSON with `ok`. Use `timeoutMs: 300000` for scenarios (600000 when live).

## Before anything

1. `mcp__foundry__get_world_info` works, which means the bridge is connected. If not: is Foundry open in Chrome as GM,
   and is `RELAY_TOKEN` exported? Ask Lars.
2. Dev `status`. `NOT_FOUND` means the module is not loaded or the macro is missing: ask Lars to reload once.
   `UNSUPPORTED` means *Allow the bridge to run macros* is off: ask Lars.
3. Background processes. Start them with `run_in_background` and check they are up:
   - module dev server: `npm run dev` here, then `curl -s localhost:3997/status`
   - mock (phase 1): `npm run mock`, then `curl -s localhost:3999/ping`
   - real proxy (phases 2–3): `npm run dev` in `../ddb-proxy`, then `curl -s localhost:3000/ping`
   Run `npm install` once in each repo first if `node_modules` is missing.
4. Test actors: create them with `mcp__foundry__create_document` if missing. You need *Test Hero A*
   and *Test Hero B* (`type: "character"`) and *Test Party* (`type: "group"`). Never use a player's actor.

## The fix loop (no reloads)

1. A step fails. Read its `detail`, Dev `log`, Dev `failed`, and on the mock
   `curl -s localhost:3999/mock/state | jq '.calls[-15:]'`.
2. Find the cause in the code. Check `docs/EDGE-CASES.md` for the intended behaviour, and add or adjust a test in
   `tests/` that reproduces it. `npm test` must fail before the fix and pass after.
3. Save. The dev server rebuilds. Wait for the build:
   `curl -s "localhost:3997/wait?after=<build from /status>"` and confirm `ok: true`.
4. Dev `reload`, then check `status.runtime.build` equals the new build.
5. Re-run the failing step, then the whole phase.
6. Proxy fixes: edit `../ddb-proxy`, and `node --watch` restarts it by itself. Run its `npm test`.
7. Commit on the branch with a clear message once green. Never push without Lars's say-so.

Changes to `scripts/main.js` (the bootstrap) or `scripts/settings.js` need Dev `reloadPage`, or
for new settings a `reload` re-registers them. `module.json` changes need Lars to restart Foundry.

## Phase 1 — mock (you run it alone)

The configure call and the eight checks are in TEST-PLAN.md § Phase 1. Mock fault knobs:
```bash
curl -s -XPOST localhost:3999/mock/fail   -d '{"status":503,"count":2}'
curl -s -XPOST localhost:3999/mock/fail   -d '{"status":400,"count":1,"op":"add"}'
curl -s -XPOST localhost:3999/mock/config -d '{"dropRowIds":true}'        # reset: false
curl -s -XPOST localhost:3999/mock/config -d '{"latencyMs":1500}'         # reset: 0
curl -s -XPOST localhost:3999/mock/config -d '{"currencyIsDelta":true}'   # reset: false
curl -s -XPOST localhost:3999/mock/reset
```
Reset each fault before the next one. The mock auto-creates characters by id, so mapping
`111`/`222` to the test heroes is enough.

## Phases 2 and 3 — real D&D Beyond

Start only when Lars has given the campaign and character ids and says the cookie is in place.
`configure.module.cobalt` accepts only `"MOCK"` or `""`. Set `""` so the real cookie is used. You
never see, ask for, or set a real cookie. Live writes go only to the character Lars named, and
the scenario runner refuses a real proxy without `live: true` and `actor`. The rest of the steps
are in TEST-PLAN.md.

The open assumptions the phase 2 self-test settles. Record each in the report:
coin call sets or adds · `addItems` in the add answer · custom item quantity/remove via the
inventory calls · party inventory via a member · whether the GM cookie may write to the character.

## Reports

Save every phase to `test-runs/<YYYY-MM-DD>-phase<N>.md` (gitignored):
- the Dev `status` you started from
- every report as a table (`name | status | detail`)
- the fault matrix
- the fixes you made, with their commits

Quote failures verbatim. A phase is done only when its exit criteria in TEST-PLAN.md are all green.

## Leave it as found

At the end ask Lars what to leave. The default is
`configure: { module: { dryRun: true, devRuntimeUrl: "" } }` plus `reloadPage`. Then stop your
background processes and remind him to switch off *Allow the bridge to run macros*.
