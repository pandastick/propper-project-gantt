/**
 * pull-from-notion.js — Pull path for the Supabase-as-SoT model.
 *
 * Reads a project's Notion database via NOTION_API_KEY and upserts each
 * page into ppgantt.tasks. Status per row is derived from the 4-way
 * matrix in the PPGantt Supabase proposal §3.2:
 *
 *   local_unchanged  = tasks.updated_at <= last_pulled_from_notion_at
 *   notion_unchanged = notion.last_edited_time <= last_pulled_from_notion_at
 *
 *   clean        =  local_unchanged AND  notion_unchanged
 *   local_ahead  = !local_unchanged AND  notion_unchanged
 *   notion_ahead =  local_unchanged AND !notion_unchanged
 *   conflict     = !local_unchanged AND !notion_unchanged
 *
 * Field-overwrite rules (intentional, see "judgment calls" note below):
 *   - Row never seen locally    → INSERT with status 'clean', fill from Notion.
 *   - Resulting status 'clean'  → UPDATE Notion-sourced fields (name, dates,
 *                                 progress, phase_id, stream_id, etc.).
 *                                 last_pulled_from_notion_at := now(). Local
 *                                 has no edits to lose; safe to overwrite.
 *   - 'local_ahead'             → do NOT overwrite row fields (user just
 *                                 edited locally; their edits would be lost).
 *                                 Only update last_pulled_from_notion_at and
 *                                 notion_sync_status (the timestamp still
 *                                 advances so the next pull sees Notion as
 *                                 stale relative to our baseline).
 *   - 'notion_ahead'            → do NOT overwrite row fields. Let the
 *                                 conflict/choice UI present the diff on
 *                                 the next viewer render. Only update the
 *                                 status + pulled-at timestamp.
 *   - 'conflict'                → same as notion_ahead: mark-and-defer.
 *
 * One ppgantt.sync_events row is written per run.
 *
 * v1 scope: this function does NOT resolve phase/stream lookups by name
 * for pre-existing local tasks that get new values from Notion — it only
 * writes what it has direct columns for (start/end/name/progress/etc).
 * Phase + stream name changes land in meta on the next full pull once the
 * mapping is fleshed out in v2. See the "judgment calls" section in the
 * handoff report.
 */

'use strict';

const NOTION_API_VERSION = '2022-06-28';
const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return match[1].trim() || null;
}

// ─── Supabase REST helpers ───────────────────────────────────────────────

function sbHeaders(accessToken, anonKey, profile, extra) {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (profile) {
    headers['Accept-Profile'] = profile;
    headers['Content-Profile'] = profile;
  }
  if (extra) Object.assign(headers, extra);
  return headers;
}

async function sbSelect(supabaseUrl, accessToken, anonKey, profile, path) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'GET',
    headers: sbHeaders(accessToken, anonKey, profile),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: null, raw: text };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text || '[]'), raw: text };
  } catch (_) {
    return { ok: false, status: 500, body: null, raw: text };
  }
}

async function sbInsert(supabaseUrl, accessToken, anonKey, profile, path, body, preferReturn) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'POST',
    headers: sbHeaders(accessToken, anonKey, profile, {
      Prefer: preferReturn ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: null, raw: text };
  if (!preferReturn) return { ok: true, status: res.status, body: null, raw: text };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text || '[]'), raw: text };
  } catch (_) {
    return { ok: false, status: 500, body: null, raw: text };
  }
}

async function sbPatch(supabaseUrl, accessToken, anonKey, profile, path, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(accessToken, anonKey, profile, { Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, raw: text };
}

async function getCurrentUserId(supabaseUrl, accessToken, anonKey) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  try {
    const body = await res.json();
    return body && body.id ? body.id : null;
  } catch (_) {
    return null;
  }
}

// ─── Notion REST helpers ─────────────────────────────────────────────────

async function notionQueryDatabase(dbId, notionToken, startCursor) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(startCursor ? { start_cursor: startCursor } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: null, raw: text };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text || '{}') };
  } catch (_) {
    return { ok: false, status: 500, body: null, raw: text };
  }
}

