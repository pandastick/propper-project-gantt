/**
 * get-roadmap.js — Supabase-as-SoT read path.
 *
 * Replaces the old GitHub-API-backed reader. The caller (browser via
 * supabase-gate.js) sends a Supabase user JWT in `Authorization: Bearer`.
 * This function forwards that JWT to Supabase PostgREST so RLS enforces
 * project membership — if the user isn't a project member, the SELECTs
 * return no rows and we return 403.
 *
 * Response shape matches the legacy data/roadmap.json contract so the
 * existing viewer/simulator/change-log code in js/* keeps working
 * unchanged.
 */

'use strict';

const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function extractBearer(headers) {
  const raw = getHeader(headers, 'authorization');
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

// ─── Supabase PostgREST helpers ──────────────────────────────────────────
//
// We use plain fetch rather than @supabase/supabase-js to avoid adding a
// runtime dep. The user's JWT + anon key is passed on every request so
// RLS sees `auth.uid()` as the authenticated user.
//
// `ppgantt.*` tables are not in the default `public` exposed schema, so
// we set `Accept-Profile` on reads. Writes happen in push-to-notion.js
// via `Content-Profile`.

function sbHeaders(accessToken, anonKey, profile) {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (profile) headers['Accept-Profile'] = profile;
  return headers;
}

async function sbSelect(supabaseUrl, accessToken, anonKey, profile, path) {
  const url = `${supabaseUrl}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: sbHeaders(accessToken, anonKey, profile),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: null, raw: text };
  }
  try {
    return { ok: true, status: res.status, body: JSON.parse(text || '[]'), raw: text };
  } catch (_) {
    return { ok: false, status: 500, body: null, raw: text };
  }
}

// ─── custom_class + response assembly ────────────────────────────────────
//
// Mirrors sync/sync.py:_compose_custom_class so the viewer's CSS selectors
// keep matching.

function slugify(text) {
  if (!text) return '';
  let s = String(text).toLowerCase().trim();
  s = s.replace(/[^\w\s-]/g, '');
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function phaseSlug(phaseName) {
  let slug = slugify(phaseName);
  if (slug.startsWith('phase-')) slug = slug.slice('phase-'.length);
  return slug;
}

function composeCustomClass(phase, critical, risk, milestone) {
  const parts = [];
  if (phase) parts.push(`phase-${phaseSlug(phase)}`);
  if (critical) parts.push('critical-path');
  if (risk && String(risk).toLowerCase() !== 'none') {
    parts.push(`risk-${String(risk).toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (milestone) parts.push('milestone');
  return parts.join(' ');
}

function assembleResponse(project, mappingRow, phases, streams, tasks, deps, latestSync) {
  const phaseById = new Map();
  for (const p of phases || []) phaseById.set(p.id, p);
  const streamById = new Map();
  for (const s of streams || []) streamById.set(s.id, s);

  // blocked_task_id -> [blocker_task_id, ...]
  const depsByBlocked = new Map();
  for (const edge of deps || []) {
    const arr = depsByBlocked.get(edge.blocked_task_id) || [];
    arr.push(edge.blocker_task_id);
    depsByBlocked.set(edge.blocked_task_id, arr);
  }

  const taskRows = (tasks || []).map((t) => {
    const phase = phaseById.get(t.phase_id);
    const stream = streamById.get(t.stream_id);
    const phaseName = phase ? phase.name : '';
    const streamName = stream ? stream.name : null;
    const dependencies = (depsByBlocked.get(t.id) || []).join(',');
    const custom_class = composeCustomClass(
      phaseName,
      !!t.critical_path,
      t.risk_level || 'None',
      !!t.is_milestone,
    );
    return {
      id: t.id,
      name: t.name,
      start: t.start_date || '',
      end: t.end_date || '',
      progress: t.progress === null || t.progress === undefined ? 0 : Number(t.progress),
      dependencies,
      custom_class,
      meta: {
        phase: phaseName,
        stream: streamName,
        owner: t.owner_label || null,
        status: t.status || null,
        risk_level: t.risk_level || 'None',
        critical_path: !!t.critical_path,
        is_milestone: !!t.is_milestone,
        slack_days: t.slack_days === null || t.slack_days === undefined ? null : Number(t.slack_days),
        duration_days: t.duration_days === null || t.duration_days === undefined ? null : Number(t.duration_days),
        duration_text: t.duration_text || null,
        reference: t.reference || null,
        notes: t.notes || null,
        notion_url: t.notion_url || '',
        notion_page_id: t.notion_page_id || null,
        notion_sync_status: t.notion_sync_status || 'clean',
      },
    };
  });

  const mapping = mappingRow ? mappingRow.mapping || {} : {};
  const phasePalette = mappingRow ? mappingRow.phase_palette || {} : {};
  const notionDbId = mappingRow ? mappingRow.notion_db_id || '' : '';
  // Reconstruct a canonical Notion URL from the DB id. This keeps the
  // legacy `source.notion_url` shape populated for any viewer code that
  // reads it.
  const cleanDbId = (notionDbId || '').replace(/-/g, '');
  const notionUrl = cleanDbId ? `https://www.notion.so/${cleanDbId}` : '';

  return {
    source: {
      notion_url: notionUrl,
      data_source_id: notionDbId ? `collection://${notionDbId}` : '',
      table_name: 'ROADMAP',
      synced_at: latestSync || null,
      row_count: taskRows.length,
    },
    schema_mapping: mapping,
    phase_palette: phasePalette,
    tasks: taskRows,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !anonKey) {
      console.error('get-roadmap error: missing SUPABASE_URL or SUPABASE_ANON_KEY');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal error' }),
      };
    }

    const accessToken = extractBearer(event.headers);
    if (!accessToken) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const qs = event.queryStringParameters || {};
    const slug = qs.slug;
    if (!slug || typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid slug' }),
      };
    }

    // 1. Project lookup by slug. RLS on public.projects only returns rows
    //    where the caller is a project_member — if the slug exists but
    //    the user isn't a member, this returns [].
    const projRes = await sbSelect(
      supabaseUrl,
      accessToken,
      anonKey,
      null,
      `projects?select=id,slug,name&slug=eq.${encodeURIComponent(slug)}`,
    );
    if (!projRes.ok) {
      console.error('get-roadmap: projects fetch status', projRes.status);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }
    const projects = projRes.body || [];
    if (projects.length === 0) {
      // Either the slug doesn't exist OR RLS hid it. Surface as 403 to
      // avoid leaking slug existence; the client treats both as "you
      // can't see this roadmap".
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
    const project = projects[0];
    const projectId = project.id;

    // 2. Fetch phases, streams, tasks, dependencies, and mapping in
    //    parallel. Each call is RLS-scoped to the same project_id so
    //    there's no risk of returning rows from other projects.
    const [phasesRes, streamsRes, tasksRes, mappingRes, syncEventsRes] = await Promise.all([
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `phases?select=id,name,color,sort_order&project_id=eq.${projectId}&order=sort_order.asc`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `streams?select=id,name,sort_order&project_id=eq.${projectId}&order=sort_order.asc`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `tasks?select=*&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `notion_schema_mappings?select=notion_db_id,mapping,phase_palette&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `sync_events?select=finished_at&project_id=eq.${projectId}&status=eq.success&order=finished_at.desc&limit=1`,
      ),
    ]);

    for (const r of [phasesRes, streamsRes, tasksRes, mappingRes, syncEventsRes]) {
      if (!r.ok) {
        console.error('get-roadmap: ppgantt fetch status', r.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
    }

    const tasks = tasksRes.body || [];

    // 3. Fetch task_dependencies for this project. The table has no
    //    project_id column, so we filter by blocked_task_id in the set
    //    of this project's task ids. Skip if the project has no tasks.
    let deps = [];
    if (tasks.length > 0) {
      const taskIds = tasks.map((t) => t.id);
      // PostgREST `in.()` list — URL-encoded.
      const idList = taskIds.map((id) => `"${id}"`).join(',');
      const depsRes = await sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `task_dependencies?select=blocked_task_id,blocker_task_id&blocked_task_id=in.(${encodeURIComponent(idList)})`,
      );
      if (!depsRes.ok) {
        console.error('get-roadmap: task_dependencies fetch status', depsRes.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
      deps = depsRes.body || [];
    }

    const mappingRow = (mappingRes.body && mappingRes.body[0]) || null;
    const latestSync =
      syncEventsRes.body && syncEventsRes.body[0]
        ? syncEventsRes.body[0].finished_at
        : null;

    const payload = assembleResponse(
      project,
      mappingRow,
      phasesRes.body,
      streamsRes.body,
      tasks,
      deps,
      latestSync,
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error(
      'get-roadmap error:',
      err && err.name ? err.name : 'unknown',
      err && err.message ? err.message : '',
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

// Exported for unit tests. Not part of the Netlify runtime contract.
exports._internal = {
  assembleResponse,
  composeCustomClass,
  phaseSlug,
  slugify,
  extractBearer,
};
