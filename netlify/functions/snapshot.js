/**
 * snapshot.js — single-snapshot CRUD.
 *
 * GET    /.netlify/functions/snapshot?id=<uuid>
 *   Returns the full snapshot row including `payload`. 404 if the row is
 *   not visible to this caller (RLS hid it or the id doesn't exist).
 *
 * POST   /.netlify/functions/snapshot
 *   Creates a user-saved snapshot (kind='snapshot'). Body carries the
 *   viewer-shape roadmap payload and optional label/notes. Returns 201
 *   with the inserted row under `{ snapshot: <row> }`.
 *
 * DELETE /.netlify/functions/snapshot?id=<uuid>
 *   Deletes the snapshot. Uses Prefer: return=representation so we can
 *   detect "0 rows affected" (RLS hid it / wrong id) and return 404.
 *
 * Auth contract mirrors the other ppgantt functions: the caller sends a
 * Supabase user JWT in `Authorization: Bearer`, which we forward to
 * PostgREST so RLS enforces project membership.
 *
 * Sibling: list-snapshots.js owns the list view (GET all), pull/push own
 * the server-side snapshot lifecycle. This file owns one-row CRUD only.
 */

'use strict';

const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_LEN = 200;

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

async function sbDelete(supabaseUrl, accessToken, anonKey, profile, path) {
  // Prefer: return=representation lets us count affected rows. A zero-row
  // response means RLS hid it or the id didn't match — we surface that as
  // 404 at the handler level.
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders(accessToken, anonKey, profile, {
      Prefer: 'return=representation',
    }),
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
  // /auth/v1/user returns the JWT subject — used to stamp created_by on
  // the inserted snapshot row.
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

// ─── Label auto-gen (matches pull-from-notion.js format) ────────────────
//
// Pull labels look like: "Notion pull YY-MM-DD HH:MM" (UTC, 2-digit year).
// Manual snapshots use: "Snapshot YY-MM-DD HH:MM" — same shape so the
// list UI renders them consistently.

function autoSnapshotLabel(now) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = pad(d.getUTCFullYear() % 100);
  return `Snapshot ${yy}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ─── Per-method handlers ─────────────────────────────────────────────────

async function handleGet(event, supabaseUrl, accessToken, anonKey) {
  const qs = event.queryStringParameters || {};
  const id = qs.id;
  if (!id || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid id' }) };
  }

  const res = await sbSelect(
    supabaseUrl, accessToken, anonKey, 'ppgantt',
    `snapshots?select=*&id=eq.${encodeURIComponent(id)}`,
  );
  if (!res.ok) {
    console.error('snapshot GET: supabase fetch status', res.status);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
  const rows = res.body || [];
  if (rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Snapshot not found' }) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(rows[0]),
  };
}

async function handlePost(event, supabaseUrl, accessToken, anonKey) {
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const slug = body.slug;
  const rawProjectId = body.project_id;
  const label = body.label;
  const notes = body.notes;
  const payload = body.payload;

  // Payload validation — must be an object with a tasks array. Reject
  // arrays (legacy shape) at the API boundary so we never store them.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'payload is required and must be an object' }),
    };
  }
  if (!Array.isArray(payload.tasks)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'payload.tasks must be an array' }),
    };
  }

  // Label validation — optional, but if provided must be a non-empty
  // string <= MAX_LABEL_LEN chars. Auto-generated below if absent.
  let resolvedLabel;
  if (label === undefined || label === null || label === '') {
    resolvedLabel = autoSnapshotLabel(new Date());
  } else {
    if (typeof label !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'label must be a string' }) };
    }
    if (label.length > MAX_LABEL_LEN) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `label must be <= ${MAX_LABEL_LEN} chars` }),
      };
    }
    resolvedLabel = label;
  }

  // Notes validation — optional, must be a string if provided.
  let resolvedNotes = null;
  if (notes !== undefined && notes !== null && notes !== '') {
    if (typeof notes !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'notes must be a string' }) };
    }
    resolvedNotes = notes;
  }

  // Resolve project_id from slug or direct UUID. RLS on public.projects
  // hides rows where the caller isn't a member — empty response = 403.
  let projectId = null;
  if (rawProjectId && typeof rawProjectId === 'string' && UUID_PATTERN.test(rawProjectId)) {
    projectId = rawProjectId;
  }
  if (!projectId) {
    if (!slug || typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid slug or project_id' }),
      };
    }
    const projRes = await sbSelect(
      supabaseUrl, accessToken, anonKey, null,
      `projects?select=id&slug=eq.${encodeURIComponent(slug)}`,
    );
    if (!projRes.ok) {
      console.error('snapshot POST: projects fetch status', projRes.status);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }
    if (!projRes.body || projRes.body.length === 0) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
    projectId = projRes.body[0].id;
  }

  // auth.uid() stamp — populates created_by on the new row.
  const userId = await getCurrentUserId(supabaseUrl, accessToken, anonKey);
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const insertRes = await sbInsert(
    supabaseUrl, accessToken, anonKey, 'ppgantt',
    'snapshots',
    {
      project_id: projectId,
      kind: 'snapshot',
      label: resolvedLabel,
      notes: resolvedNotes,
      payload: payload,
      created_by: userId,
    },
  );
  if (!insertRes.ok) {
    console.error('snapshot POST: insert status', insertRes.status);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
  const row = (insertRes.body && insertRes.body[0]) || null;
  if (!row) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Insert returned no row' }) };
  }

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ snapshot: row }),
  };
}

async function handleDelete(event, supabaseUrl, accessToken, anonKey) {
  const qs = event.queryStringParameters || {};
  const id = qs.id;
  if (!id || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid id' }) };
  }

  const res = await sbDelete(
    supabaseUrl, accessToken, anonKey, 'ppgantt',
    `snapshots?id=eq.${encodeURIComponent(id)}`,
  );
  if (!res.ok) {
    console.error('snapshot DELETE: supabase status', res.status);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
  const rows = res.body || [];
  if (rows.length === 0) {
    // Zero rows means RLS hid it or the id was wrong. Either way the
    // caller can't see anything; surface as 404.
    return { statusCode: 404, body: JSON.stringify({ error: 'Snapshot not found' }) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ deleted: true, id }),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      console.error('snapshot error: missing SUPABASE_URL or SUPABASE_ANON_KEY');
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }

    const accessToken = extractBearer(event.headers);
    if (!accessToken) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    if (method === 'GET') return handleGet(event, supabaseUrl, accessToken, anonKey);
    if (method === 'POST') return handlePost(event, supabaseUrl, accessToken, anonKey);
    return handleDelete(event, supabaseUrl, accessToken, anonKey);
  } catch (err) {
    console.error(
      'snapshot error:',
      err && err.name ? err.name : 'unknown',
      err && err.message ? err.message : '',
    );
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

// Exported for unit tests. Not part of the Netlify runtime contract.
exports._internal = {
  extractBearer,
  autoSnapshotLabel,
  UUID_PATTERN,
  SLUG_PATTERN,
  MAX_LABEL_LEN,
};
