/**
 * PPGantt Supabase Auth Gate Tests — tests/test_supabase_gate.mjs
 *
 * Run with: node tests/test_supabase_gate.mjs
 *
 * Uses Node's built-in `node:test` module (available in Node 18+).
 * No external framework, matching the style of other tests/test_*.js files.
 *
 * NOTE ON EXTENSION: this file uses `.mjs` instead of `.js` because the
 * module under test (js/supabase-gate.js) is an ES module (ESM) — it
 * uses `export` and top-level `await import(...)`. Node parses `.js`
 * files in this repo as CommonJS by default (no `"type":"module"` in
 * package.json), which would refuse to load `supabase-gate.js`. Using
 * `.mjs` lets this test be ESM and use `import` naturally. All other
 * tests in this folder load CommonJS sources via `require()`, so this
 * is a purpose-driven deviation rather than drift.
 *
 * Coverage:
 *   1. On `/`, installGate is a no-op (mode:'public'; fetch not touched).
 *   2. On a gated slug route with NO session, `location.replace` fires
 *      with the right /login?redirect=... URL.
 *   3. On a gated slug route WITH session, a fetch override is installed
 *      that rewrites `/api/data/<slug>.json` to the Netlify Function with
 *      an `Authorization: Bearer <access_token>` header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installGate, isGatedSlugRoute, PUBLIC_PATHS } from '../js/supabase-gate.js';

// ─── Fakes / helpers ─────────────────────────────────────────────────────

function makeFakeWindow({ path = '/', search = '' } = {}) {
  const calls = {
    replaceCalls: [],
    origFetchCalls: [],
  };

  const origFetch = (url, opts) => {
    calls.origFetchCalls.push({ url, opts });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, url }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  };

  const win = {
    fetch: origFetch,
    location: {
      pathname: path,
      search,
      replace(url) { calls.replaceCalls.push(url); },
    },
  };

  return { win, calls, origFetch };
}

function makeFakeSupabase(session) {
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('isGatedSlugRoute: public paths are not gated', () => {
  for (const p of PUBLIC_PATHS) {
    assert.equal(isGatedSlugRoute(p), false, `expected ${p} to be public`);
  }
});

test('isGatedSlugRoute: single-segment slugs are gated', () => {
  assert.equal(isGatedSlugRoute('/societist'), true);
  assert.equal(isGatedSlugRoute('/cpu'), true);
  assert.equal(isGatedSlugRoute('/foo-bar-baz'), true);
});

test('isGatedSlugRoute: non-slug paths are not gated', () => {
  assert.equal(isGatedSlugRoute('/login.html'), false);
  assert.equal(isGatedSlugRoute('/a/b'), false);
  assert.equal(isGatedSlugRoute('/SOME_UPPER'), false);
  assert.equal(isGatedSlugRoute('/auth/callback'), false);
});

test('installGate: on `/` (public demo), no-op — fetch is not overridden', async () => {
  const { win, calls, origFetch } = makeFakeWindow({ path: '/' });
  const supabase = makeFakeSupabase(null);

  const result = installGate({ supabase, win });

  assert.equal(result.mode, 'public');
  assert.equal(win.fetch, origFetch, 'fetch should be untouched on public routes');
  assert.equal(calls.replaceCalls.length, 0, 'no redirect should be issued');
});

test('installGate: on gated slug with no session, redirects to /login with redirect param', async () => {
  const { win, calls } = makeFakeWindow({ path: '/societist', search: '?foo=bar' });
  const supabase = makeFakeSupabase(null);

  const result = installGate({ supabase, win });
  assert.equal(result.mode, 'gated');
  assert.equal(result.slug, 'societist');

  // Drive the async session check to completion. The override itself
  // short-circuits via location.replace — we wait for that to settle.
  //
  // We touch `.then` on sessionPromise; it returns a never-resolving
  // promise in the no-session branch, so we also race against a timeout.
  await Promise.race([
    result.sessionPromise,
    new Promise((resolve) => setTimeout(resolve, 20)),
  ]);

  assert.equal(calls.replaceCalls.length, 1, 'should call location.replace exactly once');
  assert.equal(
    calls.replaceCalls[0],
    '/login?redirect=' + encodeURIComponent('/societist?foo=bar'),
    'redirect URL should include the current path + search, URI-encoded'
  );
});

test('installGate: on gated slug with session, fetch override rewrites /api/data/<slug>.json with Bearer token', async () => {
  const { win, calls, origFetch } = makeFakeWindow({ path: '/societist' });
  const session = { access_token: 'TEST_ACCESS_TOKEN_123' };
  const supabase = makeFakeSupabase(session);

  const result = installGate({ supabase, win });
  assert.equal(result.mode, 'gated');
  assert.equal(win.__PPGANTT_SLUG__, 'societist');
  assert.notEqual(win.fetch, origFetch, 'fetch should be overridden');
  assert.equal(calls.replaceCalls.length, 0, 'no redirect when session exists');

  // Call the override the way the viewer would.
  const res = await win.fetch('/api/data/societist.json');
  assert.equal(res.status, 200);

  // One call should have hit the ORIGINAL fetch, at the rewritten URL
  // with the Bearer header.
  assert.equal(calls.origFetchCalls.length, 1);
  const hit = calls.origFetchCalls[0];
  assert.equal(hit.url, '/.netlify/functions/get-roadmap?slug=societist');
  const auth = hit.opts.headers.get('Authorization');
  assert.equal(auth, 'Bearer TEST_ACCESS_TOKEN_123');
});

test('installGate: fetch override returns synthetic manifest for /api/manifest', async () => {
  const { win } = makeFakeWindow({ path: '/societist' });
  const supabase = makeFakeSupabase({ access_token: 'tok' });

  installGate({ supabase, win });

  const res = await win.fetch('/api/manifest');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].filename, 'societist.json');
  assert.equal(body.files[0].is_fixture, false);
});

test('installGate: unrelated fetches pass through untouched', async () => {
  const { win, calls } = makeFakeWindow({ path: '/societist' });
  const supabase = makeFakeSupabase({ access_token: 'tok' });

  installGate({ supabase, win });

  await win.fetch('/some/other/url.json');
  assert.equal(calls.origFetchCalls.length, 1);
  assert.equal(calls.origFetchCalls[0].url, '/some/other/url.json');
});

test('installGate: /auth/callback forwards to `next` and calls getSession first', async () => {
  const { win, calls } = makeFakeWindow({ path: '/auth/callback', search: '?next=%2Fsocietist' });
  const supabase = makeFakeSupabase(null);

  const result = installGate({ supabase, win });
  assert.equal(result.mode, 'callback');
  assert.equal(result.next, '/societist');

  // Wait a tick for the async getSession().then(replace) chain to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.replaceCalls, ['/societist']);
});

test('installGate: /auth/callback rejects open redirects in `next`', async () => {
  const { win, calls } = makeFakeWindow({
    path: '/auth/callback',
    search: '?next=https%3A%2F%2Fevil.example.com',
  });
  const supabase = makeFakeSupabase(null);

  const result = installGate({ supabase, win });
  assert.equal(result.next, '/', 'external URL in next should fall back to `/`');

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.replaceCalls, ['/']);
});
