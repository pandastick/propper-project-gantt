/**
 * tests/test_snapshot.js
 *
 * Unit tests for netlify/functions/snapshot.js. Mirrors the stub style
 * used by test_list_snapshots.js and test_push_to_notion_supabase.js —
 * no live Supabase calls.
 *
 * Run: node tests/test_snapshot.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Env vars must be set before require() so the handler sees them.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

const mod = require(path.join(__dirname, '..', 'netlify', 'functions', 'snapshot.js'));
const { handler, _internal } = mod;

// ─── Helpers ─────────────────────────────────────────────────────────────

function installFetchStub(routeTable) {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {}, method: (opts && opts.method) || 'GET' });
    for (const [matcher, handlerFn] of routeTable) {
      const ok =
        typeof matcher === 'string'
          ? String(url) === matcher
          : matcher.test(String(url));
      if (ok) {
        const { status, body } = await handlerFn(String(url), opts, calls);
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          json: async () => body,
        };
      }
    }
    throw new Error(`Unstubbed fetch: ${opts && opts.method} ${url}`);
  };
  return {
    calls,
    restore: () => { global.fetch = origFetch; },
  };
}

const SNAPSHOT_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

function viewerPayload(tasks) {
  return {
    source: 'supabase',
    schema_mapping: {},
    tasks: tasks || [{ id: 't1', start: '2026-04-14', end: '2026-04-15' }],
  };
}

function makeEvent({ method = 'GET', id, body, auth = 'Bearer jwt-abc' } = {}) {
  const qs = {};
  if (id !== undefined) qs.id = id;
  return {
    httpMethod: method,
    headers: auth ? { Authorization: auth } : {},
    queryStringParameters: qs,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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

// ─── autoSnapshotLabel format ───────────────────────────────────────────

test('autoSnapshotLabel matches "Snapshot YY-MM-DD HH:MM" UTC 2-digit year', () => {
  const { autoSnapshotLabel } = _internal;
  // Fixed UTC date: 2026-04-18T09:05:00Z → "Snapshot 26-04-18 09:05"
  const d = new Date(Date.UTC(2026, 3, 18, 9, 5, 0));
  assert.equal(autoSnapshotLabel(d), 'Snapshot 26-04-18 09:05');
  // Leading-zero month/day, single-digit year (2007)
  const d2 = new Date(Date.UTC(2007, 0, 3, 0, 0, 0));
  assert.equal(autoSnapshotLabel(d2), 'Snapshot 07-01-03 00:00');
});

// ─── Method rejection ───────────────────────────────────────────────────

test('handler rejects PUT with 405', async () => {
  const res = await handler({
    httpMethod: 'PUT',
    headers: { Authorization: 'Bearer jwt-abc' },
    queryStringParameters: {},
  });
  assert.equal(res.statusCode, 405);
});

test('handler rejects PATCH with 405', async () => {
  const res = await handler({
    httpMethod: 'PATCH',
    headers: { Authorization: 'Bearer jwt-abc' },
    queryStringParameters: {},
  });
  assert.equal(res.statusCode, 405);
});

// ─── GET ────────────────────────────────────────────────────────────────

test('GET rejects missing Authorization with 401', async () => {
  const res = await handler(makeEvent({ method: 'GET', id: SNAPSHOT_ID, auth: null }));
  assert.equal(res.statusCode, 401);
});

test('GET rejects invalid id with 400', async () => {
  const res = await handler(makeEvent({ method: 'GET', id: 'not-a-uuid' }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /id/i);
});

test('GET rejects missing id with 400', async () => {
  const res = await handler(makeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 400);
});

test('GET returns 404 when snapshot not found (empty array)', async () => {
  const routes = [
    [/\/rest\/v1\/snapshots\?select=\*&id=eq\./, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ method: 'GET', id: SNAPSHOT_ID }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /not found/i);
  } finally { restore(); }
});

test('GET returns 200 with snapshot row including payload', async () => {
  const payload = viewerPayload();
  const row = {
    id: SNAPSHOT_ID,
    project_id: PROJECT_ID,
    kind: 'snapshot',
    label: 'pre-replan',
    notes: 'before the scope change',
    payload,
    source_sync_event_id: null,
    pushed_at: null,
    pushed_sync_event_id: null,
    created_at: '2026-04-18T12:00:00Z',
    created_by: USER_ID,
  };
  const routes = [
    [/\/rest\/v1\/snapshots\?select=\*&id=eq\./, (url) => {
      // Sanity: the function requests select=* so payload comes back.
      assert.match(url, /select=\*/);
      assert.match(url, /id=eq\./);
      return { status: 200, body: [row] };
    }],
  ];
  const { restore, calls } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ method: 'GET', id: SNAPSHOT_ID }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, SNAPSHOT_ID);
    assert.deepEqual(body.payload, payload);
    // Accept-Profile: ppgantt is set on the fetch.
    const getCall = calls.find((c) => /\/rest\/v1\/snapshots\?/.test(c.url));
    assert.ok(getCall, 'snapshots endpoint was called');
    const headers = getCall.opts.headers || {};
    assert.equal(headers['Accept-Profile'], 'ppgantt');
  } finally { restore(); }
});

