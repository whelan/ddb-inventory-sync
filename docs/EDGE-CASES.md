# Edge cases

What the module does in each situation, and the test that holds it there
(`core` = `tests/core.test.js`, `glue` = `tests/glue.test.js`, `proxy` = `whelan/ddb-proxy`
`test/inventory.e2e.test.js`, `scenarios` = `tests/scenarios.test.js`, the Item Piles runner).

## Who sends, and what is ignored

| Situation | Behaviour | Test |
|---|---|---|
| Several GMs, or a player makes the change | Only the active GM client sends; it sees every client's change | glue *ignored: …another GM client* |
| No GM online | Nothing is sent and nothing is queued — changes while no GM is connected are not synced | (by design) |
| Merchant, loot pile, any actor that is not mapped | Ignored | glue *ignored: merchant…* |
| Unlinked token of a PC (shares the actor id) | Ignored | glue *ignored: …unlinked token copy* |
| Spells, features, anything not inventory | Ignored | core *planCreate* |
| Two actors mapped to the same D&D Beyond character | Diagnostics warns (changes would go out twice) | diagnostics |
| DDB Importer's dynamic sync also on | Warning at load and in diagnostics | diagnostics |
| `{ 'ddb-inventory-sync': { skip: true } }` in options | Not sent | glue *ignored: …skip option* |
| `api.pause()` (e.g. during re-imports) | Not sent; snapshots keep updating so later deltas stay right | glue *ignored: …pause* |

## Imports (DDB Importer rebuilding a sheet)

| Situation | Behaviour | Test |
|---|---|---|
| Burst of new items that carry D&D Beyond ids | Not sent (import guard) | glue *DDB Importer rebuild* |
| Burst of deleted imported items | Not sent — would otherwise delete rows on D&D Beyond | glue *DDB Importer rebuild* |
| Item update that also changes description, name, … | Not sent (D&D Beyond already has it); snapshot updated | glue *an import updating many fields* |
| Actor update with coins **and** other data | Not sent | glue *an import updating many fields* |
| Loot pile take of many plain items | Sent — only bursts of mostly imported items trip the guard | glue *a loot pile take* |

## Items

| Situation | Behaviour | Test |
|---|---|---|
| Name matches an official and a legacy printing | Current printing wins; homebrew beats both | core *buildIndex* |
| No D&D Beyond item with that name | Custom item (name, description, cost, weight), or skip by setting | core *planCreate*, glue *party loot* |
| Item list cannot be loaded (proxy down, bad cobalt) | The add **fails** (kept for retry); never silently turned into custom items | glue *items list unavailable* |
| Stack changed before its add went out | One add with the final stack | glue *stack changed before…* |
| Created and deleted before its add went out | Nothing sent; an existing stack with the same name is untouched | glue *created and removed at once* |
| Copy from a trade carries the source's row id | Gets its own row; source row removed | glue *trade between two synced PCs* |
| Item without a stored row id changes | Linked by definition, then name, to an unclaimed row (prefers same quantity) | core *engine quantity on an unlinked item*, *findRowFor* |
| Item known not to be on D&D Beyond is removed | No-op — never links by name to someone else's stack | core *engine remove …known-missing* |
| Item not on D&D Beyond grows | Added with its stack | core *engine quantity on an item not on D&D Beyond* |
| Add answers without row ids | Row found by reading (newest unclaimed match) | core *engine add: no row id*, glue *answers an add without row ids* |
| Row deleted on D&D Beyond, then removed in Foundry | Nothing to do, no error | core *engine remove …already gone* |
| Quantity set to 0 | Removal | core *planUpdate* |
| Equip / attune | Sent for characters, skipped when D&D Beyond already agrees, not for the party | core *engine equipped*, glue *equip and attune* |
| Item inside a Foundry container | Added to the character's root on D&D Beyond (container moves are not synced) | (known limit) |
| Party inventory rows | Cannot be read through a character, so only rows this module added are changed or removed | core *engine remove on the party* |

## Quantities and coins (delta vs absolute)

Players also use the D&D Beyond sheet. In **delta** mode (default) the module reads the character
and applies the Foundry change to what D&D Beyond holds.

| Situation | Delta mode | Absolute mode | Test |
|---|---|---|---|
| Player used 1 of 2 potions on D&D Beyond, Foundry buys 1 (2→3) | D&D Beyond 2 | D&D Beyond 3 | glue *a player used a potion* |
| Player spent gold on D&D Beyond, Foundry spends 3 gp | Both spends count | Foundry's purse wins | glue *coins: delta…* |
| Delta would go below 0 | Clamped at 0 (row removed for items) | — | core *engine currency*, *delta to 0* |
| Foundry stack of 2 removed, D&D Beyond has 5 | 3 stay on D&D Beyond | Row removed | core *engine remove: only the stack that left* |
| Previous value unknown (actor mapped mid-session) | Falls back to absolute for that change | — | core *planUpdate …unknown previous* |
| Party coins | Always absolute (party purse cannot be read) | Absolute | core *engine currency …party is absolute* |
| Several quick changes | Folded into one write, deltas summed | Latest value | core *coalesce and merge*, glue *several quick coin changes* |
| Coins sent | Always all five coins, never a partial purse | | core *planCurrency* |

## Failures

| Situation | Behaviour | Test |
|---|---|---|
| Network error, timeout, 429, 5xx | Retried twice (1 s, 3 s) | core *engine retries*, glue *busy (503)* |
| 4xx (rejected) | Not retried; error notification; kept in `api.failed`; `api.retryFailed()` | glue *rejected write* |
| Write accepted but not applied | *Verify writes* reads it back and reports | core *engine verify* |
| Bearer token expired | Proxy refreshes it once | proxy *expired bearer token* |
| Auth service down | Proxy answers 401 instead of hanging | proxy *auth service being down* |
| Wrong cobalt | 401, error notification | proxy *a wrong cobalt* |
| Character private / not yours | 502 with `ddbStatus` 403 | proxy *errors come back as 502* |
| Payload with extra fields or another characterId | Stripped by the proxy whitelist | proxy *only whitelisted fields* |
| Proxy unreachable | Client error after 15 s at most; retried | core *ProxyClient … times out* |

## Self-test safety

| Situation | Behaviour | Test |
|---|---|---|
| Coin call adds instead of setting | Detected, opposite call restores the purse, reported ❌ | glue *self-test catches a currency call that adds* |
| Anything it created | Removed again; a failed cleanup is reported with the row id | glue *self-test passes … leaves nothing behind* |
| Test character not in the party's campaign | Party step skipped with a warning | selftest |

## Item Piles, played for real

`tests/scenarios.test.js` runs the scenario runner (the world macro) against a fake Item Piles
with Item Piles' behaviour: stacks merge by name, purchases cost the price, selling pays half,
and transfers copy item flags. A run covers merchant buy, buy again, sell back, loot pile
take-all with a custom item, use, a player editing on D&D Beyond, give to another PC, and the
party stash. The checks run after every step, then cleanup returns D&D Beyond to where it was.
The same file shows that a wrong coin call fails a step, that dry run, leftovers and a non-mock
proxy are refused, and that the runner also works without Item Piles.
