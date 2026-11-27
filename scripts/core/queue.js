/**
 * Per-character serial queue.
 *
 * D&D Beyond applies a character's inventory calls in order, and an add must
 * land before the quantity change or removal that follows it, so every
 * character gets one lane. A newer op with the same coalesce key replaces a
 * still-waiting one; `merge(older, newer)` decides how (latest value, summed
 * deltas). A failed op goes to `failed` so it can be retried.
 */
export class SyncQueue {
  /**
   * @param {(op:object) => Promise<void>} run
   * @param {{coalesceKey?: (op:object)=>string|null, merge?: (older:object, newer:object)=>object, onError?: (op:object, err:Error)=>void}} [opts]
   */
  constructor(run, { coalesceKey = () => null, merge = (older, newer) => newer, onError = () => {} } = {}) {
    this.run = run;
    this.coalesceKey = coalesceKey;
    this.merge = merge;
    this.onError = onError;
    this.failed = []; // { op, error, at }
    this.lanes = new Map(); // characterId -> { pending: op[], running: Promise|null }
  }

  push(op) {
    const id = String(op.characterId);
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = { pending: [], running: null };
      this.lanes.set(id, lane);
    }
    const key = this.coalesceKey(op);
    if (key) {
      const i = lane.pending.findIndex((p) => this.coalesceKey(p) === key);
      if (i !== -1) {
        lane.pending[i] = this.merge(lane.pending[i], op);
        return lane.running ?? Promise.resolve();
      }
    }
    lane.pending.push(op);
    if (!lane.running) lane.running = this.#drain(id, lane);
    return lane.running;
  }

  async #drain(id, lane) {
    while (lane.pending.length) {
      const op = lane.pending.shift();
      try {
        await this.run(op);
      } catch (err) {
        this.failed.push({ op, error: err?.message ?? String(err), at: new Date().toISOString() });
        if (this.failed.length > 100) this.failed.shift();
        this.onError(op, err);
      }
    }
    lane.running = null;
    this.lanes.delete(id);
  }

  /** Put every failed op back in its lane; returns how many. */
  retryFailed() {
    const ops = this.failed.splice(0).map((f) => f.op);
    for (const op of ops) this.push(op);
    return ops.length;
  }

  /** Resolves when every lane is empty. */
  async idle() {
    while (this.lanes.size) {
      await Promise.all([...this.lanes.values()].map((l) => l.running));
    }
  }

  get size() {
    let n = 0;
    for (const lane of this.lanes.values()) n += lane.pending.length + (lane.running ? 1 : 0);
    return n;
  }
}
