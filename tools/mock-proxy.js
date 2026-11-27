#!/usr/bin/env node
/**
 * Mock ddb-proxy + D&D Beyond in one process, in memory. Point the module's
 * "Proxy URL" at it to try everything in a real Foundry world without
 * touching a real D&D Beyond character.
 *
 *   npm run mock                 # http://localhost:3999, any cobalt accepted
 *   npm run mock -- --port 4000 --cobalt SECRET
 *
 * Open http://localhost:3999/ to watch the fake characters' inventories and
 * coins update live. Unknown character ids are created on first use, so your
 * real ddb-sync mapping works unchanged. Chrome allows an https Foundry/Forge
 * page to call http://localhost.
 *
 * Knobs (also buttons on the status page):
 *   POST /mock/reset
 *   POST /mock/fail    { "status": 503, "count": 2, "op": "add" }   next calls fail
 *   POST /mock/config  { "latencyMs": 800, "dropRowIds": true, "currencyIsDelta": true }
 *   POST /mock/edit    { "characterId": 111, "rowId": 1000, "quantity": 5 }  simulate a player editing on D&D Beyond
 *   POST /mock/edit    { "characterId": 111, "currencies": { "gp": 3 } }
 *   GET  /mock/state
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const ENTITY = { CHARACTER: 1581111423, ITEM: 1439493548, CAMPAIGN: 618115330 };

export const DEFINITIONS = [
  { id: 2, entityTypeId: 1439493548, name: 'Potion of Healing', isHomebrew: false, isLegacy: false },
  { id: 9002, entityTypeId: 1439493548, name: 'Potion of Healing', isHomebrew: false, isLegacy: true },
  { id: 3, entityTypeId: 2103445194, name: 'Rope, Hempen (50 feet)', isHomebrew: false, isLegacy: false },
  { id: 4, entityTypeId: 1782728300, name: 'Dagger', isHomebrew: false, isLegacy: false },
  { id: 5, entityTypeId: 1782728300, name: 'Longsword', isHomebrew: false, isLegacy: false },
  { id: 6, entityTypeId: 2103445194, name: 'Torch', isHomebrew: false, isLegacy: false },
  { id: 7, entityTypeId: 2103445194, name: 'Rations (1 day)', isHomebrew: false, isLegacy: false },
  { id: 8, entityTypeId: 701257905, name: 'Chain Mail', isHomebrew: false, isLegacy: false },
  { id: 9, entityTypeId: 2103445194, name: "Healer's Kit", isHomebrew: false, isLegacy: false },
  { id: 777, entityTypeId: 112130694, name: 'Bonegrinder Bell', isHomebrew: true, isLegacy: false }
];

const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];

export function createMockProxy({ cobalt = null, campaignId = 999, characters = [], autoCreate = true } = {}) {
  const state = {};
  const reset = () => {
    Object.assign(state, {
      nextRowId: state.nextRowId ?? 1000, // row ids stay unique across resets, as on D&D Beyond
      characters: new Map(),
      party: new Map(),
      calls: [],
      failures: [],
      config: { latencyMs: 0, dropRowIds: false, currencyIsDelta: false }
    });
    for (const c of characters) addCharacter(c.id, c.name, c.campaignId ?? campaignId);
  };
  const addCharacter = (id, name = `Character ${id}`, campaign = campaignId) => {
    const c = { id, name, campaignId: campaign, currencies: { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 }, inventory: [], customItems: [] };
    state.characters.set(id, c);
    return c;
  };
  const partyOf = (id) => {
    if (!state.party.has(id)) state.party.set(id, { inventory: [], currencies: Object.fromEntries(COINS.map((k) => [k, 0])) });
    return state.party.get(id);
  };
  reset();

  const fail = (status, message) => ({ status: status >= 500 || status === 429 ? 502 : status === 401 ? 401 : 502, json: { success: false, message, ddbStatus: status } });
  const ok = (data = {}) => ({ status: 200, json: { success: true, data, ddbStatus: 200 } });

  function findRow(c, id) {
    let row = c.inventory.find((r) => r.id === id);
    if (row) return { list: c.inventory, row };
    if (c.campaignId) {
      const list = partyOf(c.campaignId).inventory;
      row = list.find((r) => r.id === id);
      if (row) return { list, row };
    }
    return null;
  }

  function newRow(c, { definition, name, quantity, toParty }) {
    const row = {
      id: state.nextRowId++,
      entityTypeId: definition?.entityTypeId ?? 0,
      definitionId: definition?.id ?? null,
      definitionTypeId: definition?.entityTypeId ?? null,
      containerEntityId: toParty ? c.campaignId : c.id,
      containerEntityTypeId: toParty ? ENTITY.CAMPAIGN : ENTITY.CHARACTER,
      quantity,
      equipped: false,
      isAttuned: false,
      name: definition?.name ?? name,
      custom: !definition
    };
    (toParty ? partyOf(c.campaignId).inventory : c.inventory).push(row);
    return row;
  }

  function inventory(body) {
    const characterId = Number(body.characterId);
    if (!Number.isInteger(characterId) || characterId <= 0) return { status: 400, json: { success: false, message: 'Invalid characterId' } };
    if (cobalt && body.cobalt !== cobalt) return { status: 401, json: { success: false, message: 'You must supply a valid cobalt value.' } };
    if (!body.cobalt) return { status: 200, json: { success: false, message: 'No cobalt token' } };
    let c = state.characters.get(characterId);
    if (!c && autoCreate) c = addCharacter(characterId);
    if (!c) return fail(403, 'Forbidden');
    const p = body.payload ?? {};
    const failure = state.failures.findIndex((f) => !f.op || f.op === body.op);
    if (failure !== -1) {
      const f = state.failures[failure];
      if (--f.count <= 0) state.failures.splice(failure, 1);
      return fail(f.status, `mock failure ${f.status}`);
    }

    switch (body.op) {
      case 'read':
        return ok({
          id: c.id,
          name: c.name,
          currencies: { ...c.currencies },
          campaignId: c.campaignId,
          inventory: c.inventory.map(({ custom, ...r }) => ({ ...r })),
          customItems: c.customItems
        });
      case 'add': {
        if (!Array.isArray(p.equipment) || !p.equipment.length) return { status: 400, json: { success: false, message: '"equipment" must be an array of 1-50 entries' } };
        const added = [];
        for (const e of p.equipment) {
          const definition = DEFINITIONS.find((d) => d.id === e.entityId && d.entityTypeId === e.entityTypeId);
          if (!definition) return fail(400, `Unknown definition ${e.entityId}`);
          const toParty = e.containerEntityTypeId === ENTITY.CAMPAIGN;
          if (toParty && e.containerEntityId !== c.campaignId) return fail(400, 'Character is not in that campaign');
          added.push(newRow(c, { definition, quantity: e.quantity, toParty }));
        }
        return ok({ addItems: state.config.dropRowIds ? [] : added });
      }
      case 'customItem': {
        if (!p.name || !Number.isInteger(p.quantity)) return { status: 400, json: { success: false, message: 'Missing "name"' } };
        const toParty = p.containerEntityTypeId === ENTITY.CAMPAIGN;
        const row = newRow(c, { name: p.name, quantity: p.quantity, toParty });
        return ok({ addItems: state.config.dropRowIds ? [] : [row] });
      }
      case 'remove': {
        const hit = findRow(c, Number(p.id));
        if (!hit) return fail(404, 'Item not found');
        hit.list.splice(hit.list.indexOf(hit.row), 1);
        return ok();
      }
      case 'quantity':
      case 'equipped':
      case 'attuned': {
        const hit = findRow(c, Number(p.id));
        if (!hit) return fail(404, 'Item not found');
        if (body.op === 'quantity') hit.row.quantity = p.quantity;
        if (body.op === 'equipped') hit.row.equipped = p.value;
        if (body.op === 'attuned') hit.row.isAttuned = p.value;
        return ok();
      }
      case 'move': {
        const hit = findRow(c, Number(p.id));
        if (!hit) return fail(404, 'Item not found');
        Object.assign(hit.row, { containerEntityId: p.containerEntityId, containerEntityTypeId: p.containerEntityTypeId });
        return ok();
      }
      case 'currency': {
        let purse;
        if (p.destinationEntityTypeId === ENTITY.CHARACTER && p.destinationEntityId === c.id) purse = c.currencies;
        else if (p.destinationEntityTypeId === ENTITY.CAMPAIGN && p.destinationEntityId === c.campaignId) purse = partyOf(c.campaignId).currencies;
        else return fail(400, 'Bad currency destination');
        for (const coin of COINS) {
          if (p[coin] === undefined) continue;
          purse[coin] = state.config.currencyIsDelta ? purse[coin] + p[coin] : p[coin];
        }
        return ok();
      }
      default:
        return { status: 400, json: { success: false, message: `Unknown inventory operation "${body.op}"` } };
    }
  }

  function mock(path, body) {
    if (path === '/mock/reset') reset();
    else if (path === '/mock/fail') state.failures.push({ status: Number(body.status) || 503, count: Number(body.count) || 1, op: body.op || null });
    else if (path === '/mock/config') Object.assign(state.config, body);
    else if (path === '/mock/edit') {
      const c = state.characters.get(Number(body.characterId));
      if (!c) return { status: 404, json: { message: 'no such character' } };
      if (body.rowId) {
        const hit = findRow(c, Number(body.rowId));
        if (!hit) return { status: 404, json: { message: 'no such row' } };
        if (body.quantity === 0) hit.list.splice(hit.list.indexOf(hit.row), 1);
        else if (body.quantity != null) hit.row.quantity = body.quantity;
      }
      if (body.currencies) Object.assign(c.currencies, body.currencies);
    } else return { status: 404, json: { message: 'unknown mock route' } };
    return { status: 200, json: snapshot() };
  }

  const snapshot = () => ({
    characters: [...state.characters.values()],
    party: Object.fromEntries(state.party),
    config: state.config,
    failures: state.failures,
    calls: state.calls.slice(-50)
  });

  async function handle(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    };
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...cors, 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/ping') return send(200, 'pong', 'text/plain');
    if (req.method === 'GET' && url.pathname === '/mock/state') return send(200, snapshot());
    if (req.method === 'GET' && url.pathname === '/') return send(200, statusPage(), 'text/html; charset=utf-8');

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(400, { success: false, message: 'Invalid JSON' });
    }
    if (state.config.latencyMs) await new Promise((r) => setTimeout(r, state.config.latencyMs));

    if (url.pathname.startsWith('/mock/')) {
      const r = mock(url.pathname, body);
      return send(r.status, r.json);
    }
    if (url.pathname === '/proxy/items') {
      if (!body.cobalt || (cobalt && body.cobalt !== cobalt)) return send(200, { success: false, message: 'You must supply a valid cobalt value.' });
      return send(200, { success: true, data: DEFINITIONS });
    }
    if (url.pathname === '/proxy/inventory') {
      const r = inventory(body);
      state.calls.push({ at: new Date().toISOString(), op: body.op, characterId: body.characterId, payload: body.payload ?? null, status: r.status, ok: r.json.success !== false });
      if (state.calls.length > 500) state.calls.shift();
      return send(r.status, r.json);
    }
    return send(404, { success: false, message: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    });
  });
  return { server, state, reset, addCharacter };
}

function statusPage() {
  return `<!doctype html><meta charset="utf-8"><title>Mock D&amp;D Beyond</title>
<style>body{font:14px system-ui;margin:16px;max-width:1100px}table{border-collapse:collapse;margin:4px 0 16px}td,th{border:1px solid #ccc;padding:2px 8px;text-align:left}
.bad{color:#b00}.ok{color:#070}button{margin:2px}h2{margin:12px 0 4px}code{background:#eee;padding:0 4px}</style>
<h1>Mock D&amp;D Beyond</h1>
<p>Set the module's <b>Proxy URL</b> to <code id="u"></code>. Updates every second.</p>
<div>
<button onclick="post('/mock/reset')">Reset</button>
<button onclick="post('/mock/fail',{status:503,count:1})">Next call 503</button>
<button onclick="post('/mock/fail',{status:503,count:5})">Next 5 calls 503</button>
<button onclick="post('/mock/fail',{status:400,count:1})">Next call 400</button>
<button onclick="post('/mock/config',{dropRowIds:!s.config.dropRowIds})">Toggle drop row ids</button>
<button onclick="post('/mock/config',{currencyIsDelta:!s.config.currencyIsDelta})">Toggle delta currency</button>
<button onclick="post('/mock/config',{latencyMs:s.config.latencyMs?0:1500})">Toggle 1.5 s latency</button>
</div>
<pre id="cfg"></pre><div id="out"></div>
<script>
document.getElementById('u').textContent = location.origin;
let s = {};
async function post(p, b = {}) { await fetch(p, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)}); load(); }
async function edit(characterId, rowId) { const q = prompt('New quantity on D&D Beyond (0 removes)'); if (q !== null) post('/mock/edit', {characterId, rowId, quantity: Number(q)}); }
async function coins(characterId) { const gp = prompt('Set gp on D&D Beyond'); if (gp !== null) post('/mock/edit', {characterId, currencies: {gp: Number(gp)}}); }
const esc = (x) => String(x ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
function rows(list, cid) { return '<table><tr><th>row</th><th>name</th><th>qty</th><th>equipped</th><th>attuned</th><th></th></tr>' + list.map(r => '<tr><td>'+r.id+'</td><td>'+esc(r.name)+(r.custom?' <i>(custom)</i>':'')+'</td><td>'+r.quantity+'</td><td>'+(r.equipped?'✔':'')+'</td><td>'+(r.isAttuned?'✔':'')+'</td><td>'+(cid?'<button onclick="edit('+cid+','+r.id+')">edit on DDB</button>':'')+'</td></tr>').join('') + '</table>'; }
const purse = (c) => ['pp','gp','ep','sp','cp'].map(k => c[k]+' '+k).join(', ');
async function load() {
  s = await (await fetch('/mock/state')).json();
  document.getElementById('cfg').textContent = 'config ' + JSON.stringify(s.config) + (s.failures.length ? '  pending failures ' + JSON.stringify(s.failures) : '');
  let h = '';
  for (const c of s.characters) h += '<h2>#'+c.id+' '+esc(c.name)+' <small>campaign '+c.campaignId+'</small></h2><div>'+purse(c.currencies)+' <button onclick="coins('+c.id+')">set gp on DDB</button></div>'+rows(c.inventory, c.id);
  for (const [id, p] of Object.entries(s.party)) h += '<h2>Party inventory, campaign '+id+'</h2><div>'+purse(p.currencies)+'</div>'+rows(p.inventory);
  h += '<h2>Last calls</h2><table><tr><th>time</th><th>char</th><th>op</th><th>payload</th><th></th></tr>' + s.calls.slice().reverse().map(c => '<tr><td>'+c.at.slice(11,19)+'</td><td>'+c.characterId+'</td><td>'+c.op+'</td><td><code>'+esc(JSON.stringify(c.payload))+'</code></td><td class="'+(c.ok?'ok':'bad')+'">'+c.status+'</td></tr>').join('') + '</table>';
  document.getElementById('out').innerHTML = h;
}
load(); setInterval(load, 1000);
</script>`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 ? process.argv[i + 1] : fallback;
  };
  const port = Number(arg('port', 3999));
  const { server } = createMockProxy({ cobalt: arg('cobalt', null), campaignId: Number(arg('campaign', 999)) });
  server.listen(port, () => {
    console.log(`Mock ddb-proxy + D&D Beyond on http://localhost:${port}  (status page: http://localhost:${port}/)`);
    console.log('Set DDB Inventory Sync -> Proxy URL to that address. Any cobalt is accepted unless --cobalt is given.');
  });
}
