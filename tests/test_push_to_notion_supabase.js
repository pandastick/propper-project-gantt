/**
 * tests/test_push_to_notion_supabase.js
 *
 * Exercises netlify/functions/push-to-notion.js with stubbed fetch for
 * both Supabase REST and Notion REST. Covers:
 *   - pushTasksToNotion happy path (patch + read-back match = verified)
 *   - pushTasksToNotion mismatch path (read-back wrong = patched_not_verified)
 *   - pushTasksToNotion patch failure
 *   - full handler: Supabase fetch sequencing, sync_events insertion
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.NOTION_WRITE_TOKEN = 'ntn_test';

const mod = require(path.join(__dirname, '..', 'netlify', 'functions', 'push-to-notion.js'));
const { handler, _internal } = mod;

// ─── Fetch stub ─────────────────────────────────────────────────────────

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

// ─── pushTasksToNotion unit tests ────────────────────────────────────────

test('pushTasksToNotion marks verified rows when read-back matches', async () => {
  const { pushTasksToNotion } = _internal;
  const mapping = {
    start_field: 'Start Date',
    end_field: 'End Date',
    updated_by_field: 'PPG Last Updated By',
    last_sync_field: 'PPG Last Sync',
  };
  const tasks = [
    {
      id: 't1',
      notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
      start_date: '2026-04-14',
      end_date: '2026-04-15',
    },
  ];
  const notionClient = {
    patch: async () => ({ ok: true, status: 200, body: { object: 'page' } }),
    get: async () => ({
      ok: true,
      status: 200,
      page: {
        properties: {
          'Start Date': { type: 'date', date: { start: '2026-04-14' } },
          'End Date': { type: 'date', date: { start: '2026-04-15' } },
        },
      },
    }),
  };
  const out = await pushTasksToNotion({
    tasks,
    mapping,
    userDisplayName: 'Peter',
    syncTimestamp: '2026-04-18T12:00:00Z',
    notionClient,
    sleepMs: 0,
  });
  assert.equal(out.verifiedCount, 1);
  assert.equal(out.failedCount, 0);
  assert.equal(out.results[0].status, 'verified');
});

test('pushTasksToNotion flags mismatched read-back as patched_not_verified', async () => {
  const { pushTasksToNotion } = _internal;
  const mapping = { start_field: 'Start Date', end_field: 'End Date' };
  const tasks = [{
    id: 't1', notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
    start_date: '2026-04-14', end_date: '2026-04-15',
  }];
  const notionClient = {
    patch: async () => ({ ok: true, status: 200, body: {} }),
    get: async () => ({
      ok: true,
      status: 200,
      page: {
        properties: {
          'Start Date': { type: 'date', date: { start: '2026-04-14' } },
          'End Date': { type: 'date', date: { start: '2026-04-16' } }, // wrong
        },
      },
    }),
  };
  const out = await pushTasksToNotion({
    tasks, mapping, userDisplayName: 'Peter',
    syncTimestamp: '2026-04-18T12:00:00Z',
    notionClient, sleepMs: 0,
  });
  assert.equal(out.verifiedCount, 0);
  assert.equal(out.failedCount, 1);
  assert.equal(out.results[0].status, 'patched_not_verified');
});

test('pushTasksToNotion flags patch failures and continues', async () => {
  const { pushTasksToNotion } = _internal;
  const mapping = { start_field: 'Start Date', end_field: 'End Date' };
  const tasks = [
    { id: 't1', notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8', start_date: '2026-04-14', end_date: '2026-04-14' },
    { id: 't2', notion_page_id: '3439e1fc-caab-8166-aa76-c3992cdb8a80', start_date: '2026-04-20', end_date: '2026-04-20' },
  ];
  let callIdx = 0;
  const notionClient = {
    patch: async () => {
      callIdx++;
      if (callIdx === 1) return { ok: false, status: 429, body: { message: 'rate limited' } };
      return { ok: true, status: 200, body: {} };
    },
    get: async () => ({
      ok: true,
      status: 200,
      page: {
        properties: {
          'Start Date': { type: 'date', date: { start: '2026-04-20' } },
          'End Date': { type: 'date', date: { start: '2026-04-20' } },
        },
      },
    }),
  };
  const out = await pushTasksToNotion({
    tasks, mapping, userDisplayName: 'Peter',
    syncTimestamp: '2026-04-18T12:00:00Z',
    notionClient, sleepMs: 0,
  });
  assert.equal(out.results[0].status, 'patch_failed');
  assert.equal(out.results[1].status, 'verified');
  assert.equal(out.verifiedCount, 1);
  assert.equal(out.failedCount, 1);
});

test('pushTasksToNotion rejects missing dates with invalid_input', async () => {
  const { pushTasksToNotion } = _internal;
  const mapping = { start_field: 'Start Date', end_field: 'End Date' };
  const tasks = [{ id: 't1', notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8', start_date: null, end_date: null }];
  const notionClient = { patch: async () => { throw new Error('nope'); }, get: async () => { throw new Error('nope'); } };
  const out = await pushTasksToNotion({
    tasks, mapping, userDisplayName: 'x',
    syncTimestamp: '2026-04-18T12:00:00Z',
    notionClient, sleepMs: 0,
  });
  assert.equal(out.results[0].status, 'invalid_input');
});

// ─── Handler end-to-end ─────────────────────────────────────────────────

test('handler writes a sync_events row on success', async () => {
  const calls = [];
  const routes = [
    // auth/user — returns current user id
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: 'user-1' } })],
    // project lookup
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: 'proj-1', slug: 'societist' }] })],
    // schema mapping
    [/\/rest\/v1\/notion_schema_mappings\?/, () => ({
      status: 200,
      body: [{
        notion_db_id: 'db-1',
        mapping: {
          start_field: 'Start Date',
          end_field: 'End Date',
          updated_by_field: 'PPG Last Updated By',
          last_sync_field: 'PPG Last Sync',
        },
      }],
    })],
    // profiles
    [/\/rest\/v1\/profiles\?/, () => ({ status: 200, body: [{ display_name: 'Peter' }] })],
    // tasks
    [/\/rest\/v1\/tasks\?.*notion_sync_status=in/, () => ({
      status: 200,
      body: [{
        id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
        notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
        start_date: '2026-04-14', end_date: '2026-04-14',
        notion_sync_status: 'clean',
      }],
    })],
    // Notion patch
    [/https:\/\/api\.notion\.com\/v1\/pages\/.*$/, (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        return { status: 200, body: { object: 'page' } };
      }
      return {
        status: 200,
        body: {
          properties: {
            'Start Date': { type: 'date', date: { start: '2026-04-14' } },
            'End Date': { type: 'date', date: { start: '2026-04-14' } },
          },
        },
      };
    }],
    // tasks PATCH (local row update)
    [/\/rest\/v1\/tasks\?id=eq\./, () => ({ status: 204, body: '' })],
    // sync_events insert — record that we got here
    [/\/rest\/v1\/sync_events/, (_u, opts, allCalls) => {
      calls.push({ type: 'sync_event_insert', body: JSON.parse(opts.body) });
      return { status: 201, body: [{ id: 'evt-1' }] };
    }],
  ];
  const { restore, calls: fetchCalls } = installFetchStub(routes);
  try {
    const event = {
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist' }),
    };
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.verifiedCount, 1);
    assert.equal(body.failedCount, 0);
    assert.equal(body.status, 'success');
    assert.equal(body.syncEventId, 'evt-1');

    assert.equal(calls.length, 1, 'exactly one sync_events insert');
    assert.equal(calls[0].body.direction, 'push_to_notion');
    assert.equal(calls[0].body.status, 'success');
    assert.equal(calls[0].body.rows_read, 1);
    assert.equal(calls[0].body.rows_written, 1);
    assert.equal(calls[0].body.actor_id, 'user-1');

    // sequencing sanity: notion PATCH happens AFTER tasks SELECT, BEFORE sync_events POST
    const urls = fetchCalls.map((c) => c.url);
    const tasksSelectIdx = urls.findIndex((u) => /\/rest\/v1\/tasks\?.*notion_sync_status=in/.test(u));
    const notionPatchIdx = urls.findIndex((u, i) =>
      /api\.notion\.com\/v1\/pages\//.test(u) && fetchCalls[i].method === 'PATCH',
    );
    const syncEventIdx = urls.findIndex((u) => /\/rest\/v1\/sync_events/.test(u));
    assert.ok(tasksSelectIdx < notionPatchIdx, 'tasks SELECT before Notion PATCH');
    assert.ok(notionPatchIdx < syncEventIdx, 'Notion PATCH before sync_events insert');
  } finally { restore(); }
});

test('handler returns 401 when Authorization missing', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ slug: 'societist' }),
  });
  assert.equal(res.statusCode, 401);
});

test('handler returns 403 when RLS hides the project', async () => {
  const routes = [
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: 'user-1' } })],
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'unseen' }),
    });
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});
