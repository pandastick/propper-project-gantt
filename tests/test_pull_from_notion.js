/**
 * tests/test_pull_from_notion.js
 *
 * Unit tests for netlify/functions/pull-from-notion.js. Covers:
 *   - deriveSyncStatus four-way matrix (plus 'new')
 *   - projectNotionPageToTask property extraction
 *   - upsertNotionPages insert / refresh / status-only branches
 *   - full handler wiring with stubbed Notion + Supabase fetch
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.NOTION_API_KEY = 'ntn_test';

const mod = require(path.join(__dirname, '..', 'netlify', 'functions', 'pull-from-notion.js'));
const { handler, _internal } = mod;

// ─── deriveSyncStatus four-way matrix ────────────────────────────────────

test('deriveSyncStatus: no local row returns "new"', () => {
  const s = _internal.deriveSyncStatus({
    localRow: null,
    notionLastEditedTime: '2026-04-18T10:00:00Z',
  });
  assert.equal(s, 'new');
});

test('deriveSyncStatus: local & notion both unchanged -> clean', () => {
  const s = _internal.deriveSyncStatus({
    localRow: {
      updated_at: '2026-04-10T09:00:00Z',
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    },
    notionLastEditedTime: '2026-04-10T10:00:00Z',
  });
  assert.equal(s, 'clean');
});

test('deriveSyncStatus: local edited, notion unchanged -> local_ahead', () => {
  const s = _internal.deriveSyncStatus({
    localRow: {
      updated_at: '2026-04-17T09:00:00Z',
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    },
    notionLastEditedTime: '2026-04-10T10:00:00Z',
  });
  assert.equal(s, 'local_ahead');
});

test('deriveSyncStatus: notion edited, local unchanged -> notion_ahead', () => {
  const s = _internal.deriveSyncStatus({
    localRow: {
      updated_at: '2026-04-10T09:00:00Z',
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    },
    notionLastEditedTime: '2026-04-17T11:00:00Z',
  });
  assert.equal(s, 'notion_ahead');
});

test('deriveSyncStatus: both edited -> conflict', () => {
  const s = _internal.deriveSyncStatus({
    localRow: {
      updated_at: '2026-04-17T09:00:00Z',
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    },
    notionLastEditedTime: '2026-04-17T10:00:00Z',
  });
  assert.equal(s, 'conflict');
});

// ─── projectNotionPageToTask ─────────────────────────────────────────────

test('projectNotionPageToTask extracts title, dates, phase, risk', () => {
  const page = {
    id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
    last_edited_time: '2026-04-17T10:00:00.000Z',
    properties: {
      'Task Name': { type: 'title', title: [{ plain_text: 'Edge JWT' }] },
      'Start Date': { type: 'date', date: { start: '2026-04-14' } },
      'End Date': { type: 'date', date: { start: '2026-04-15' } },
      'Completion %': { type: 'number', number: 0.5 },
      'Phase': { type: 'select', select: { name: 'Phase 0.5 - Security' } },
      'Risk Level': { type: 'select', select: { name: 'Critical' } },
      'Critical Path': { type: 'checkbox', checkbox: true },
      'Is Milestone': { type: 'checkbox', checkbox: false },
      'Slack days': { type: 'number', number: 2 },
      'Owner': { type: 'select', select: { name: 'Peter' } },
      'Stream': { type: 'select', select: { name: 'Stream B (Peter)' } },
      'Status': { type: 'status', status: { name: 'In progress' } },
      'Notes': { type: 'rich_text', rich_text: [{ plain_text: 'hello' }] },
    },
  };
  const mapping = {
    name_field: 'Task Name',
    start_field: 'Start Date',
    end_field: 'End Date',
    progress_field: 'Completion %',
    color_field: 'Phase',
    risk_field: 'Risk Level',
    critical_path_field: 'Critical Path',
    milestone_field: 'Is Milestone',
    slack_field: 'Slack days',
  };
  const t = _internal.projectNotionPageToTask(page, mapping);
  assert.equal(t.name, 'Edge JWT');
  assert.equal(t.start_date, '2026-04-14');
  assert.equal(t.end_date, '2026-04-15');
  assert.equal(t.progress, 50); // 0.5 fractional -> 50
  assert.equal(t.phase_name, 'Phase 0.5 - Security');
  assert.equal(t.risk_level, 'Critical');
  assert.equal(t.critical_path, true);
  assert.equal(t.is_milestone, false);
  assert.equal(t.slack_days, 2);
  assert.equal(t.owner_label, 'Peter');
  assert.equal(t.stream_name, 'Stream B (Peter)');
  assert.equal(t.status, 'In progress');
  assert.equal(t.notes, 'hello');
  assert.equal(t.notion_last_edited_time, '2026-04-17T10:00:00.000Z');
  assert.ok(t.notion_url.startsWith('https://www.notion.so/'));
});

// ─── upsertNotionPages routing ───────────────────────────────────────────

test('upsertNotionPages: new page -> INSERT, clean local -> PATCH full row, local_ahead -> PATCH status only', async () => {
  const mapping = {
    name_field: 'Task Name',
    start_field: 'Start Date',
    end_field: 'End Date',
  };
  const notionPages = [
    // brand new — not in local map
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      last_edited_time: '2026-04-17T10:00:00Z',
      properties: {
        'Task Name': { type: 'title', title: [{ plain_text: 'New Page' }] },
        'Start Date': { type: 'date', date: { start: '2026-04-14' } },
        'End Date': { type: 'date', date: { start: '2026-04-15' } },
      },
    },
    // exists locally, clean -> full refresh
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      last_edited_time: '2026-04-10T10:00:00Z',
      properties: {
        'Task Name': { type: 'title', title: [{ plain_text: 'Clean Refresh' }] },
        'Start Date': { type: 'date', date: { start: '2026-04-16' } },
        'End Date': { type: 'date', date: { start: '2026-04-17' } },
      },
    },
    // exists locally, local_ahead -> status only
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      last_edited_time: '2026-04-10T10:00:00Z',
      properties: {
        'Task Name': { type: 'title', title: [{ plain_text: 'Should NOT Overwrite' }] },
        'Start Date': { type: 'date', date: { start: '2026-04-20' } },
        'End Date': { type: 'date', date: { start: '2026-04-21' } },
      },
    },
  ];
  const localTasksByNotionId = new Map([
    ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      notion_page_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      updated_at: '2026-04-10T09:00:00Z',          // unchanged
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    }],
    ['cccccccc-cccc-cccc-cccc-cccccccccccc', {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      notion_page_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      updated_at: '2026-04-17T09:00:00Z',          // edited locally
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    }],
  ]);

  const writes = [];
  const sbClient = {
    insert: async (relPath, row) => { writes.push({ op: 'INSERT', relPath, row }); return { ok: true, status: 201 }; },
    patch:  async (relPath, row) => { writes.push({ op: 'PATCH',  relPath, row }); return { ok: true, status: 204 }; },
  };

  const results = await _internal.upsertNotionPages({
    projectId: 'proj-1',
    notionPages,
    mapping,
    phaseByName: new Map(),
    streamByName: new Map(),
    localTasksByNotionId,
    sbClient,
    nowIso: '2026-04-18T12:00:00Z',
    actorId: 'user-1',
  });

  assert.equal(results.length, 3);
  assert.equal(results[0].action, 'inserted');
  assert.equal(results[0].status, 'clean');
  assert.equal(results[1].action, 'refreshed');
  assert.equal(results[1].status, 'clean');
  assert.equal(results[2].action, 'status_only');
  assert.equal(results[2].status, 'local_ahead');

  assert.equal(writes.length, 3);
  assert.equal(writes[0].op, 'INSERT');
  assert.equal(writes[0].row.name, 'New Page');
  assert.equal(writes[0].row.notion_sync_status, 'clean');

  // refresh MUST include Notion-sourced fields (name changes, etc.)
  assert.equal(writes[1].op, 'PATCH');
  assert.equal(writes[1].row.name, 'Clean Refresh');
  assert.equal(writes[1].row.start_date, '2026-04-16');
  assert.equal(writes[1].row.notion_sync_status, 'clean');

  // status-only PATCH MUST NOT contain name / start_date / end_date.
  assert.equal(writes[2].op, 'PATCH');
  assert.equal(writes[2].row.name, undefined,
    'local_ahead row must not be overwritten');
  assert.equal(writes[2].row.start_date, undefined);
  assert.equal(writes[2].row.notion_sync_status, 'local_ahead');
  assert.equal(writes[2].row.last_pulled_from_notion_at, '2026-04-18T12:00:00Z');
});

test('upsertNotionPages: notion_ahead keeps status, does NOT overwrite fields', async () => {
  const mapping = {
    name_field: 'Task Name',
    start_field: 'Start Date',
    end_field: 'End Date',
  };
  const notionPages = [{
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    last_edited_time: '2026-04-17T10:00:00Z', // newer than pulled_at
    properties: {
      'Task Name': { type: 'title', title: [{ plain_text: 'Notion Newer' }] },
      'Start Date': { type: 'date', date: { start: '2026-04-25' } },
      'End Date': { type: 'date', date: { start: '2026-04-26' } },
    },
  }];
  const localTasksByNotionId = new Map([
    ['dddddddd-dddd-dddd-dddd-dddddddddddd', {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      notion_page_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      updated_at: '2026-04-10T09:00:00Z',
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    }],
  ]);
  const writes = [];
  const sbClient = {
    insert: async () => { throw new Error('should not INSERT'); },
    patch:  async (relPath, row) => { writes.push({ op: 'PATCH', relPath, row }); return { ok: true, status: 204 }; },
  };
  const results = await _internal.upsertNotionPages({
    projectId: 'proj-1', notionPages, mapping,
    phaseByName: new Map(), streamByName: new Map(),
    localTasksByNotionId, sbClient,
    nowIso: '2026-04-18T12:00:00Z', actorId: 'user-1',
  });
  assert.equal(results[0].status, 'notion_ahead');
  assert.equal(writes[0].row.name, undefined);
  assert.equal(writes[0].row.notion_sync_status, 'notion_ahead');
});

test('upsertNotionPages: conflict keeps status, does NOT overwrite fields', async () => {
  const mapping = {
    name_field: 'Task Name',
    start_field: 'Start Date',
    end_field: 'End Date',
  };
  const notionPages = [{
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    last_edited_time: '2026-04-17T10:00:00Z',
    properties: {
      'Task Name': { type: 'title', title: [{ plain_text: 'Both Edited' }] },
      'Start Date': { type: 'date', date: { start: '2026-04-30' } },
      'End Date': { type: 'date', date: { start: '2026-05-01' } },
    },
  }];
  const localTasksByNotionId = new Map([
    ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      notion_page_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      updated_at: '2026-04-17T09:00:00Z',          // edited locally
      last_pulled_from_notion_at: '2026-04-15T12:00:00Z',
    }],
  ]);
  const writes = [];
  const sbClient = {
    insert: async () => { throw new Error('should not INSERT'); },
    patch:  async (relPath, row) => { writes.push({ op: 'PATCH', relPath, row }); return { ok: true, status: 204 }; },
  };
  const results = await _internal.upsertNotionPages({
    projectId: 'proj-1', notionPages, mapping,
    phaseByName: new Map(), streamByName: new Map(),
    localTasksByNotionId, sbClient,
    nowIso: '2026-04-18T12:00:00Z', actorId: 'user-1',
  });
  assert.equal(results[0].status, 'conflict');
  assert.equal(writes[0].row.start_date, undefined);
  assert.equal(writes[0].row.notion_sync_status, 'conflict');
});

// ─── Handler end-to-end ──────────────────────────────────────────────────

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
        const { status, body } = await handlerFn(String(url), opts);
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
  return { calls, restore: () => { global.fetch = origFetch; } };
}

test('handler pulls from Notion, upserts, and writes one sync_events row', async () => {
  const seenSyncEvent = [];
  const routes = [
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: 'user-1' } })],
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: 'proj-1', slug: 'societist' }] })],
    [/\/rest\/v1\/notion_schema_mappings\?/, () => ({
      status: 200,
      body: [{
        notion_db_id: 'db-1',
        mapping: {
          name_field: 'Task Name',
          start_field: 'Start Date',
          end_field: 'End Date',
        },
      }],
    })],
    [/\/rest\/v1\/phases\?/, () => ({ status: 200, body: [] })],
    [/\/rest\/v1\/streams\?/, () => ({ status: 200, body: [] })],
    [/\/rest\/v1\/tasks\?select/, () => ({ status: 200, body: [] })], // no local tasks
    [/api\.notion\.com\/v1\/databases\/.*\/query$/, () => ({
      status: 200,
      body: {
        results: [{
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          last_edited_time: '2026-04-18T10:00:00Z',
          properties: {
            'Task Name': { type: 'title', title: [{ plain_text: 'Hello' }] },
            'Start Date': { type: 'date', date: { start: '2026-04-14' } },
            'End Date': { type: 'date', date: { start: '2026-04-15' } },
          },
        }],
        has_more: false,
        next_cursor: null,
      },
    })],
    // INSERT into tasks
    [/\/rest\/v1\/tasks$/, () => ({ status: 201, body: '' })],
    // sync_events insert
    [/\/rest\/v1\/sync_events$/, (_u, opts) => {
      seenSyncEvent.push(JSON.parse(opts.body));
      return { status: 201, body: [{ id: 'evt-9' }] };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist' }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.rowsRead, 1);
    assert.equal(body.rowsWritten, 1);
    assert.equal(body.rowsFailed, 0);
    assert.equal(body.status, 'success');
    assert.equal(body.syncEventId, 'evt-9');

    assert.equal(seenSyncEvent.length, 1);
    assert.equal(seenSyncEvent[0].direction, 'pull_from_notion');
    assert.equal(seenSyncEvent[0].actor_id, 'user-1');
    assert.equal(seenSyncEvent[0].rows_read, 1);
    assert.equal(seenSyncEvent[0].rows_written, 1);
  } finally { restore(); }
});

test('handler returns 502 and logs failed sync_event when Notion errors', async () => {
  const events = [];
  const routes = [
    [/\/auth\/v1\/user$/, () => ({ status: 200, body: { id: 'user-1' } })],
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [{ id: 'proj-1', slug: 'societist' }] })],
    [/\/rest\/v1\/notion_schema_mappings\?/, () => ({
      status: 200,
      body: [{ notion_db_id: 'db-1', mapping: { name_field: 'Task Name', start_field: 's', end_field: 'e' } }],
    })],
    [/\/rest\/v1\/phases\?/, () => ({ status: 200, body: [] })],
    [/\/rest\/v1\/streams\?/, () => ({ status: 200, body: [] })],
    [/\/rest\/v1\/tasks\?select/, () => ({ status: 200, body: [] })],
    [/api\.notion\.com\/v1\/databases\/.*\/query$/, () => ({ status: 500, body: 'boom' })],
    [/\/rest\/v1\/sync_events$/, (_u, opts) => {
      events.push(JSON.parse(opts.body));
      return { status: 201, body: '' };
    }],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ slug: 'societist' }),
    });
    assert.equal(res.statusCode, 502);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].direction, 'pull_from_notion');
  } finally { restore(); }
});

test('handler rejects missing Authorization', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ slug: 'societist' }),
  });
  assert.equal(res.statusCode, 401);
});
