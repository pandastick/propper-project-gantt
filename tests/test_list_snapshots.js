/**
 * tests/test_list_snapshots.js
 *
 * Unit tests for netlify/functions/list-snapshots.js. Mirrors the stub
 * style used by test_get_roadmap_supabase.js — no live Supabase calls.
 *
 * Run: node tests/test_list_snapshots.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Env vars must be set before require() so the handler sees them.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

const mod = require(path.join(__dirname, '..', 'netlify', 'functions', 'list-snapshots.js'));
const { handler, _internal } = mod;

// ─── Helpers ─────────────────────────────────────────────────────────────

function installFetchStub(routeTable) {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    for (const [matcher, handlerFn] of routeTable) {
      if (typeof matcher === 'string' ? String(url) === matcher : matcher.test(String(url))) {
        const { status, body } = await handlerFn(String(url), opts);
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          json: async () => body,
        };
      }
    }
    throw new Error(`Unstubbed fetch: ${url}`);
  };
  return {
    calls,
    restore: () => { global.fetch = origFetch; },
  };
}

function makeEvent({ method = 'GET', slug, projectId, auth = 'Bearer jwt-abc' } = {}) {
  const qs = {};
  if (slug !== undefined) qs.slug = slug;
  if (projectId !== undefined) qs.project_id = projectId;
  return {
    httpMethod: method,
    headers: auth ? { Authorization: auth } : {},
    queryStringParameters: qs,
  };
}

// ─── extractBearer ───────────────────────────────────────────────────────

test('extractBearer handles present/absent/malformed tokens', () => {
  const { extractBearer } = _internal;
  assert.equal(extractBearer({ Authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(extractBearer({ authorization: 'bearer  xyz' }), 'xyz');
  assert.equal(extractBearer({}), null);
  assert.equal(extractBearer({ Authorization: 'Basic abc' }), null);
});

// ─── Handler rejection paths ─────────────────────────────────────────────

test('handler rejects missing Authorization with 401', async () => {
  const res = await handler(makeEvent({ slug: 'societist', auth: null }));
  assert.equal(res.statusCode, 401);
});

test('handler rejects request with neither slug nor project_id (400)', async () => {
  const res = await handler(makeEvent({}));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /slug|project_id/i);
});

test('handler rejects invalid slug format (400)', async () => {
  const res = await handler(makeEvent({ slug: 'Bad Slug!' }));
  assert.equal(res.statusCode, 400);
});

// ─── Handler lookup paths ────────────────────────────────────────────────

test('handler returns 403 when slug lookup returns empty (RLS / non-existent)', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ slug: 'unknown' }));
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});

test('handler returns 200 with empty list when project has no snapshots', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({
      status: 200,
      body: [{ id: 'proj-1' }],
    })],
    [/\/rest\/v1\/snapshots\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ slug: 'societist' }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { snapshots: [] });
  } finally { restore(); }
});

test('handler returns 200 with snapshots sorted by created_at DESC', async () => {
  // Return rows already sorted — the function forwards PostgREST's order
  // directive, so we assert on both the URL and the response shape.
  const rows = [
    {
      id: 'snap-3', kind: 'pushed', label: 'Q2 push',
      notes: null, pushed_at: '2026-04-17T10:00:00Z',
      created_at: '2026-04-17T09:00:00Z',
      created_by: 'user-1',
      source_sync_event_id: 'evt-2',
      pushed_sync_event_id: 'evt-3',
    },
    {
      id: 'snap-2', kind: 'snapshot', label: 'before replan',
      notes: 'manual save', pushed_at: null,
      created_at: '2026-04-16T12:00:00Z',
      created_by: 'user-1',
      source_sync_event_id: null,
      pushed_sync_event_id: null,
    },
    {
      id: 'snap-1', kind: 'import', label: 'Notion pull 26-04-15 10:00',
      notes: null, pushed_at: null,
      created_at: '2026-04-15T10:00:00Z',
      created_by: 'user-1',
      source_sync_event_id: 'evt-1',
      pushed_sync_event_id: null,
    },
  ];
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({
      status: 200, body: [{ id: 'proj-1' }],
    })],
    [/\/rest\/v1\/snapshots\?/, () => ({ status: 200, body: rows })],
    [/\/rest\/v1\/profiles\?/, () => ({
      status: 200, body: [{ id: 'user-1', initials: 'PP' }],
    })],
  ];
  const { restore, calls } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ slug: 'societist' }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshots.length, 3);
    // Verify descending order survives the handler unchanged.
    assert.equal(body.snapshots[0].id, 'snap-3');
    assert.equal(body.snapshots[1].id, 'snap-2');
    assert.equal(body.snapshots[2].id, 'snap-1');
    // Initials enriched from profiles lookup.
    assert.equal(body.snapshots[0].created_by_initials, 'PP');

    // Verify the function asked PostgREST for order=created_at.desc.
    const snapshotCall = calls.find((c) => /\/rest\/v1\/snapshots\?/.test(c.url));
    assert.ok(snapshotCall, 'snapshots endpoint was called');
    assert.match(snapshotCall.url, /order=created_at\.desc/);
  } finally { restore(); }
});

test('snapshots missing an initials row get created_by_initials=null (graceful fallback)', async () => {
  const rows = [
    { id: 'snap-1', kind: 'import', label: 'pull', notes: null, pushed_at: null,
      created_at: '2026-04-19T10:00:00Z', created_by: 'user-ghost',
      source_sync_event_id: null, pushed_sync_event_id: null },
  ];
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: 'proj-1' }] })],
    [/\/rest\/v1\/snapshots\?/, () => ({ status: 200, body: rows })],
    [/\/rest\/v1\/profiles\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ slug: 'societist' }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshots[0].created_by_initials, null);
  } finally { restore(); }
});

test('list response does NOT include the payload column (verified via select= clause)', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({
      status: 200, body: [{ id: 'proj-1' }],
    })],
    [/\/rest\/v1\/snapshots\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore, calls } = installFetchStub(routes);
  try {
    await handler(makeEvent({ slug: 'societist' }));
    const snapshotCall = calls.find((c) => /\/rest\/v1\/snapshots\?/.test(c.url));
    assert.ok(snapshotCall, 'snapshots endpoint was called');

    // Extract the select= clause and assert payload is NOT in it.
    const m = snapshotCall.url.match(/[?&]select=([^&]+)/);
    assert.ok(m, 'URL has a select= clause');
    const selectClause = decodeURIComponent(m[1]);
    assert.ok(
      !selectClause.split(',').includes('payload'),
      `select= must not include 'payload', got: ${selectClause}`,
    );
    // Sanity-check: the metadata columns we DO want are there.
    const cols = selectClause.split(',');
    for (const expected of [
      'id', 'kind', 'label', 'notes',
      'pushed_at', 'created_at', 'created_by',
      'source_sync_event_id', 'pushed_sync_event_id',
    ]) {
      assert.ok(cols.includes(expected), `select= includes ${expected}`);
    }
  } finally { restore(); }
});

test('handler returns 500 when Supabase snapshots fetch fails', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({
      status: 200, body: [{ id: 'proj-1' }],
    })],
    [/\/rest\/v1\/snapshots\?/, () => ({ status: 500, body: 'boom' })],
  ];
  const { restore } = installFetchStub(routes);
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await handler(makeEvent({ slug: 'societist' }));
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Internal error');
  } finally {
    console.error = origErr;
    restore();
  }
});
