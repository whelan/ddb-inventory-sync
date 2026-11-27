/**
 * Engine: executes planned operations against the proxy.
 *
 * Every Foundry dependency is injected, so the whole path from op to proxy
 * call is unit-tested with fakes:
 *   client.call(characterId, op, payload) -> json   (proxy /proxy/inventory)
 *   ids.get(itemId) -> { ddbId } | null             (Foundry item id -> D&D Beyond inventory row)
 *   ids.set(itemId, ddbId) -> Promise
 *   ids.forget(itemId)
 *   log(level, message, op)
 */
import { ENTITY_TYPES } from './constants.js';

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

export class SyncEngine {
  constructor({ client, ids, log = () => {}, dryRun = () => false }) {
    this.client = client;
    this.ids = ids;
    this.log = log;
    this.dryRun = dryRun;
  }

  async run(op) {
    const handler = this[`_${op.kind}`];
    if (!handler) throw new Error(`Unknown op kind "${op.kind}"`);
    return handler.call(this, op);
  }

  async _call(op, proxyOp, payload) {
    if (this.dryRun()) {
      this.log('info', `[dry-run] ${proxyOp} ${JSON.stringify(payload)}`, op);
      return { success: true, dryRun: true, data: {} };
    }
    const json = await this.client.call(op.characterId, proxyOp, payload);
    if (json?.success === false) {
      throw new Error(json.message || `D&D Beyond rejected ${proxyOp} (${json.ddbStatus ?? '?'})`);
    }
    return json;
  }

  _container(op) {
    const c = op.container;
    // A character's own inventory is the default container; omit it like the DDB sheet does.
    if (!c || c.typeId === ENTITY_TYPES.CHARACTER) return {};
    return { containerEntityId: c.id, containerEntityTypeId: c.typeId };
  }

  async _add(op) {
    let json;
    if (op.definition) {
      json = await this._call(op, 'add', {
        equipment: [
          {
            entityId: op.definition.id,
            entityTypeId: op.definition.entityTypeId,
            quantity: op.quantity,
            ...this._container(op)
          }
        ]
      });
    } else {
      const container = this._container(op);
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
    const row = pickAddedRow(addedRows(json), op.definition);
    if (row && Number.isInteger(row.id)) {
      await this.ids.set(op.itemId, row.id);
      this.log('info', `Added ${op.quantity}× ${op.name} (D&D Beyond #${row.id})`, op);
    } else {
      this.log('warn', `Added ${op.name}, but D&D Beyond returned no row id — later changes to it will not sync`, op);
    }
  }

  _ddbId(op) {
    const ref = this.ids.get(op.itemId);
    if (!ref?.ddbId) {
      this.log('debug', `${op.kind} skipped: ${op.name} has no D&D Beyond row`, op);
      return null;
    }
    return ref.ddbId;
  }

  async _quantity(op) {
    const id = this._ddbId(op);
    if (id == null) return;
    await this._call(op, 'quantity', { id, quantity: op.quantity });
    this.log('info', `${op.name}: quantity ${op.quantity}`, op);
  }

  async _remove(op) {
    const id = this._ddbId(op);
    if (id == null) return;
    await this._call(op, 'remove', { id, removeContainerContents: false });
    this.ids.forget(op.itemId);
    this.log('info', `Removed ${op.name}`, op);
  }

  async _equipped(op) {
    const id = this._ddbId(op);
    if (id == null) return;
    await this._call(op, 'equipped', { id, value: op.value });
  }

  async _attuned(op) {
    const id = this._ddbId(op);
    if (id == null) return;
    await this._call(op, 'attuned', { id, value: op.value });
  }

  async _currency(op) {
    await this._call(op, 'currency', {
      ...op.coins,
      destinationEntityId: op.destination.id,
      destinationEntityTypeId: op.destination.typeId
    });
    const purse = Object.entries(op.coins)
      .filter(([, n]) => n)
      .map(([c, n]) => `${n} ${c}`)
      .join(', ');
    this.log('info', `Currency set: ${purse || 'empty'}`, op);
  }
}
