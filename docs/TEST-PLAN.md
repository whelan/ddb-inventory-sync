# Test plan — local Foundry, then The Forge

Lars sets things up; the **local Claude runs every test** and fixes what fails. Code changes reach
the running Foundry without reloading it, and the proxy restarts itself.

| Phase | Foundry | D&D Beyond | Lars does | Claude does |
|---|---|---|---|---|
| 0 | local test world | — | one-time setup (below) | checks the setup |
| 1 | local | **mock** | nothing | full run, fault injection, fixes |
| 2 | local | **campaign A**, character A | creates them, enters the cookie, gives the ids | self-test + scenarios live, fixes |
| 3 | **The Forge**, new world | **campaign B**, character B (+ A) | creates them, installs the module, gives the ids | the same, plus two campaigns in one world |

Each phase ends with a green report saved under `test-runs/`. Claude moves on only after that.

## How "no reloading" works

| Piece | During development | What triggers a reload |
|---|---|---|
| Module code | `npm run dev` rebuilds `scripts/runtime.js` on every save and serves it on `http://localhost:3997/runtime.js`. With the client setting *Dev runtime URL* pointing there, the Dev macro's `reload` swaps the running code in place: old hooks go, new hooks come, and row ids survive in item flags. The same works on The Forge, because the browser fetches from localhost. | Claude, through `run_macro` — never Lars |
| Proxy | Claude runs `npm run dev` in `ddb-proxy` (`node --watch`). It restarts on save. | automatic |
| Mock D&D Beyond | Claude runs `npm run mock` (or `mock:watch`). | automatic or a restart by Claude |
| Bootstrap (`scripts/main.js`, `module.json`) | Rarely changes. | Dev macro `reloadPage` (Claude); a Foundry restart only for `module.json` |

A broken build is refused, and the running code keeps going until a good build arrives.

---

## Phase 0 — one-time setup (Lars)

Folder layout: one parent folder that holds the repos side by side.

```
<code>/
  foundry-mcp-bridge/     (already there)
  ddb-inventory-sync/     git clone https://github.com/whelan/ddb-inventory-sync
                          git checkout claude/zealous-rubin-iyhob2   (until merged)
  ddb-proxy/              git clone https://github.com/whelan/ddb-proxy
                          git checkout claude/zealous-rubin-iyhob2   (until merged)
  cos-rework/             (already there)
```

