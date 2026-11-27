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
4. In the console, per character, check the connection and pair existing items with their
   D&D Beyond rows (once, before the first session with sync on):
   ```js
   const api = game.modules.get('ddb-inventory-sync').api;
   await api.test(game.actors.getName('Ireena'));   // reads only
   await api.link(game.actors.getName('Ireena'));   // sets row ids on existing items
   ```
5. Keep **Dry run** on for a session, read `api.log`, then turn it off.

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

## Safety rails

- Off by default; **dry run** on by default.
- **Import guard**: a burst of new items on one actor that mostly carry D&D Beyond ids
  (DDB Importer rebuilding a sheet) is not sent back.
- Pass `{ 'ddb-inventory-sync': { skip: true } }` in an operation's options to keep a change local.
- Per-character serial queue; a newer purse or stack size replaces a waiting one.
- A warning appears if DDB Importer's dynamic sync is on too (changes would be sent twice).

## Verify against D&D Beyond before trusting it

The endpoints and bodies are the ones D&D Beyond's own character sheet sends (read from its
public character-app bundle). They are unofficial. Check these once on a test character, with
dry run off:

- [ ] `api.test(actor)` reads the inventory.
- [ ] Add a known item (Potion of Healing) — appears on D&D Beyond, row id is stored.
- [ ] Change its quantity, then delete it.
- [ ] Coins: set gp on the actor — D&D Beyond shows the same purse (absolute set, not a delta).
- [ ] Unknown item → custom item appears.
- [ ] Party actor: add an item — appears under Party Inventory in the campaign.
- [ ] Party coins.
- [ ] Your cobalt on a player's character — allowed, or a player cookie is needed.

## Development

```bash
npm test   # node --test, no dependencies
```

`scripts/core/` is pure and unit-tested (matcher, planner, queue, engine, targets, linker,
client); `scripts/main.js` is the thin Foundry glue, exercised by `tests/glue.test.js`
against a minimal Foundry stand-in.
