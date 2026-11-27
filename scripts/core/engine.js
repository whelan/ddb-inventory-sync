/**
 * Engine: executes planned operations against the proxy.
 *
 * Every Foundry dependency is injected, so the whole path from op to proxy
 * call is unit-tested with fakes:
 *   client.call(characterId, op, payload) -> json   (proxy /proxy/inventory)
 *   client.read(characterId) -> json                 ({ data: { inventory, currencies, campaignId } })
 *   ids.get(itemId) -> { ddbId } | null              (Foundry item -> D&D Beyond inventory row)
 *   ids.set(itemId, ddbId) -> Promise
 *   ids.forget(itemId)                               (known to have no row: removed, or never added)
 *   ids.release(itemId)                              (row unknown: may be linked by name later)
 *   ids.knownMissing(itemId) -> boolean              (forgotten, or added this session and not sent yet)
 *   ids.isClaimed(ddbId, op) -> boolean              (another Foundry item already owns that row)
 *   planAddFor(itemId) -> Promise<add op | null>     (plans an add from the item as it is now)
 *   log(level, message, op)
 *
 * Rules worth knowing:
 *  - In "delta" mode a character's quantities and coins are read from D&D
 *    Beyond first and the Foundry delta is applied to them, so changes a player
 *    made on the D&D Beyond sheet survive. The party inventory cannot be read
 *    through the character endpoint, so it is always set absolutely.
 *  - An item without a stored row id is linked on the fly by definition or
 *    name before a change or removal; an item not on D&D Beyond at all is
 *    added when it grows, and its removal is a no-op.
 *  - Transient failures (network, timeout, 429, 5xx) are retried; a rejected
 *    write (4xx) is not.
 *  - With verify on, every character write is read back and compared.
 */
import { COINS, ENTITY_TYPES } from './constants.js';
import { findRowFor } from './linker.js';

/** The new inventory rows in a write response (D&D Beyond answers `data.addItems`). */
export function addedRows(json) {
  const data = json?.data ?? json;
  const rows = data?.addItems ?? data?.data?.addItems;
  return Array.isArray(rows) ? rows : [];
}