1. **Link the module into the local Foundry.** Foundry must be stopped while you do this.
   - macOS: `ln -s "<code>/ddb-inventory-sync" "$HOME/Library/Application Support/FoundryVTT/Data/modules/ddb-inventory-sync"`
   - Linux: `ln -s "<code>/ddb-inventory-sync" "$HOME/.local/share/FoundryVTT/Data/modules/ddb-inventory-sync"`
   - Windows (admin cmd): `mklink /D "%LOCALAPPDATA%\FoundryVTT\Data\modules\ddb-inventory-sync" "<code>\ddb-inventory-sync"`

   (Your *User Data Path* is shown in Foundry's Setup → Configuration. Use it if it differs.)
2. **Start Foundry and open the test world** (dnd5e 5.x or 6.x, Foundry 13 or 14). Enable these modules:
   **DDB Inventory Sync**, **Item Piles** + **Item Piles: D&D 5e**, **ddb-sync**, **Foundry MCP Bridge (whelan)**.
3. **Configure the bridge module**: relay URL `ws://localhost:8787`, relay token (the same one you
   export below), and **Allow the bridge to run macros: ON** (only in the test world).
4. **Log in as GM in Chrome** and keep the tab open while Claude tests.
5. **Start Claude in `ddb-inventory-sync`**:
   ```bash
   cd <code>/ddb-inventory-sync
   export RELAY_TOKEN=<the bridge token>
   claude
   ```
   The repo's `.mcp.json` starts the bridge from `../foundry-mcp-bridge`. Then say:
   *"Kør testplanen, fase 1"* (skill `test-ddb-inventory-sync`).

Claude creates the test actors itself (two PCs and a party actor) and sets every setting through
the Dev macro. You do not need to create them.

## Phase 1 — local Foundry + mock (Claude)

Setup Claude does:
```
npm install                    (both repos, once)
npm run dev        &           (module dev server, :3997)
npm run mock       &           (mock D&D Beyond, :3999)
run_macro "DDB Inventory Sync: Dev" { action: "configure",
  module:  { devRuntimeUrl: "http://localhost:3997/runtime.js", proxyUrl: "http://localhost:3999",
             cobalt: "MOCK", enabled: true, dryRun: false, partyActorId: "<Test Party id>", partyCampaignId: "999" },
  ddbSync: { campaignId: "999", mapping: { "111": "Test Hero A", "222": "Test Hero B" } } }
```

Then, each must be green:
1. `npm test` in both repos.
2. Dev `status`: the runtime source is `dev`, the build matches the dev server's `/status`, and both PCs and the party are synced.
3. Dev `diagnose`: no `fail`.
4. Dev `selfTest` on Test Hero A: no `fail`, nothing left behind on the mock.
5. Test macro, all scenarios: `ok: true`.
6. Fault matrix. Set each fault on the mock, re-run the scenarios, and compare with the expected outcome:

   | Mock fault | Expected |
   |---|---|
   | `fail {status:503,count:2}` | all green (retried) |
   | `fail {status:400,count:1,op:"add"}` | one step ❌, then Dev `retryFailed` → re-run green |
   | `config {dropRowIds:true}` | all green |
   | `config {latencyMs:1500}` | all green, just slower |
   | `config {currencyIsDelta:true}` | coin steps ❌ (the runner must catch it) |

7. **Hot reload works:** Claude changes something harmless (a log line), waits for the dev
   server's `/wait`, runs Dev `reload`, sees the new build in `status` and the new log line, and
   runs the scenarios green again.
8. **Installed code works:** set `devRuntimeUrl: ""`, run Dev `reloadPage`, and run the scenarios
   green again on the module files as installed.

Report: `test-runs/<date>-phase1.md` (all JSON reports + the fault matrix table).

## Phase 2 — local Foundry + D&D Beyond campaign A (Lars, then Claude)

Lars:
1. On D&D Beyond, create campaign **"DDB Sync Test A"** and one character **A** in it, owned
   by your account. A second character there is a bonus for the give step.
2. Paste your **cobalt cookie** into ddb-sync's settings in the test world (or into DDB Inventory
   Sync's *cobalt cookie* field). Claude never handles it.
3. Tell Claude the **campaign id** and the **character id(s)** (the numbers in the D&D Beyond URLs).

Claude:
```
(cd ../ddb-proxy && npm install && npm run dev) &      (real proxy on :3000, auto-restart)
run_macro Dev { action: "configure",
  module:  { proxyUrl: "http://localhost:3000", cobalt: "", partyCampaignId: "<A>" },
  ddbSync: { campaignId: "<A>", mapping: { "<char A>": "Test Hero A", "111": null, "222": null } } }
```
Each must be green:
1. Dev `diagnose`: no `fail`. The carrier is in campaign A.
2. Dev `selfTest` on Test Hero A. This settles the open assumptions: coins **set** (not add),
   `addItems` comes back, custom items take quantity and remove, the party inventory accepts
   items, and your cookie may write.
3. Test macro `{ live: true, actor: "Test Hero A" }`: all scenarios `ok` (the *player edits* step runs only against the mock).
4. Lars glances at character A's D&D Beyond sheet afterwards: no test items, the same coins.

When something fails here, Claude fixes it, the dev server and the proxy pick the change up, and
Claude re-runs. No reloads.

Report: `test-runs/<date>-phase2.md`.

## Phase 3 — The Forge + campaign B (Lars, then Claude)

Lars:
1. On D&D Beyond, create campaign **"DDB Sync Test B"** with a **new character B**. If you can,
   make B on a **second D&D Beyond account** that is a player in campaign B. That tests a
   player's own cookie.
2. On The Forge, create a **new world** (dnd5e) and install from manifest
   `https://github.com/whelan/ddb-inventory-sync/releases/latest/download/module.json`. This
   needs the PR merged, which publishes v0.1.0. Also install Item Piles (+ D&D 5e), ddb-sync and
   the bridge module, configure the bridge, and allow macros.
3. Enter your cookie in ddb-sync. If B is on another account, store its cookie in the console:
   `game.modules.get('ddb-inventory-sync').api.setCharacterCobalt(<B id>, '<B cookie>')`.
4. Tell Claude the campaign B id and character id(s). Keep the Forge tab open in Chrome as GM.
   Chrome may ask to **allow local network access** for the Forge page: allow it. It reaches the
   dev server, the proxy and the bridge on localhost.

Claude:
1. Starts dev server and proxy as in phase 2 (they may still be running), then configures:
   `devRuntimeUrl` = local dev server, proxyUrl `http://localhost:3000`, campaign B, mapping
   B → "Test Hero B", **and A → "Test Hero A"**. That puts two characters from two campaigns in
   one world.
2. Dev `diagnose`, `selfTest` on B, live scenarios on B (party = campaign B).
3. Live scenarios on A in the same world: proves characters from different campaigns sync side by side.
4. Switch to the installed release (`devRuntimeUrl: ""`, `reloadPage`) and run the live
   scenarios on B once more. This proves the published module, not only the dev build.

Report: `test-runs/<date>-phase3.md`. After that the module goes onto the real campaign
characters, with dry run on for the first session.

## Leaving the worlds as found

When a phase is done, Claude asks which state Lars wants. Usually: `dryRun: true`,
`devRuntimeUrl: ""`, and the proxy URL he uses for play. It stops the dev server, the proxy and
the mock, and reminds Lars to switch off *Allow the bridge to run macros*.
