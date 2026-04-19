/**
 * push-to-notion.js — Supabase-as-SoT push path.
 *
 * The browser no longer sends a payload of proposed changes. Instead it
 * POSTs {slug} (or {project_id}) plus the user's Supabase JWT, and this
 * function:
 *
 *   1. Looks up the project via RLS-guarded SELECT on public.projects.
 *   2. Reads the Notion schema mapping from ppgantt.notion_schema_mappings.
 *   3. Reads all ppgantt.tasks rows for that project where
 *      notion_sync_status IN ('clean','local_ahead') — these are the rows
 *      where local is at least as fresh as Notion. Rows with
 *      notion_sync_status = 'notion_ahead' or 'conflict' are skipped in
 *      v1; the conflict UI will resolve them explicitly in a later pass.
 *   4. PATCHes each qualifying task into Notion via NOTION_WRITE_TOKEN,
 *      verifies via read-back, and updates the local row
 *      (last_pushed_to_notion_at, notion_sync_status = 'clean').
 *   5. Writes a single ppgantt.sync_events row summarizing the run.
 *
 * The 3 req/sec Notion rate limit is preserved (~400ms sleep between
 * page operations). Per-task result shape matches the previous
 * gantt-notion-upload branch (verified / patch_failed /
 * patched_not_verified / invalid_input / skipped_status) so the viewer's
 * result-toast code keeps working.
 */

'use strict';

const NOTION_API_VERSION = '2022-06-28';
const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_ID_PATTERN = UUID_PATTERN;
const THROTTLE_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function normalizePageId(id) {
  if (typeof id !== 'string') return null;
  if (PAGE_ID_PATTERN.test(id)) return id.toLowerCase();
  const clean = id.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(clean)) {
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
  }
  return null;
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

async function sbPatch(supabaseUrl, accessToken, anonKey, profile, path, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(accessToken, anonKey, profile, {
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, raw: text };
}

async function sbInsert(supabaseUrl, accessToken, anonKey, profile, path, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'POST',
    headers: sbHeaders(accessToken, anonKey, profile, {
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: null, raw: text };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text || '[]'), raw: text };
  } catch (_) {
    return { ok: false, status: 500, body: null, raw: text };
  }
}

async function getCurrentUserId(supabaseUrl, accessToken, anonKey) {
  // /auth/v1/user returns the JWT subject — used to populate sync_events.actor_id.
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

async function patchNotionPage(pageId, properties, notionToken) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, body: parsed, raw: text };
}

async function getNotionPage(pageId, notionToken) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': NOTION_API_VERSION,
    },
  });
  if (!res.ok) return { ok: false, status: res.status, page: null };
  const page = await res.json();
  return { ok: true, status: res.status, page };
}

function readDateStart(page, fieldName) {
  if (!page || !page.properties) return null;
  const prop = page.properties[fieldName];
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  return prop.date.start || null;
}

function datesMatch(expected, actual) {
  if (!expected || !actual) return expected === actual;
  return String(actual).slice(0, 10) === String(expected).slice(0, 10);
}

// ─── Core push loop (exported for tests) ─────────────────────────────────

/**
 * Given the mapping + qualifying task rows, PATCH each into Notion and
 * verify. Returns {results, verifiedCount, failedCount}.
 *
 * `notionClient` is injected for tests — real handler wires up the real
 * Notion fetch pair.
 */
