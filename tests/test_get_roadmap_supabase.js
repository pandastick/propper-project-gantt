/**
 * tests/test_get_roadmap_supabase.js
 *
 * Unit tests for netlify/functions/get-roadmap.js (Supabase-as-SoT).
 * Stubs global fetch — no live Supabase calls. Run:
 *   node tests/test_get_roadmap_supabase.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Env vars must be set before require() so the handler sees them.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';

const mod = require(path.join(__dirname, '..', 'netlify', 'functions', 'get-roadmap.js'));
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

function makeEvent({ method = 'GET', slug = 'societist', auth = 'Bearer jwt-abc' } = {}) {
  return {
    httpMethod: method,
    headers: auth ? { Authorization: auth } : {},
    queryStringParameters: { slug },
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

test('composeCustomClass matches sync.py formula', () => {
  const { composeCustomClass } = _internal;
  assert.equal(
    composeCustomClass('Phase 0.5 - Security', true, 'None', false),
    'phase-05-security critical-path',
  );
  assert.equal(
    composeCustomClass('Phase 2A - User Features', true, 'Critical', false),
    'phase-2a-user-features critical-path risk-critical',
  );
  assert.equal(
    composeCustomClass('Launch Track', false, 'High', true),
    'phase-launch-track risk-high milestone',
  );
  assert.equal(composeCustomClass('', false, 'None', false), '');
});

test('assembleResponse builds the legacy roadmap.json shape', () => {
  const { assembleResponse } = _internal;
  const project = { id: 'proj-1', slug: 'societist' };
  const mappingRow = {
    notion_db_id: '33d9e1fc-caab-8106-9a85-fe17a5f76038',
    mapping: { name_field: 'Task Name', start_field: 'Start Date', end_field: 'End Date' },
    phase_palette: { 'Phase 0.5 - Security': '#E03E3E' },
  };
  const phases = [
    { id: 'ph-1', name: 'Phase 0.5 - Security', color: '#E03E3E', sort_order: 0 },
  ];
  const streams = [
    { id: 'st-1', name: 'Stream B (Peter)', sort_order: 0 },
  ];
  const tasks = [
    {
      id: 't1', project_id: 'proj-1',
      name: 'A', start_date: '2026-04-14', end_date: '2026-04-15',
      progress: 50,
      phase_id: 'ph-1', stream_id: 'st-1',
      owner_label: 'Peter', status: 'In progress',
      risk_level: 'Critical', is_milestone: false, critical_path: true,
      slack_days: 2, duration_days: 1, duration_text: '1 day',
      reference: null, notes: 'hello',
      notion_url: 'https://www.notion.so/t1',
    },
    {
      id: 't2', project_id: 'proj-1',
      name: 'B', start_date: '2026-04-16', end_date: '2026-04-17',
      progress: 0, phase_id: 'ph-1', stream_id: 'st-1',
      owner_label: 'Peter', status: 'Not started',
      risk_level: 'None', is_milestone: true, critical_path: false,
      slack_days: 0, duration_days: 1, duration_text: '1 day',
      reference: null, notes: null,
      notion_url: 'https://www.notion.so/t2',
    },
  ];
  const deps = [{ blocked_task_id: 't2', blocker_task_id: 't1' }];
  const out = assembleResponse(project, mappingRow, phases, streams, tasks, deps, '2026-04-17T10:00:00Z');

  assert.equal(out.source.table_name, 'ROADMAP');
  assert.equal(out.source.row_count, 2);
  assert.equal(out.source.synced_at, '2026-04-17T10:00:00Z');
  assert.ok(out.source.notion_url.startsWith('https://www.notion.so/'));
  assert.deepEqual(out.schema_mapping, mappingRow.mapping);
  assert.deepEqual(out.phase_palette, mappingRow.phase_palette);

  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[0].id, 't1');
  assert.equal(out.tasks[0].start, '2026-04-14');
  assert.equal(out.tasks[0].end, '2026-04-15');
  assert.equal(out.tasks[0].dependencies, '');
  assert.equal(out.tasks[0].custom_class, 'phase-05-security critical-path risk-critical');
  assert.equal(out.tasks[0].meta.phase, 'Phase 0.5 - Security');
  assert.equal(out.tasks[0].meta.stream, 'Stream B (Peter)');
  assert.equal(out.tasks[0].meta.owner, 'Peter');
  assert.equal(out.tasks[0].meta.critical_path, true);
  assert.equal(out.tasks[0].meta.risk_level, 'Critical');
  assert.equal(out.tasks[0].meta.slack_days, 2);

  assert.equal(out.tasks[1].dependencies, 't1');
  assert.equal(out.tasks[1].custom_class, 'phase-05-security milestone');
});

test('extractBearer handles present/absent/malformed tokens', () => {
  const { extractBearer } = _internal;
  assert.equal(extractBearer({ Authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(extractBearer({ authorization: 'bearer  xyz' }), 'xyz');
  assert.equal(extractBearer({}), null);
  assert.equal(extractBearer({ Authorization: 'Basic abc' }), null);
});

// ─── Handler paths ───────────────────────────────────────────────────────

test('handler rejects non-GET', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} });
  assert.equal(res.statusCode, 405);
});

test('handler rejects missing auth', async () => {
  const res = await handler(makeEvent({ auth: null }));
  assert.equal(res.statusCode, 401);
});

test('handler rejects invalid slug', async () => {
  const res = await handler(makeEvent({ slug: 'Bad Slug!' }));
  assert.equal(res.statusCode, 400);
});

test('handler returns 403 when project row is hidden by RLS (empty array)', async () => {
  const { restore } = installFetchStub([
    [/\/rest\/v1\/projects\?/, () => ({ status: 200, body: [] })],
  ]);
  try {
    const res = await handler(makeEvent({ slug: 'unknown' }));
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});

test('handler returns assembled roadmap JSON on success', async () => {
  const routes = [
    [/\/rest\/v1\/projects\?/, () => ({
      status: 200,
      body: [{ id: 'proj-1', slug: 'societist', name: 'Societist' }],
    })],
    [/\/rest\/v1\/phases\?/, () => ({
      status: 200,
      body: [{ id: 'ph-1', name: 'Phase 0.5 - Security', color: '#E03E3E', sort_order: 0 }],
    })],
    [/\/rest\/v1\/streams\?/, () => ({
      status: 200,
      body: [{ id: 'st-1', name: 'Stream B (Peter)', sort_order: 0 }],
    })],
    [/\/rest\/v1\/tasks\?.*project_id=eq/, () => ({
      status: 200,
      body: [{
        id: 't1', project_id: 'proj-1', name: 'Edge JWT',
        start_date: '2026-04-14', end_date: '2026-04-14',
        progress: 0, phase_id: 'ph-1', stream_id: 'st-1',
        owner_label: 'Lourenço', status: 'Not started',
        risk_level: 'None', is_milestone: false, critical_path: true,
        slack_days: 0, duration_days: 0.5, duration_text: '4h',
        reference: null, notes: null,
        notion_page_id: '7159e1fc-caab-83b7-9ee3-818c84f19cf8',
        notion_url: 'https://www.notion.so/7159e1fccaab83b79ee3818c84f19cf8',
      }],
    })],
    [/\/rest\/v1\/notion_schema_mappings\?/, () => ({
      status: 200,
      body: [{
        notion_db_id: '33d9e1fc-caab-8106-9a85-fe17a5f76038',
        mapping: {
          name_field: 'Task Name',
          start_field: 'Start Date',
          end_field: 'End Date',
          dependencies_field: 'Blocked by',
        },
        phase_palette: { 'Phase 0.5 - Security': '#E03E3E' },
      }],
    })],
    [/\/rest\/v1\/sync_events\?/, () => ({
      status: 200,
      body: [{ finished_at: '2026-04-17T19:47:05.767055+00:00' }],
    })],
    [/\/rest\/v1\/task_dependencies\?/, () => ({ status: 200, body: [] })],
  ];
  const { restore } = installFetchStub(routes);
  try {
    const res = await handler(makeEvent({ slug: 'societist' }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source.row_count, 1);
    assert.equal(body.source.synced_at, '2026-04-17T19:47:05.767055+00:00');
    assert.ok(body.source.notion_url.startsWith('https://www.notion.so/'));
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].custom_class, 'phase-05-security critical-path');
    assert.equal(body.tasks[0].meta.stream, 'Stream B (Peter)');
    assert.equal(body.tasks[0].dependencies, '');
  } finally { restore(); }
});

