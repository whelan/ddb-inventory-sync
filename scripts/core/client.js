/**
 * Proxy client for ddb-proxy's /proxy/inventory route.
 *
 * D&D Beyond only answers CORS for www.dndbeyond.com, so the browser cannot
 * call it directly; the proxy holds the bearer-token exchange and forwards
 * whitelisted inventory calls.
 */
export class ProxyClient {
  /**
   * @param {{proxyUrl:()=>string, cobaltFor:(characterId:number)=>string, fetch?:typeof fetch, timeoutMs?:number}} opts
   */
  constructor({ proxyUrl, cobaltFor, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 15000 }) {
    this.proxyUrl = proxyUrl;
    this.cobaltFor = cobaltFor;
    this.fetch = (...args) => fetchImpl(...args);
    this.timeoutMs = timeoutMs;
  }

  async call(characterId, op, payload = {}) {
    const base = String(this.proxyUrl() ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('No proxy URL set (DDB Inventory Sync or ddb-sync settings)');
    const cobalt = this.cobaltFor(characterId);
    if (!cobalt) throw new Error(`No cobalt cookie for D&D Beyond character ${characterId}`);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(`${base}/proxy/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cobalt, characterId, op, payload }),
        signal: controller?.signal
      });
      const json = await response.json().catch(() => ({ success: false, message: `Proxy answered ${response.status}` }));
      if (!response.ok && json.success !== false) json.success = false;
      return json;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`Proxy timed out after ${this.timeoutMs} ms`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  read(characterId) {
    return this.call(characterId, 'read');
  }

  /** Every item definition the cobalt's account can use in the campaign (official + shared homebrew). */
  async items(characterId, campaignId) {
    const base = String(this.proxyUrl() ?? '').replace(/\/+$/, '');
    const cobalt = this.cobaltFor(characterId);
    if (!base || !cobalt) return [];
    const response = await this.fetch(`${base}/proxy/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cobalt, campaignId: campaignId ?? null })
    });
    const json = await response.json().catch(() => ({}));
    return json?.success && Array.isArray(json.data) ? json.data : [];
  }
}