/** Pick the row D&D Beyond created for this add. */
export function pickAddedRow(rows, definition) {
  if (!rows.length) return null;
  if (definition) {
    const hit = rows.find((r) => r?.definitionId === definition.id || r?.definition?.id === definition.id);
    if (hit) return hit;
  }
  return rows[rows.length - 1];
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

export class SyncError extends Error {
  constructor(message, { ddbStatus = null, transient = false } = {}) {
    super(message);
    this.ddbStatus = ddbStatus;
    this.transient = transient;
  }
}

export class SyncEngine {
  constructor({
    client,
    ids,
    planAddFor = async () => null,
    log = () => {},
    dryRun = () => false,
    mode = () => 'delta',
    verify = () => false,
    retries = 2,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  }) {
    Object.assign(this, { client, ids, planAddFor, log, dryRun, mode, verify, retries, sleep });
  }

  async run(op) {
    const handler = this[`_${op.kind}`];
    if (!handler) throw new Error(`Unknown op kind "${op.kind}"`);
    return handler.call(this, op);
  }

  _readsCharacter(op) {
    return op.scope !== 'party';
  }

  _delta(op) {
    return this.mode() === 'delta' && this._readsCharacter(op);
  }

  // --- transport -------------------------------------------------------------

  async _send(characterId, proxyOp, payload) {
    for (let attempt = 0; ; attempt++) {
      let json;
      try {
        json = await this.client.call(characterId, proxyOp, payload);
      } catch (err) {
        // network error or timeout talking to the proxy
        if (attempt < this.retries) {
          await this.sleep(1000 * 3 ** attempt);
          continue;
        }
        throw new SyncError(err.message, { transient: true });
      }
      if (json?.success !== false) return json;
      const status = json.ddbStatus ?? null;
      const transient = status == null ? /timed out|ECONN|fetch failed|Unknown error/i.test(json.message ?? '') : TRANSIENT.has(status);
      if (transient && attempt < this.retries) {
        await this.sleep(1000 * 3 ** attempt);
        continue;
      }
      throw new SyncError(json.message || `D&D Beyond rejected ${proxyOp} (${status ?? '?'})`, { ddbStatus: status, transient });
    }
  }

  async _call(op, proxyOp, payload) {
    if (this.dryRun()) {
      this.log('info', `[dry-run] ${proxyOp} ${JSON.stringify(payload)}`, op);
      return { success: true, dryRun: true, data: {} };
    }
    return this._send(op.characterId, proxyOp, payload);
  }

  async _read(op) {
    const json = await this._send(op.characterId, 'read');
    const data = json?.data;
    if (!data || !Array.isArray(data.inventory)) throw new SyncError('D&D Beyond read returned no inventory');
    return data;
  }

  _container(op) {
    const c = op.container;
    // A character's own inventory is the default container; omit it like the DDB sheet does.
    if (!c || c.typeId === ENTITY_TYPES.CHARACTER) return {};
    return { containerEntityId: c.id, containerEntityTypeId: c.typeId };
  }

  /**
   * The D&D Beyond row for an op's item. Returns { row, data } where row is
   * null when the item is not (or no longer) on D&D Beyond. For the party only
   * a stored id can be used, so row is { id, quantity: null }.
   */
  async _resolveRow(op) {
    const known = this.ids.get(op.itemId)?.ddbId ?? null;
    // Never link by name an item known not to be on D&D Beyond: the row with
    // that name belongs to another stack.
    if (!known && this.ids.knownMissing?.(op.itemId)) return { row: null, data: null };
    if (!this._readsCharacter(op)) return { row: known ? { id: known, quantity: null } : null, data: null };
    if (this.dryRun() && known) return { row: { id: known, quantity: null }, data: null };
    const data = await this._read(op);
    if (known) {
      const row = data.inventory.find((r) => r.id === known);
      if (row) return { row, data };
      this.ids.forget(op.itemId);
      this.log('info', `${op.name} is no longer on D&D Beyond (row #${known} gone)`, op);
      return { row: null, data };
    }
    const row = findRowFor(data.inventory, op.ref ?? { name: op.name }, {
      isClaimed: (id) => this.ids.isClaimed?.(id, op) ?? false,
      quantity: op.previousQuantity ?? op.quantity ?? null
    });
    if (row) {
      if (!this.dryRun()) await this.ids.set(op.itemId, row.id);
      this.log('info', `Linked ${op.name} to D&D Beyond row #${row.id}`, op);
    }
    return { row, data };
  }

  async _verifyRow(op, rowId, expect) {
    if (!this.verify() || this.dryRun() || !this._readsCharacter(op)) return;
    const data = await this._read(op);
    const row = data.inventory.find((r) => r.id === rowId);
    if (expect === null) {
      if (row) throw new SyncError(`Verify failed: ${op.name} (#${rowId}) is still on D&D Beyond`);
      return;
    }
    if (!row) throw new SyncError(`Verify failed: ${op.name} (#${rowId}) is missing on D&D Beyond`);
    for (const [key, value] of Object.entries(expect)) {
      if (row[key] !== value) throw new SyncError(`Verify failed: ${op.name} ${key} is ${row[key]} on D&D Beyond, expected ${value}`);
    }
  }

  // --- operations ------------------------------------------------------------

  async _planAdd(op) {
    const add = await this.planAddFor(op.itemId);
    if (!add) return;
    await this._add({ ...add, itemId: op.itemId });
  }

  async _add(op) {
    let json;
    const container = this._container(op);
    if (op.definition) {
      json = await this._call(op, 'add', {
        equipment: [{ entityId: op.definition.id, entityTypeId: op.definition.entityTypeId, quantity: op.quantity, ...container }]
      });
    } else {
      json = await this._call(op, 'customItem', {
        name: op.custom.name,
        description: op.custom.description,
        quantity: op.quantity,
        cost: op.custom.cost,
        weight: op.custom.weight,
        ...container,
        ...(container.containerEntityTypeId === ENTITY_TYPES.CAMPAIGN ? { partyId: container.containerEntityId } : {})
      });
    }
    if (json.dryRun) return;

    let row = pickAddedRow(addedRows(json), op.definition);
    if (!row?.id && this._readsCharacter(op)) {
      // No row in the answer: find the newest matching row nobody owns yet.
      const data = await this._read(op);
      row = findRowFor(
        [...data.inventory].sort((a, b) => a.id - b.id),
        { definitionId: op.definition?.id ?? null, name: op.custom?.name ?? op.name },
        { isClaimed: (id) => this.ids.isClaimed?.(id, op) ?? false }
      );
    }
    if (row && Number.isInteger(row.id)) {
      await this.ids.set(op.itemId, row.id);
      this.log('info', `Added ${op.quantity}× ${op.name}${op.definition ? '' : ' (custom)'} → #${row.id}`, op);
      await this._verifyRow(op, row.id, { quantity: op.quantity });
    } else {
      this.ids.release?.(op.itemId);
      this.log('warn', `Added ${op.name}, but could not find its D&D Beyond row — later changes link it by name`, op);
    }
  }

  async _quantity(op) {
    const { row } = await this._resolveRow(op);
    if (!row) {
      if ((this._readsCharacter(op) || this.ids.knownMissing?.(op.itemId)) && op.quantity > 0) {
        this.log('info', `${op.name} is not on D&D Beyond yet — adding it`, op);
        return this._planAdd(op);
      }
      this.log('warn', `${op.name}: quantity change not sent, no D&D Beyond row known`, op);
      return;
    }
    let target = op.quantity;
    if (this._delta(op) && op.delta != null && Number.isInteger(row.quantity)) target = Math.max(0, row.quantity + op.delta);
    if (row.quantity === target) return;
    if (target === 0) {
      await this._call(op, 'remove', { id: row.id, removeContainerContents: false });
      this.ids.forget(op.itemId);
      this.log('info', `Removed ${op.name} (#${row.id})`, op);
      return this._verifyRow(op, row.id, null);
    }
    await this._call(op, 'quantity', { id: row.id, quantity: target });
    this.log('info', `${op.name}: quantity ${row.quantity ?? '?'} → ${target}`, op);
    return this._verifyRow(op, row.id, { quantity: target });
  }

  async _remove(op) {
    const { row } = await this._resolveRow(op);
    if (!row) {
      this.log('info', `${op.name} was not on D&D Beyond — nothing to remove`, op);
      return;
    }
    // Delta mode keeps what a player added on the D&D Beyond sheet beyond the stack that left.
    const remaining = this._delta(op) && op.quantity && Number.isInteger(row.quantity) ? row.quantity - op.quantity : 0;
    if (remaining > 0) {
      await this._call(op, 'quantity', { id: row.id, quantity: remaining });
      this.ids.forget(op.itemId);
      this.log('info', `${op.name}: ${op.quantity} left Foundry, ${remaining} stay on D&D Beyond`, op);
      return this._verifyRow(op, row.id, { quantity: remaining });
    }
    try {
      await this._call(op, 'remove', { id: row.id, removeContainerContents: false });
    } catch (err) {
      if (err.ddbStatus !== 404) throw err;
    }
    this.ids.forget(op.itemId);
    this.log('info', `Removed ${op.name} (#${row.id})`, op);
    return this._verifyRow(op, row.id, null);
  }

  async _flag(op, proxyOp, field) {
    const { row } = await this._resolveRow(op);
    if (!row) {
      this.log('debug', `${proxyOp} skipped: ${op.name} has no D&D Beyond row`, op);
      return;
    }
    if (row[field] === op.value) return;
    await this._call(op, proxyOp, { id: row.id, value: op.value });
    return this._verifyRow(op, row.id, { [field]: op.value });
  }

  _equipped(op) {
    return this._flag(op, 'equipped', 'equipped');
  }

  _attuned(op) {
    return this._flag(op, 'attuned', 'isAttuned');
  }

  async _currency(op) {
    let coins = op.coins;
    if (this._delta(op) && op.delta && !this.dryRun()) {
      const data = await this._read(op);
      const now = data.currencies ?? {};
      coins = {};
      for (const coin of COINS) coins[coin] = Math.max(0, (Number(now[coin]) || 0) + (op.delta[coin] ?? 0));
      if (COINS.every((c) => coins[c] === (Number(now[c]) || 0))) return;
    }
    await this._call(op, 'currency', { ...coins, destinationEntityId: op.destination.id, destinationEntityTypeId: op.destination.typeId });
    const shown = Object.entries(coins).filter(([, n]) => n).map(([c, n]) => `${n} ${c}`).join(', ');
    this.log('info', `${op.scope === 'party' ? 'Party coins' : 'Coins'} set: ${shown || 'empty'}`, op);

    if (this.verify() && !this.dryRun() && this._readsCharacter(op)) {
      const after = (await this._read(op)).currencies ?? {};
      const off = COINS.filter((c) => (Number(after[c]) || 0) !== coins[c]);
      if (off.length) throw new SyncError(`Verify failed: coins on D&D Beyond differ (${off.map((c) => `${c} ${after[c]}≠${coins[c]}`).join(', ')})`);
    }
  }
}