async function fetchAllNotionPages(dbId, notionToken) {
  const pages = [];
  let cursor = null;
  let safety = 20; // caps at 20 * 100 = 2000 pages
  while (safety-- > 0) {
    const res = await notionQueryDatabase(dbId, notionToken, cursor);
    if (!res.ok) return { ok: false, status: res.status, pages: null };
    const body = res.body || {};
    for (const p of body.results || []) pages.push(p);
    if (!body.has_more) break;
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return { ok: true, status: 200, pages };
}

// ─── Notion property extraction ──────────────────────────────────────────

function extractTitle(prop) {
  if (!prop || prop.type !== 'title' || !Array.isArray(prop.title)) return '';
  return prop.title.map((t) => (t && t.plain_text) || '').join('');
}

function extractRichText(prop) {
  if (!prop) return null;
  if (prop.type === 'rich_text' && Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((t) => (t && t.plain_text) || '').join('') || null;
  }
  return null;
}

function extractDateStart(prop) {
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  const s = prop.date.start;
  if (!s) return null;
  return String(s).slice(0, 10);
}

function extractNumber(prop) {
  if (!prop || prop.type !== 'number') return null;
  return prop.number === null || prop.number === undefined ? null : Number(prop.number);
}

function extractSelectName(prop) {
  if (!prop) return null;
  if (prop.type === 'select' && prop.select) return prop.select.name || null;
  if (prop.type === 'status' && prop.status) return prop.status.name || null;
  return null;
}

function extractCheckbox(prop) {
  if (!prop || prop.type !== 'checkbox') return false;
  return !!prop.checkbox;
}

/**
 * Build a partial ppgantt.tasks row from a Notion page + mapping. Only
 * the Notion-sourced fields are populated here; project_id/phase_id/
 * stream_id are resolved by the caller.
 */
function projectNotionPageToTask(page, mapping) {
  const props = page.properties || {};
  const name = extractTitle(props[mapping.name_field]) || '(Untitled)';
  const startDate = extractDateStart(props[mapping.start_field]);
  const endDateRaw = extractDateStart(props[mapping.end_field]);
  const endDate = endDateRaw || startDate;

  let progress = 0;
  if (mapping.progress_field) {
    const n = extractNumber(props[mapping.progress_field]);
    if (n !== null) {
      // Notion stores completion % either as 0..1 (percent type) or 0..100
      // (plain number). We can't tell apart reliably from the JSON alone;
      // treat values <= 1 as fractions.
      progress = n <= 1 ? Math.round(n * 100) : Math.round(n);
      progress = Math.max(0, Math.min(100, progress));
    }
  }

  const phaseName = mapping.color_field ? extractSelectName(props[mapping.color_field]) : null;
  const riskLevel = mapping.risk_field ? extractSelectName(props[mapping.risk_field]) : null;
  const isMilestone = mapping.milestone_field ? extractCheckbox(props[mapping.milestone_field]) : false;
  const criticalPath = mapping.critical_path_field ? extractCheckbox(props[mapping.critical_path_field]) : false;

  let slackDays = null;
  if (mapping.slack_field) {
    const n = extractNumber(props[mapping.slack_field]);
    if (n !== null) slackDays = n;
  }

  // Scan for status/owner/stream/duration/notes/reference by name since
  // the mapping doesn't always enumerate them. Matches sync.py's
  // tolerant scanning.
  let status = null;
  let owner = null;
  let stream = null;
  let durationDays = null;
  let durationText = null;
  let reference = null;
  let notes = null;
  for (const [propName, propData] of Object.entries(props)) {
    const lower = propName.toLowerCase();
    const ptype = propData && propData.type;
    if (!status && ptype === 'status') status = extractSelectName(propData);
    if (!owner && lower === 'owner' && ptype === 'select') owner = extractSelectName(propData);
    if (!stream && lower === 'stream' && ptype === 'select') stream = extractSelectName(propData);
    if (lower.includes('duration') && ptype === 'number' && durationDays === null) {
      durationDays = extractNumber(propData);
    } else if (lower.includes('duration') && ptype === 'rich_text' && !durationText) {
      durationText = extractRichText(propData);
    } else if ((lower === 'reference' || lower === 'ref') && ptype === 'rich_text' && !reference) {
      reference = extractRichText(propData);
    } else if (lower === 'notes' && ptype === 'rich_text' && !notes) {
      notes = extractRichText(propData);
    }
  }

  const pageId = page.id || '';
  const cleanId = pageId.replace(/-/g, '');
  const notionUrl = cleanId ? `https://www.notion.so/${cleanId}` : '';

  return {
    notion_page_id: pageId,
    name,
    start_date: startDate,
    end_date: endDate,
    progress,
    status,
    owner_label: owner,
    phase_name: phaseName,
    stream_name: stream,
    risk_level: riskLevel,
    is_milestone: isMilestone,
    critical_path: criticalPath,
    slack_days: slackDays,
    duration_days: durationDays,
    duration_text: durationText,
    reference,
    notes,
    notion_url: notionUrl,
    notion_last_edited_time: page.last_edited_time || null,
  };
}

// ─── Status derivation ───────────────────────────────────────────────────

/**
 * Pure helper — exported for tests. Returns one of 'clean', 'local_ahead',
 * 'notion_ahead', 'conflict', 'new'. All timestamps are ISO strings.
 */
function deriveSyncStatus({ localRow, notionLastEditedTime }) {
  if (!localRow) return 'new';

  // If a local row has no last_pulled timestamp yet (legacy seed without
  // one, or a row that's never been pulled), treat it the same as if we
  // just pulled — any Notion edit after "never" is newer.
  const pulledAt = localRow.last_pulled_from_notion_at;
  const localUpdated = localRow.updated_at;

  const pulledMs = pulledAt ? Date.parse(pulledAt) : 0;
  const localUpdatedMs = localUpdated ? Date.parse(localUpdated) : 0;
  const notionEditedMs = notionLastEditedTime ? Date.parse(notionLastEditedTime) : 0;

  const localUnchanged = localUpdatedMs <= pulledMs;
  const notionUnchanged = notionEditedMs <= pulledMs;

  if (localUnchanged && notionUnchanged) return 'clean';
  if (!localUnchanged && notionUnchanged) return 'local_ahead';
  if (localUnchanged && !notionUnchanged) return 'notion_ahead';
  return 'conflict';
}

// ─── Core pull loop (exported for tests) ─────────────────────────────────

/**
 * Upserts Notion pages into ppgantt.tasks using the provided Supabase
 * client. `sbClient` is injected for tests. Returns a per-row summary.
 */
async function upsertNotionPages({
  projectId,
  notionPages,
  mapping,
  phaseByName,
  streamByName,
  localTasksByNotionId,
  sbClient,
  nowIso,
  actorId,
}) {
  const results = [];
  for (const page of notionPages) {
    const projected = projectNotionPageToTask(page, mapping);
    const notionPageId = projected.notion_page_id;
    if (!notionPageId) continue;

    const local = localTasksByNotionId.get(notionPageId) || null;
    const status = deriveSyncStatus({
      localRow: local,
      notionLastEditedTime: projected.notion_last_edited_time,
    });

    const phaseId = projected.phase_name ? phaseByName.get(projected.phase_name) || null : null;
    const streamId = projected.stream_name ? streamByName.get(projected.stream_name) || null : null;

    if (status === 'new') {
      // INSERT — brand new row. Use the Notion page UUID as the PK so it
      // matches the seed convention.
      const row = {
        id: notionPageId,
        project_id: projectId,
        name: projected.name,
        start_date: projected.start_date,
        end_date: projected.end_date,
        progress: projected.progress,
        phase_id: phaseId,
        stream_id: streamId,
        owner_label: projected.owner_label,
        status: projected.status,
        risk_level: projected.risk_level,
        is_milestone: projected.is_milestone,
        critical_path: projected.critical_path,
        slack_days: projected.slack_days,
        duration_days: projected.duration_days,
        duration_text: projected.duration_text,
        reference: projected.reference,
        notes: projected.notes,
        notion_page_id: notionPageId,
        notion_url: projected.notion_url,
        last_pulled_from_notion_at: nowIso,
        notion_sync_status: 'clean',
        created_by: actorId,
        updated_by: actorId,
      };
      const ins = await sbClient.insert('tasks', row);
      results.push({
        notion_page_id: notionPageId,
        action: ins.ok ? 'inserted' : 'insert_failed',
        status: 'clean',
        error: ins.ok ? null : `HTTP ${ins.status}`,
      });
      continue;
    }

    if (status === 'clean') {
      // Safe to refresh Notion-sourced fields — local has no pending edits.
      const patch = {
        name: projected.name,
        start_date: projected.start_date,
        end_date: projected.end_date,
        progress: projected.progress,
        phase_id: phaseId,
        stream_id: streamId,
        owner_label: projected.owner_label,
        status: projected.status,
        risk_level: projected.risk_level,
        is_milestone: projected.is_milestone,
        critical_path: projected.critical_path,
        slack_days: projected.slack_days,
        duration_days: projected.duration_days,
        duration_text: projected.duration_text,
        reference: projected.reference,
        notes: projected.notes,
        notion_url: projected.notion_url,
        last_pulled_from_notion_at: nowIso,
        notion_sync_status: 'clean',
      };
      const upd = await sbClient.patch(
        `tasks?id=eq.${encodeURIComponent(local.id)}`,
        patch,
      );
      results.push({
        notion_page_id: notionPageId,
        action: upd.ok ? 'refreshed' : 'refresh_failed',
        status: 'clean',
        error: upd.ok ? null : `HTTP ${upd.status}`,
      });
      continue;
    }

    // local_ahead / notion_ahead / conflict: mark-and-defer.
    // Never overwrite user-editable fields; only stamp status + pulled-at
    // so the UI can flag the row. For local_ahead, we leave the status
    // matching reality (local newer than last baseline). For
    // notion_ahead / conflict, the viewer shows the conflict banner.
    const patch = {
      last_pulled_from_notion_at: nowIso,
      notion_sync_status: status,
    };
    const upd = await sbClient.patch(
      `tasks?id=eq.${encodeURIComponent(local.id)}`,
      patch,
    );
    results.push({
      notion_page_id: notionPageId,
      action: upd.ok ? 'status_only' : 'status_update_failed',
      status,
      error: upd.ok ? null : `HTTP ${upd.status}`,
    });
  }
  return results;
}

// ─── Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const notionToken = process.env.NOTION_API_KEY;

    if (!supabaseUrl || !anonKey || !notionToken) {
      console.error('pull-from-notion error: missing required env vars');
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }

    const accessToken = extractBearer(event.headers);
    if (!accessToken) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (_) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const slug = body.slug;
    const rawProjectId = body.project_id;

    let projectId = null;
    if (rawProjectId && typeof rawProjectId === 'string' && UUID_PATTERN.test(rawProjectId)) {
      projectId = rawProjectId;
    }
    if (!projectId) {
      if (!slug || typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid slug or project_id' }) };
      }
      const projRes = await sbSelect(
        supabaseUrl, accessToken, anonKey, null,
        `projects?select=id,slug&slug=eq.${encodeURIComponent(slug)}`,
      );
      if (!projRes.ok) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
      if (!projRes.body || projRes.body.length === 0) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
      }
      projectId = projRes.body[0].id;
    }

    const userId = await getCurrentUserId(supabaseUrl, accessToken, anonKey);
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const startedAt = new Date().toISOString();

    const [mappingRes, phasesRes, streamsRes, localTasksRes] = await Promise.all([
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `notion_schema_mappings?select=notion_db_id,mapping&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `phases?select=id,name&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `streams?select=id,name&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `tasks?select=id,notion_page_id,updated_at,last_pulled_from_notion_at&project_id=eq.${projectId}`,
      ),
    ]);

    for (const r of [mappingRes, phasesRes, streamsRes, localTasksRes]) {
      if (!r.ok) {
        console.error('pull-from-notion: supabase fetch status', r.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
    }

    if (!mappingRes.body || mappingRes.body.length === 0) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Project has no Notion schema mapping' }),
      };
    }

    const dbId = mappingRes.body[0].notion_db_id;
    const mapping = mappingRes.body[0].mapping || {};
    if (!dbId || !mapping.name_field) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Notion schema mapping incomplete' }),
      };
    }

    const phaseByName = new Map();
    for (const p of phasesRes.body || []) phaseByName.set(p.name, p.id);
    const streamByName = new Map();
    for (const s of streamsRes.body || []) streamByName.set(s.name, s.id);

    const localTasksByNotionId = new Map();
    for (const t of localTasksRes.body || []) {
      if (t.notion_page_id) localTasksByNotionId.set(t.notion_page_id, t);
    }

    // Notion fetch — paginated.
    const notionFetch = await fetchAllNotionPages(dbId, notionToken);
    if (!notionFetch.ok) {
      // Still write a failed sync_events row so history reflects the attempt.
      await sbInsert(
        supabaseUrl, accessToken, anonKey, 'ppgantt', 'sync_events',
        {
          project_id: projectId,
          actor_id: userId,
          direction: 'pull_from_notion',
          status: 'failed',
          rows_read: 0,
          rows_written: 0,
          rows_failed: 0,
          error_detail: { notion_status: notionFetch.status },
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        },
        false,
      );
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Notion fetch failed' }),
      };
    }

    const sbClient = {
      insert: (relPath, row) =>
        sbInsert(supabaseUrl, accessToken, anonKey, 'ppgantt', relPath, row, false),
      patch: (relPath, row) =>
        sbPatch(supabaseUrl, accessToken, anonKey, 'ppgantt', relPath, row),
    };

    const nowIso = new Date().toISOString();
    const results = await upsertNotionPages({
      projectId,
      notionPages: notionFetch.pages,
      mapping,
      phaseByName,
      streamByName,
      localTasksByNotionId,
      sbClient,
      nowIso,
      actorId: userId,
    });

    const rowsRead = notionFetch.pages.length;
    const rowsFailed = results.filter((r) => r.error !== null).length;
    const rowsWritten = results.filter(
      (r) => r.action === 'inserted' || r.action === 'refreshed' || r.action === 'status_only',
    ).length;
    const finishedAt = new Date().toISOString();
    const overallStatus =
      rowsFailed === 0
        ? 'success'
        : rowsWritten > 0
          ? 'partial'
          : 'failed';

    const syncEventIns = await sbInsert(
      supabaseUrl, accessToken, anonKey, 'ppgantt', 'sync_events',
      {
        project_id: projectId,
        actor_id: userId,
        direction: 'pull_from_notion',
        status: overallStatus,
        rows_read: rowsRead,
        rows_written: rowsWritten,
        rows_failed: rowsFailed,
        error_detail:
          rowsFailed > 0
            ? {
                failures: results
                  .filter((r) => r.error !== null)
                  .map((r) => ({
                    notion_page_id: r.notion_page_id,
                    action: r.action,
                    error: r.error,
                  })),
              }
            : null,
        started_at: startedAt,
        finished_at: finishedAt,
      },
      true,
    );

    const syncEventId =
      syncEventIns.ok && syncEventIns.body && syncEventIns.body[0]
        ? syncEventIns.body[0].id
        : null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        syncEventId,
        rowsRead,
        rowsWritten,
        rowsFailed,
        status: overallStatus,
        results,
      }),
    };
  } catch (err) {
    console.error(
      'pull-from-notion error:',
      err && err.name ? err.name : 'unknown',
      err && err.message ? err.message : '',
    );
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

// Exported for tests.
exports._internal = {
  deriveSyncStatus,
  projectNotionPageToTask,
  upsertNotionPages,
  extractBearer,
  extractTitle,
  extractDateStart,
};