async function pushTasksToNotion({
  tasks,
  mapping,
  userDisplayName,
  syncTimestamp,
  notionClient,
  sleepMs = THROTTLE_MS,
}) {
  const startField = mapping.start_field;
  const endField = mapping.end_field;
  const updatedByField = mapping.updated_by_field;
  const lastSyncField = mapping.last_sync_field;

  const results = [];

  for (const task of tasks) {
    const rawId = task.notion_page_id || task.id;
    const pageId = normalizePageId(rawId);
    if (!pageId) {
      results.push({
        taskId: task.id,
        pageId: rawId || null,
        status: 'invalid_input',
        error: 'Invalid notion_page_id',
      });
      continue;
    }

    const startDate = task.start_date;
    const endDate = task.end_date;
    if (!startDate || !endDate) {
      results.push({
        taskId: task.id,
        pageId,
        status: 'invalid_input',
        error: 'Missing start_date or end_date',
      });
      continue;
    }

    const properties = {
      [startField]: { date: { start: startDate } },
      [endField]: { date: { start: endDate } },
    };
    if (updatedByField) {
      properties[updatedByField] = {
        rich_text: [{ type: 'text', text: { content: userDisplayName } }],
      };
    }
    if (lastSyncField) {
      properties[lastSyncField] = { date: { start: syncTimestamp } };
    }

    const patchRes = await notionClient.patch(pageId, properties);

    if (!patchRes.ok) {
      const errorMessage =
        patchRes.body && patchRes.body.message
          ? patchRes.body.message
          : `Notion PATCH failed: HTTP ${patchRes.status}`;
      results.push({
        taskId: task.id,
        pageId,
        status: 'patch_failed',
        error: errorMessage,
        httpStatus: patchRes.status,
      });
      await sleep(sleepMs);
      continue;
    }

    await sleep(sleepMs);

    const verifyRes = await notionClient.get(pageId);
    if (!verifyRes.ok) {
      results.push({
        taskId: task.id,
        pageId,
        status: 'patched_not_verified',
        error: `Read-back failed: HTTP ${verifyRes.status}`,
        httpStatus: verifyRes.status,
      });
      await sleep(sleepMs);
      continue;
    }

    const actualStart = readDateStart(verifyRes.page, startField);
    const actualEnd = readDateStart(verifyRes.page, endField);
    const startOk = datesMatch(startDate, actualStart);
    const endOk = datesMatch(endDate, actualEnd);

    if (startOk && endOk) {
      results.push({
        taskId: task.id,
        pageId,
        status: 'verified',
        newStart: startDate,
        newEnd: endDate,
        updatedBy: userDisplayName,
        syncedAt: syncTimestamp,
      });
    } else {
      results.push({
        taskId: task.id,
        pageId,
        status: 'patched_not_verified',
        error: 'Read-back mismatch',
        expected: { start: startDate, end: endDate },
        actual: { start: actualStart, end: actualEnd },
      });
    }

    await sleep(sleepMs);
  }

  const verifiedCount = results.filter((r) => r.status === 'verified').length;
  const failedCount = results.length - verifiedCount;
  return { results, verifiedCount, failedCount };
}

