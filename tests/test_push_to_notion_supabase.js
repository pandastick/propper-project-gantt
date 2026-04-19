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

// Shared fixtures / helpers for handler-level tests.
const SNAPSHOT_ID = '11111111-1111-1111-1111-111111111111';
const PAGE_ID_A = '7159e1fc-caab-83b7-9ee3-818c84f19cf8';
const PAGE_ID_B = '3439e1fc-caab-8166-aa76-c3992cdb8a80';
const PAGE_ID_C = '2919e1fc-caab-4411-aa77-c3992cdb8a88';

function taskRow(pageId, status, startDate, endDate) {
  return {
    id: pageId,
    notion_page_id: pageId,
    start_date: startDate,
    end_date: endDate,
    notion_sync_status: status,
    name: `Task ${pageId.slice(0, 4)}`,
  };
}

// Build a baseline route table suitable for most handler tests. Individual
// tests override the snapshots SELECT / tasks SELECT / Notion branches as
// needed. snapshotRows is what the SELECT on ppgantt.snapshots returns.
function baseRoutes({
  snapshotRows,
  tasksRows = [],
  notionPatchStatus = 200,
  notionPatchBody = { object: 'page' },
  notionVerifyStart,
  notionVerifyEnd,
  snapshotPatchStatus = 204,
  syncEventStatus = 201,
  recorder = {},
}) {
  const recorded = recorder;
  recorded.snapshotPatches = recorded.snapshotPatches || [];
  recorded.syncEventInserts = recorded.syncEventInserts || [];
  recorded.taskPatches = recorded.taskPatches || [];
  recorded.notionCalls = recorded.notionCalls || [];

  return [
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: 'user-1' } })],
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: 'proj-1', slug: 'societist' }] })],
    [/\/rest\/v1\/snapshots\?select=/, () => ({ status: 200, body: snapshotRows })],
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
    [/\/rest\/v1\/profiles\?/, () => ({ status: 200, body: [{ display_name: 'Peter' }] })],
    [/\/rest\/v1\/tasks\?.*notion_sync_status=in/, () => ({ status: 200, body: tasksRows })],
    [/https:\/\/api\.notion\.com\/v1\/pages\/.*$/, (url, opts) => {
      recorded.notionCalls.push({ url, method: opts && opts.method });
      if (opts && opts.method === 'PATCH') {
        return { status: notionPatchStatus, body: notionPatchBody };
      }
      // Verify read-back. Default returns the requested page_id's dates if
      // the test set them; otherwise echoes 2026-04-14/14.
      return {
        status: 200,
        body: {
          properties: {
            'Start Date': { type: 'date', date: { start: notionVerifyStart || '2026-04-14' } },
            'End Date':   { type: 'date', date: { start: notionVerifyEnd   || '2026-04-14' } },
          },
        },
      };
    }],
    // snapshots PATCH (flip) — must come BEFORE the generic tasks PATCH so
    // `/rest/v1/tasks?id=eq.` doesn't swallow it. Routes are matched in
    // order with first-wins.
    [/\/rest\/v1\/snapshots\?id=eq\./, (_u, opts) => {
      recorded.snapshotPatches.push(JSON.parse(opts.body));
      return { status: snapshotPatchStatus, body: '' };
    }],
    [/\/rest\/v1\/tasks\?id=eq\./, (_u, opts) => {
      recorded.taskPatches.push(opts && opts.body ? JSON.parse(opts.body) : null);
      return { status: 204, body: '' };
    }],
    [/\/rest\/v1\/sync_events/, (_u, opts) => {
      recorded.syncEventInserts.push(JSON.parse(opts.body));
      return { status: syncEventStatus, body: [{ id: 'evt-1' }] };
    }],
  ];
}

function snapshotRow(overrides = {}) {
  return {
    id: SNAPSHOT_ID,
    project_id: 'proj-1',
    kind: 'snapshot',
    label: 'pre-push',
    notes: null,
    payload: [
      taskRow(PAGE_ID_A, 'clean', '2026-04-14', '2026-04-14'),
    ],
    source_sync_event_id: null,
    pushed_at: null,
    pushed_sync_event_id: null,
    created_at: '2026-04-18T12:00:00Z',
    created_by: 'user-1',
    ...overrides,
  };
}