// ─── POST ───────────────────────────────────────────────────────────────

test('POST rejects missing Authorization with 401', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    auth: null,
    body: { slug: 'societist', payload: viewerPayload() },
  }));
  assert.equal(res.statusCode, 401);
});

test('POST rejects missing slug and project_id (400)', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    body: { payload: viewerPayload() },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /slug|project_id/i);
});

test('POST rejects missing payload (400)', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    body: { slug: 'societist' },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /payload/i);
});

test('POST rejects non-object payload (array = 400)', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    body: { slug: 'societist', payload: [{ id: 't1' }] },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /payload/i);
});

test('POST rejects non-object payload (string = 400)', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    body: { slug: 'societist', payload: 'not an object' },
  }));
  assert.equal(res.statusCode, 400);
});

test('POST rejects payload without tasks array (400)', async () => {
  const res = await handler(makeEvent({
    method: 'POST',
    body: { slug: 'societist', payload: { source: 'supabase' } },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /tasks/i);
});

test('POST rejects label longer than 200 chars (400)', async () => {
  const longLabel = 'x'.repeat(201);
  const res = await handler(makeEvent({
    method: 'POST',
    body: { slug: 'societist', payload: viewerPayload(), label: longLabel },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /label/i);
});

test('POST auto-generates label matching "Snapshot YY-MM-DD HH:MM" when not provided', async () => {
  const inserted = [];
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: PROJECT_ID }] })],
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: USER_ID } })],
    [/\/rest\/v1\/snapshots$/, (_u, opts) => {
      const parsed = JSON.parse(opts.body);
      inserted.push(parsed);
      return {
        status: 201,
        body: [{
          id: SNAPSHOT_ID,
          project_id: PROJECT_ID,
          kind: 'snapshot',
          label: parsed.label,
          notes: parsed.notes,
          payload: parsed.payload,
          created_by: parsed.created_by,
          created_at: '2026-04-18T12:00:00Z',
          pushed_at: null,
          pushed_sync_event_id: null,
          source_sync_event_id: null,
        }],
      };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'societist', payload: viewerPayload() },
    }));
    assert.equal(res.statusCode, 201);
    assert.equal(inserted.length, 1);
    assert.match(inserted[0].label, /^Snapshot \d{2}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const resp = JSON.parse(res.body);
    assert.equal(resp.snapshot.id, SNAPSHOT_ID);
    assert.match(resp.snapshot.label, /^Snapshot \d{2}-\d{2}-\d{2} \d{2}:\d{2}$/);
  } finally { restore(); }
});

test('POST uses provided label when given', async () => {
  const inserted = [];
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: PROJECT_ID }] })],
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: USER_ID } })],
    [/\/rest\/v1\/snapshots$/, (_u, opts) => {
      const parsed = JSON.parse(opts.body);
      inserted.push(parsed);
      return {
        status: 201,
        body: [{
          id: SNAPSHOT_ID,
          project_id: PROJECT_ID,
          kind: 'snapshot',
          label: parsed.label,
          notes: parsed.notes,
          payload: parsed.payload,
          created_by: parsed.created_by,
          created_at: '2026-04-18T12:00:00Z',
        }],
      };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'societist', payload: viewerPayload(), label: 'Before Q2 replan', notes: 'careful' },
    }));
    assert.equal(res.statusCode, 201);
    assert.equal(inserted[0].label, 'Before Q2 replan');
    assert.equal(inserted[0].notes, 'careful');
    assert.equal(inserted[0].kind, 'snapshot');
    assert.equal(inserted[0].created_by, USER_ID);
    assert.equal(inserted[0].project_id, PROJECT_ID);
  } finally { restore(); }
});

