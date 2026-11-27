# DDB Inventory Sync

A Foundry VTT (v13–v14, dnd5e) module that sends inventory changes on your players' actors
**to their D&D Beyond characters**:

- **Merchants** — an Item Piles merchant purchase or sale (or any other merchant sheet)
  adds or removes the item and sets the buyer's coins on D&D Beyond.
- **Loot** — an item a player takes from an Item Piles loot pile, or that the GM drops on
  their sheet, is added to their D&D Beyond inventory.
- **Party loot** — items and coins on one designated *party actor* (an Item Piles vault or a
  dnd5e group) go to the campaign's **party inventory** on D&D Beyond.
- Stack changes, removals (sold, given away, used up), equipped and attuned follow along.

It sits between Item Piles and D&D Beyond without depending on either module's internals: it
listens to Foundry's own `createItem` / `updateItem` / `deleteItem` / `updateActor` hooks on
mapped actors, which is where every Item Piles transfer ends up. Only the active GM client
sends, so each change goes out once.

## Why a proxy

D&D Beyond's API answers CORS only for `https://www.dndbeyond.com`; a browser on Foundry or
The Forge cannot call it. Writes go through your own **ddb-proxy** (the one ddb-sync already
uses), which needs the `/proxy/inventory` route from `whelan/ddb-proxy`. The route forwards a
fixed whitelist of operations and fields — nothing else passes.

## Install

Manifest URL — Foundry (*Add-on Modules → Install Module → Manifest URL*) and **The Forge**
(*Bazaar → Install via manifest*, or *Configure → Add-on Modules → Install via manifest*):

```
https://github.com/whelan/ddb-inventory-sync/releases/latest/download/module.json
```

Updates arrive through the same URL. A release is published by the Release workflow whenever
`main` carries a `module.json` version that has no release yet — bump `version`, merge.

## Setup

1. Update and restart your ddb-proxy with the `/proxy/inventory` route.
2. Install the module, enable it. With ddb-sync installed, its proxy URL, cobalt cookie,
   campaign ID and character mapping are used when this module's own settings are empty.
3. Settings → **Party actor ID**: the actor that is the party stash (optional).
4. Settings → **Run diagnostics**: checks proxy, cookies, mapping, party and item list and
   whispers the report to the GM. Writes nothing.
5. Settings → **Run live self-test** on a *test* character: a full round trip on D&D Beyond that
   cleans up after itself.
6. Pair existing items with their D&D Beyond rows once per character (items that are not linked
   are also linked on the fly by name):
   ```js
   await game.modules.get('ddb-inventory-sync').api.link(game.actors.getName('Ireena'));
   ```
7. Keep **Dry run** on for a session, read `api.log`, then turn it off.

How to test all of it, first against a mock with no risk: **[TESTING.md](TESTING.md)**. The world
macro **DDB Inventory Sync: Test** plays merchant, loot, give, party and coin scenarios through
Item Piles and checks D&D Beyond after every step. A local Claude can run it through
foundry-mcp-bridge's `run_macro` (skill: `.claude/skills/test-ddb-inventory-sync`).

### Whose cookie writes?

D&D Beyond lets a character be edited by its owner. If your own cobalt cookie is refused for a
player's character, store that player's cookie in the GM browser (never in world data):
`await api.setCharacterCobalt(<ddbCharacterId>, '<cobalt>')`.

## How items are matched

1. A pinned definition: `api.setDefinition(item, id, entityTypeId)`.
2. DDB Importer's `definitionId` flag on imported items.
3. The item's name against every item definition the account sees in the campaign
   (official and shared homebrew; homebrew wins a tie). Vault items pushed to D&D Beyond
   homebrew therefore arrive as real items.
4. Otherwise a **custom item** (name, description, cost, weight) — or skip, by setting.

## Delta or absolute

Players also use the D&D Beyond sheet. In **delta** mode (default) a character is read from
D&D Beyond before each change and the Foundry difference is applied to it, so a potion a player
drank on D&D Beyond or gold spent there is not undone by the next Foundry trade. **Absolute**
mode overwrites D&D Beyond with the Foundry value. The party inventory cannot be read through a
character, so party coins are always absolute.

## Safety rails

- Off by default; **dry run** on by default (reads are allowed, writes are logged only).
- **Import guard**: a DDB Importer rebuild (a burst of creates or deletes of items that carry
  D&D Beyond ids, or updates that change more than inventory fields) is not sent back.
- **Verify writes**: each character write is read back and a mismatch reported.
- Transient errors are retried; rejected writes are kept: `api.failed`, `api.retryFailed()`.
- If the D&D Beyond item list cannot be loaded, adds fail instead of becoming custom items.
- `api.pause()` / `api.resume()`, and `{ 'ddb-inventory-sync': { skip: true } }` in an
  operation's options keeps a change local.
- A warning appears if DDB Importer's dynamic sync is on too.

Every situation and the test that covers it: [docs/EDGE-CASES.md](docs/EDGE-CASES.md).

## Development

```bash
npm test        # unit + scenario tests (main.js in a Foundry stand-in, against the mock over HTTP)
npm run mock    # mock ddb-proxy + D&D Beyond with a live status page on http://localhost:3999
npm run dev     # rebuild scripts/runtime.js on save, serve it on http://localhost:3997/runtime.js
```

`scripts/main.js` is a small bootstrap; the rest (`scripts/runtime.js`) can be hot-swapped. Set
the client setting *Dev runtime URL* to the dev server and run the world macro
**DDB Inventory Sync: Dev** with `{ action: "reload" }`. That works in a local world and on
The Forge, without reloading Foundry. See [docs/TEST-PLAN.md](docs/TEST-PLAN.md).

`scripts/core/` is pure and unit-tested (matcher, planner, queue, engine, targets, linker,
client, selftest, scenarios); `scripts/runtime.js` is the Foundry glue.