test('handler writes a sync_events row on success', async () => {
  const recorded = {};
  const routes = baseRoutes({
    snapshotRows: [snapshotRow()],
    tasksRows: [], // live table intentionally empty — data comes from snapshot
    recorder: recorded,
  });
  const { restore, calls: fetchCalls } = installFetchStub(routes);
  try {
    const event = {
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    };
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.verifiedCount, 1);
    assert.equal(body.failedCount, 0);
    assert.equal(body.status, 'success');
    assert.equal(body.syncEventId, 'evt-1');

    assert.equal(recorded.syncEventInserts.length, 1, 'exactly one sync_events insert');
    assert.equal(recorded.syncEventInserts[0].direction, 'push_to_notion');
    assert.equal(recorded.syncEventInserts[0].status, 'success');
    assert.equal(recorded.syncEventInserts[0].rows_read, 1);
    assert.equal(recorded.syncEventInserts[0].rows_written, 1);
    assert.equal(recorded.syncEventInserts[0].actor_id, 'user-1');

    // sequencing sanity: notion PATCH happens AFTER snapshot SELECT, BEFORE sync_events POST
    const urls = fetchCalls.map((c) => c.url);
    const snapshotSelectIdx = urls.findIndex((u) => /\/rest\/v1\/snapshots\?select=/.test(u));
    const notionPatchIdx = urls.findIndex((u, i) =>
      /api\.notion\.com\/v1\/pages\//.test(u) && fetchCalls[i].method === 'PATCH',
    );
    const syncEventIdx = urls.findIndex((u) => /\/rest\/v1\/sync_events/.test(u));
    assert.ok(snapshotSelectIdx >= 0, 'snapshots SELECT happened');
    assert.ok(snapshotSelectIdx < notionPatchIdx, 'snapshots SELECT before Notion PATCH');
    assert.ok(notionPatchIdx < syncEventIdx, 'Notion PATCH before sync_events insert');
  } finally { restore(); }
});

test('handler returns 401 when Authorization missing', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
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
      body: JSON.stringify({ slug: 'unseen', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});

// ─── Snapshot-backed push contract ──────────────────────────────────────

test('push rejects request missing snapshot_id', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer jwt-abc' },
    body: JSON.stringify({ slug: 'societist' }),
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /snapshot_id/i);
});

test('push rejects non-UUID snapshot_id', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer jwt-abc' },
    body: JSON.stringify({ slug: 'societist', snapshot_id: 'not-a-uuid' }),
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /snapshot_id/i);
});

test('push rejects already-pushed snapshot', async () => {
  const routes = baseRoutes({
    snapshotRows: [snapshotRow({ kind: 'pushed', pushed_at: '2026-04-18T10:00:00Z' })],
  });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.match(body.error, /already pushed/i);
  } finally { restore(); }
});

test('push returns 404 when snapshot not found', async () => {
  const routes = baseRoutes({ snapshotRows: [] });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 404);
  } finally { restore(); }
});

test('push reads tasks from snapshot payload, not ppgantt.tasks', async () => {
  // Live tasks table is EMPTY, but the snapshot payload has two pushable
  // rows. The handler must source from payload, so two Notion PATCHes fire.
  const recorded = {};
  const snap = snapshotRow({
    payload: [
      taskRow(PAGE_ID_A, 'clean',       '2026-04-14', '2026-04-14'),
      taskRow(PAGE_ID_B, 'local_ahead', '2026-04-14', '2026-04-14'),
    ],
  });
  const routes = baseRoutes({
    snapshotRows: [snap],
    tasksRows: [], // live table empty
    recorder: recorded,
  });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200);
    const patches = recorded.notionCalls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 2, 'two Notion PATCHes from snapshot payload');
    const body = JSON.parse(res.body);
    assert.equal(body.verifiedCount, 2);
  } finally { restore(); }
});

test('push filters snapshot payload by notion_sync_status', async () => {
  const recorded = {};
  const snap = snapshotRow({
    payload: [
      taskRow(PAGE_ID_A, 'clean',       '2026-04-14', '2026-04-14'),
      taskRow(PAGE_ID_B, 'local_ahead', '2026-04-14', '2026-04-14'),
      taskRow(PAGE_ID_C, 'conflict',    '2026-04-14', '2026-04-14'), // skipped
    ],
  });
  const routes = baseRoutes({ snapshotRows: [snap], recorder: recorded });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200);
    const patches = recorded.notionCalls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 2, 'only clean+local_ahead rows push');
    const body = JSON.parse(res.body);
    assert.equal(body.totalChanges, 2);
  } finally { restore(); }
});

test('push flips snapshot on unchunked success', async () => {
  const recorded = {};
  const routes = baseRoutes({
    snapshotRows: [snapshotRow()],
    recorder: recorded,
  });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshotFlipped, true);
    assert.equal(body.snapshotFlipFailed, false);
    assert.equal(body.snapshotId, SNAPSHOT_ID);

    assert.equal(recorded.snapshotPatches.length, 1, 'snapshots PATCH fired');
    const patch = recorded.snapshotPatches[0];
    assert.equal(patch.kind, 'pushed');
    assert.ok(patch.pushed_at, 'pushed_at stamped');
    assert.equal(patch.pushed_sync_event_id, 'evt-1');
  } finally { restore(); }
});