test('POST returns 201 with inserted row echoed under { snapshot }', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: PROJECT_ID }] })],
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: USER_ID } })],
    [/\/rest\/v1\/snapshots$/, (_u, opts) => {
      const parsed = JSON.parse(opts.body);
      return {
        status: 201,
        body: [{
          id: SNAPSHOT_ID,
          project_id: PROJECT_ID,
          kind: 'snapshot',
          label: parsed.label,
          notes: parsed.notes,
          payload: parsed.payload,
          created_by: parsed.created_by,
          created_at: '2026-04-18T12:00:00Z',
          pushed_at: null,
        }],
      };
    }],
  ];
  const { restore, calls } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'societist', payload: viewerPayload(), label: 'hi' },
    }));
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.snapshot, 'response has snapshot key');
    assert.equal(body.snapshot.id, SNAPSHOT_ID);
    assert.equal(body.snapshot.kind, 'snapshot');
    // Content-Profile: ppgantt is set on the insert.
    const insertCall = calls.find((c) =>
      /\/rest\/v1\/snapshots$/.test(c.url) && c.method === 'POST',
    );
    assert.ok(insertCall, 'snapshots insert was called');
    const headers = insertCall.opts.headers || {};
    assert.equal(headers['Content-Profile'], 'ppgantt');
    assert.equal(headers['Accept-Profile'], 'ppgantt');
    assert.match(String(headers.Prefer || ''), /return=representation/);
  } finally { restore(); }
});

test('POST resolves slug to project_id via projects lookup', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, (url) => {
      assert.match(url, /slug=eq\.societist/);
      return { status: 200, body: [{ id: PROJECT_ID }] };
    }],
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: USER_ID } })],
    [/\/rest\/v1\/snapshots$/, (_u, opts) => {
      const parsed = JSON.parse(opts.body);
      assert.equal(parsed.project_id, PROJECT_ID);
      return {
        status: 201,
        body: [{ id: SNAPSHOT_ID, ...parsed, created_at: 'x' }],
      };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'societist', payload: viewerPayload() },
    }));
    assert.equal(res.statusCode, 201);
  } finally { restore(); }
});

test('POST returns 403 when slug lookup returns empty (RLS)', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'unseen', payload: viewerPayload() },
    }));
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});

test('POST returns 401 when /auth/v1/user fails', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: PROJECT_ID }] })],
    [/\/auth\/v1\/user$/, () => ({ status: 401, body: { error: 'bad jwt' } })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({
      method: 'POST',
      body: { slug: 'societist', payload: viewerPayload() },
    }));
    assert.equal(res.statusCode, 401);
  } finally { restore(); }
});

// ─── DELETE ─────────────────────────────────────────────────────────────

test('DELETE rejects missing Authorization with 401', async () => {
  const res = await handler(makeEvent({ method: 'DELETE', id: SNAPSHOT_ID, auth: null }));
  assert.equal(res.statusCode, 401);
});

test('DELETE rejects invalid id (400)', async () => {
  const res = await handler(makeEvent({ method: 'DELETE', id: 'bogus' }));
  assert.equal(res.statusCode, 400);
});

test('DELETE rejects missing id (400)', async () => {
  const res = await handler(makeEvent({ method: 'DELETE' }));
  assert.equal(res.statusCode, 400);
});

test('DELETE returns 404 when delete returned empty array (RLS hid it)', async () => {
  const routes = [
    [/\/rest\/v1\/snapshots\?id=eq\./, (_u, opts) => {
      assert.equal(opts.method, 'DELETE');
      return { status: 200, body: [] };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ method: 'DELETE', id: SNAPSHOT_ID }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.match(body.error, /not found/i);
  } finally { restore(); }
});

test('DELETE returns 200 with {deleted: true, id} on success', async () => {
  const routes = [
    [/\/rest\/v1\/snapshots\?id=eq\./, (_u, opts) => {
      assert.equal(opts.method, 'DELETE');
      return { status: 200, body: [{ id: SNAPSHOT_ID, project_id: PROJECT_ID }] };
    }],
  ];
  const { restore, calls } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ method: 'DELETE', id: SNAPSHOT_ID }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.deleted, true);
    assert.equal(body.id, SNAPSHOT_ID);
    // Verify Prefer: return=representation + profile headers on the DELETE.
    const delCall = calls.find((c) => c.method === 'DELETE');
    assert.ok(delCall, 'DELETE call fired');
    const headers = delCall.opts.headers || {};
    assert.match(String(headers.Prefer || ''), /return=representation/);
    assert.equal(headers['Accept-Profile'], 'ppgantt');
    assert.equal(headers['Content-Profile'], 'ppgantt');
  } finally { restore(); }
});

test('DELETE returns 500 when supabase responds with an error', async () => {
  const routes = [
    [/\/rest\/v1\/snapshots\?id=eq\./, () => ({ status: 500, body: 'boom' })],
  ];
  const { restore } = installFetchStub(routes);
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await handler(makeEvent({ method: 'DELETE', id: SNAPSHOT_ID }));
    assert.equal(res.statusCode, 500);
  } finally {
    console.error = origErr;
    restore();
  }
});
