#!/usr/bin/env node
/**
 * Dev server: rebuilds scripts/runtime.js into one ES module on every file
 * change and serves it, so the running Foundry (local or The Forge) can load
 * new code without a page reload.
 *
 *   npm run dev                       # http://localhost:3997/runtime.js
 *   npm run dev -- --port 4001
 *
 * In Foundry set the client setting "Dev runtime URL" to
 * http://localhost:3997/runtime.js (or let Claude do it through the Dev macro),
 * then reload the runtime with the Dev macro's { action: "reload" }.
 *
 *   GET /runtime.js   the latest successful build (+ `export const BUILD`)
 *   GET /status       { ok, build, builtAt, errors, warnings }
 *   GET /wait?after=<build>   long-poll: answers when a newer build exists (max 30 s)
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const port = Number(arg('port', 3997));

const state = { ok: false, code: null, build: null, builtAt: null, errors: [], warnings: [] };
const waiters = new Set();

const notify = {
  name: 'notify',
  setup(build) {
    build.onEnd((result) => {
      state.errors = result.errors.map((e) => `${e.location?.file ?? ''}:${e.location?.line ?? ''} ${e.text}`);
      state.warnings = result.warnings.map((w) => `${w.location?.file ?? ''}:${w.location?.line ?? ''} ${w.text}`);
      const file = result.outputFiles?.[0];
      if (!result.errors.length && file) {
        const hash = createHash('sha1').update(file.contents).digest('hex').slice(0, 8);
        state.builtAt = new Date().toISOString();
        state.build = `${state.builtAt.slice(11, 19)}-${hash}`;
        state.code = `${file.text}\nexport const BUILD = ${JSON.stringify(state.build)};\n`;
        state.ok = true;
        console.log(`[dev] built ${state.build}`);
        for (const w of waiters) w();
        waiters.clear();
      } else {
        state.ok = false;
        console.log(`[dev] build FAILED:\n  ${state.errors.join('\n  ')}`);
      }
    });
  }
};

const ctx = await esbuild.context({
  entryPoints: [resolve(root, 'scripts/runtime.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  outfile: 'runtime.js',
  sourcemap: 'inline',
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [notify]
});
await ctx.watch();

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store'
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
    if (url.pathname === '/runtime.js') {
      if (!state.code) return send(503, `// no successful build yet\n${state.errors.map((e) => `// ${e}`).join('\n')}`, 'text/javascript');
      return send(200, state.code, 'text/javascript; charset=utf-8');
    }
    if (url.pathname === '/status') {
      const { code, ...rest } = state;
      return send(200, rest);
    }
    if (url.pathname === '/wait') {
      const after = url.searchParams.get('after');
      if (state.build && state.build !== after) return send(200, { build: state.build, ok: state.ok });
      const done = () => send(200, { build: state.build, ok: state.ok });
      waiters.add(done);
      setTimeout(() => waiters.delete(done) && done(), 30000);
      return;
    }
    return send(404, { message: 'GET /runtime.js, /status or /wait' });
  })
  .listen(port, () => console.log(`[dev] serving http://localhost:${port}/runtime.js — set it as "Dev runtime URL" in Foundry`));