test('push does NOT flip snapshot on is_final_chunk=false', async () => {
  const recorded = {};
  const routes = baseRoutes({
    snapshotRows: [snapshotRow()],
    recorder: recorded,
  });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({
        slug: 'societist',
        snapshot_id: SNAPSHOT_ID,
        notion_page_ids: [PAGE_ID_A],
        is_final_chunk: false,
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshotFlipped, false);
    assert.equal(recorded.snapshotPatches.length, 0, 'no snapshot flip on non-final chunk');
  } finally { restore(); }
});

test('push flips snapshot only on final chunk', async () => {
  const recorded = {};
  const snap = snapshotRow({
    payload: [
      taskRow(PAGE_ID_A, 'clean', '2026-04-14', '2026-04-14'),
      taskRow(PAGE_ID_B, 'clean', '2026-04-14', '2026-04-14'),
    ],
  });
  const routes = baseRoutes({ snapshotRows: [snap], recorder: recorded });
  const { restore } = installFetchStub(routes);
  try {
    // First chunk, NOT final.
    const res1 = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({
        slug: 'societist',
        snapshot_id: SNAPSHOT_ID,
        notion_page_ids: [PAGE_ID_A],
        is_final_chunk: false,
      }),
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(JSON.parse(res1.body).snapshotFlipped, false);
    assert.equal(recorded.snapshotPatches.length, 0, 'no flip after first chunk');

    // Final chunk.
    const res2 = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({
        slug: 'societist',
        snapshot_id: SNAPSHOT_ID,
        notion_page_ids: [PAGE_ID_B],
        is_final_chunk: true,
      }),
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.parse(res2.body).snapshotFlipped, true);
    assert.equal(recorded.snapshotPatches.length, 1, 'flip fires after final chunk');
    assert.equal(recorded.snapshotPatches[0].kind, 'pushed');
  } finally { restore(); }
});

test('push does NOT flip on partial status', async () => {
  const recorded = {};
  const snap = snapshotRow({
    payload: [
      taskRow(PAGE_ID_A, 'clean', '2026-04-14', '2026-04-14'),
      taskRow(PAGE_ID_B, 'clean', '2026-04-14', '2026-04-14'),
    ],
  });
  // Make the second Notion PATCH fail so overallStatus becomes 'partial'.
  let notionPatchCount = 0;
  const routes = baseRoutes({ snapshotRows: [snap], recorder: recorded });
  // Replace the Notion route with a stateful one that fails the 2nd patch.
  const notionIdx = routes.findIndex(([m]) => m instanceof RegExp && m.source.includes('api\\.notion\\.com'));
  assert.ok(notionIdx >= 0, 'found notion route in baseRoutes');
  routes[notionIdx] = [/https:\/\/api\.notion\.com\/v1\/pages\/.*$/, (url, opts) => {
    recorded.notionCalls.push({ url, method: opts && opts.method });
    if (opts && opts.method === 'PATCH') {
      notionPatchCount++;
      if (notionPatchCount === 2) {
        return { status: 500, body: { message: 'boom' } };
      }
      return { status: 200, body: { object: 'page' } };
    }
    return {
      status: 200,
      body: {
        properties: {
          'Start Date': { type: 'date', date: { start: '2026-04-14' } },
          'End Date':   { type: 'date', date: { start: '2026-04-14' } },
        },
      },
    };
  }];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'partial');
    assert.equal(body.snapshotFlipped, false, 'no flip on partial');
    assert.equal(recorded.snapshotPatches.length, 0);
  } finally { restore(); }
});

test('push returns snapshotFlipFailed=true when UPDATE fails', async () => {
  const recorded = {};
  const routes = baseRoutes({
    snapshotRows: [snapshotRow()],
    snapshotPatchStatus: 500,
    recorder: recorded,
  });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200, 'still 200 even when flip fails');
    const body = JSON.parse(res.body);
    assert.equal(body.snapshotFlipped, false);
    assert.equal(body.snapshotFlipFailed, true);
    assert.equal(recorded.snapshotPatches.length, 1, 'flip was attempted');
  } finally { restore(); }
});

test('push response echoes snapshotId', async () => {
  const routes = baseRoutes({ snapshotRows: [snapshotRow()] });
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist', snapshot_id: SNAPSHOT_ID }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshotId, SNAPSHOT_ID);
  } finally { restore(); }
});