// ─── Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const notionToken = process.env.NOTION_WRITE_TOKEN;

    if (!supabaseUrl || !anonKey || !notionToken) {
      console.error('push-to-notion error: missing required env vars');
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

    // Snapshot contract (Phase 3b): Push is always sourced from a caller-
    // provided snapshot row, never from the live ppgantt.tasks table. The
    // snapshot was created either by Pull (kind='import') or manually by
    // the user (kind='snapshot'). We freeze the payload here, push it,
    // and flip the snapshot to kind='pushed' on the final chunk of a
    // successful push.
    const rawSnapshotId = body.snapshot_id;
    if (!rawSnapshotId || typeof rawSnapshotId !== 'string' || !UUID_PATTERN.test(rawSnapshotId)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'snapshot_id is required and must be a UUID' }),
      };
    }
    const snapshotId = rawSnapshotId;

    // is_final_chunk: when the client batches a large push into multiple
    // calls, only the final one should flip the snapshot. Defaults to true
    // for the common unchunked case.
    const isFinalChunk = body.is_final_chunk === false ? false : true;

    // Optional filter: restrict this push to a specific chunk of Notion page IDs.
    // Used by the client-side chunked-push loop to stay under Lambda's 30s timeout
    // on large pushes without losing data fidelity (we never fudge timestamps).
    // Shape: ["<uuid>", "<uuid>", ...].  Omitted → push everything pushable.
    let notionPageIdFilter = null;
    if (Array.isArray(body.notion_page_ids)) {
      const ids = body.notion_page_ids.filter(
        (x) => typeof x === 'string' && UUID_PATTERN.test(x),
      );
      if (ids.length === 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'notion_page_ids, if provided, must be a non-empty array of UUIDs' }),
        };
      }
      notionPageIdFilter = ids;
    }

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

    // Identify the authenticated user — used both as actor_id on the
    // sync_events row and as the "who pushed" audit stamp in Notion.
    const userId = await getCurrentUserId(supabaseUrl, accessToken, anonKey);
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const [mappingRes, profileRes, snapshotRes] = await Promise.all([
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `notion_schema_mappings?select=notion_db_id,mapping&project_id=eq.${projectId}`,
      ),
      sbSelect(
        supabaseUrl, accessToken, anonKey, null,
        `profiles?select=display_name&id=eq.${userId}`,
      ),
      // Snapshot lookup. Also filtered by project_id: even though RLS would
      // block cross-project snapshot access, the explicit filter is a
      // belt-and-suspenders guard and lets the empty-body check stand in
      // for "not found OR not yours" → 404 either way.
      sbSelect(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `snapshots?select=*&id=eq.${encodeURIComponent(snapshotId)}&project_id=eq.${projectId}`,
      ),
    ]);

    for (const r of [mappingRes, profileRes, snapshotRes]) {
      if (!r.ok) {
        console.error('push-to-notion: supabase fetch status', r.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
    }

    if (!mappingRes.body || mappingRes.body.length === 0) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Project has no Notion schema mapping' }),
      };
    }

    if (!snapshotRes.body || snapshotRes.body.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Snapshot not found' }),
      };
    }
    const snapshot = snapshotRes.body[0];
    if (snapshot.kind === 'pushed') {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'snapshot already pushed' }),
      };
    }

    const mapping = mappingRes.body[0].mapping || {};
    if (!mapping.start_field || !mapping.end_field) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Roadmap schema missing start/end date fields' }),
      };
    }

    const userDisplayName =
      profileRes.body && profileRes.body[0] && profileRes.body[0].display_name
        ? profileRes.body[0].display_name
        : 'Unknown';

    // Derive the pushable task list from the snapshot's frozen payload.
    // The payload is the viewer-shape response (assembleRoadmapResponse):
    // { source, schema_mapping, phase_palette, tasks: [{id, start, end, meta: {...}}, ...] }.
    // We flatten each viewer-shape row back to the column-flat shape that
    // pushTasksToNotion expects (start_date/end_date/notion_page_id at top
    // level) — same adapter used by the old live-tasks path.
    const PUSHABLE_STATUSES = new Set(['clean', 'local_ahead']);
    const rawPayload = snapshot.payload;
    // Support two payload shapes: new viewer-shape (object with .tasks) and
    // legacy bare-array (only ever produced by the intermediate commit before
    // this change; kept so stale snapshots don't 500 the push).
    const payloadTasks = Array.isArray(rawPayload)
      ? rawPayload
      : Array.isArray(rawPayload && rawPayload.tasks) ? rawPayload.tasks : [];
    const flatten = (t) => {
      if (!t || typeof t !== 'object') return null;
      const meta = t.meta || {};
      return {
        id: t.id,
        start_date: t.start_date || t.start || '',
        end_date: t.end_date || t.end || '',
        notion_page_id: t.notion_page_id || meta.notion_page_id || null,
        notion_sync_status: t.notion_sync_status || meta.notion_sync_status || null,
      };
    };
    let pushableTasks = payloadTasks
      .map(flatten)
      .filter((t) => t && PUSHABLE_STATUSES.has(t.notion_sync_status));
    if (notionPageIdFilter && notionPageIdFilter.length > 0) {
      const allowed = new Set(notionPageIdFilter.map((x) => x.toLowerCase()));
      pushableTasks = pushableTasks.filter(
        (t) => t.notion_page_id && allowed.has(String(t.notion_page_id).toLowerCase()),
      );
    }

    const startedAt = new Date().toISOString();
    const syncTimestamp = startedAt;

    const notionClient = {
      patch: (pageId, properties) => patchNotionPage(pageId, properties, notionToken),
      get: (pageId) => getNotionPage(pageId, notionToken),
    };

    const { results, verifiedCount, failedCount } = await pushTasksToNotion({
      tasks: pushableTasks,
      mapping,
      userDisplayName,
      syncTimestamp,
      notionClient,
    });

    // Update ppgantt.tasks for each verified row. PATCH per row so RLS
    // evaluates each edit against the caller; group by status is not
    // worth batching at current volume.
    for (const r of results) {
      if (r.status !== 'verified') continue;
      const patchRes = await sbPatch(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `tasks?id=eq.${encodeURIComponent(r.taskId)}`,
        {
          last_pushed_to_notion_at: syncTimestamp,
          notion_sync_status: 'clean',
        },
      );
      if (!patchRes.ok) {
        // Not fatal for the push overall — Notion is already updated.
        // Downgrade the per-task status so the UI shows a warning, but
        // still count the Notion side as verified.
        r.localStatusUpdateFailed = true;
      }
    }

    const finishedAt = new Date().toISOString();
    const overallStatus =
      failedCount === 0 && results.length > 0
        ? 'success'
        : verifiedCount > 0
          ? 'partial'
          : 'failed';

    const syncEventInsert = await sbInsert(
      supabaseUrl, accessToken, anonKey, 'ppgantt',
      'sync_events',
      {
        project_id: projectId,
        actor_id: userId,
        direction: 'push_to_notion',
        status: overallStatus,
        rows_read: results.length,
        rows_written: verifiedCount,
        rows_failed: failedCount,
        error_detail:
          failedCount > 0
            ? {
                failures: results
                  .filter((r) => r.status !== 'verified')
                  .map((r) => ({
                    task_id: r.taskId,
                    status: r.status,
                    error: r.error || null,
                  })),
              }
            : null,
        started_at: startedAt,
        finished_at: finishedAt,
      },
    );

    const syncEventId =
      syncEventInsert.ok && syncEventInsert.body && syncEventInsert.body[0]
        ? syncEventInsert.body[0].id
        : null;

    // Flip the snapshot kind → 'pushed' only on the final chunk of a
    // fully-successful push. Partial/failed pushes leave the snapshot in
    // its current kind so the user can retry. A failed flip is logged but
    // non-fatal: Notion is already updated, so returning 500 would mislead
    // the client into thinking the push itself failed.
    let snapshotFlipped = false;
    let snapshotFlipFailed = false;
    if (isFinalChunk && overallStatus === 'success') {
      const flipRes = await sbPatch(
        supabaseUrl, accessToken, anonKey, 'ppgantt',
        `snapshots?id=eq.${encodeURIComponent(snapshotId)}`,
        {
          kind: 'pushed',
          pushed_at: syncTimestamp,
          pushed_sync_event_id: syncEventId,
        },
      );
      if (flipRes.ok) {
        snapshotFlipped = true;
      } else {
        snapshotFlipFailed = true;
        console.error('push-to-notion: snapshot flip failed, status', flipRes.status);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        syncEventId,
        snapshotId,
        snapshotFlipped,
        snapshotFlipFailed,
        totalChanges: results.length,
        verifiedCount,
        failedCount,
        status: overallStatus,
        syncedAt: syncTimestamp,
        updatedBy: userDisplayName,
        results,
      }),
    };
  } catch (err) {
    console.error(
      'push-to-notion error:',
      err && err.name ? err.name : 'unknown',
      err && err.message ? err.message : '',
    );
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

// Exported for tests.
exports._internal = {
  pushTasksToNotion,
  normalizePageId,
  datesMatch,
  readDateStart,
  extractBearer,
};
