/**
 * list-snapshots.js — list snapshots for a project.
 *
 * GET /.netlify/functions/list-snapshots?slug=<slug>
 * GET /.netlify/functions/list-snapshots?project_id=<uuid>
 *
 * Returns the sidebar feed for Phase 3a: every row in ppgantt.snapshots
 * for the given project, ordered by created_at DESC. The payload column
 * is intentionally excluded — snapshot blobs can be tens of KB each and
 * the list UI only needs the card metadata. The sibling snapshot.js
 * function (GET /snapshot/:id) returns the full payload on demand.
 *
 * Auth: same contract as get-roadmap / pull-from-notion. The browser
 * (supabase-gate.js) sends the user's Supabase JWT in the Authorization
 * header; we forward it to PostgREST so RLS enforces project membership.
 * If the slug lookup returns [] we respond 403 (same semantics as
 * get-roadmap: don't leak slug existence).
 */

'use strict';

const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns returned in the list view. Deliberately excludes `payload` —
// see file docstring. Kept as a constant so the tests can assert on it.
const LIST_COLUMNS =
  'id,kind,label,notes,pushed_at,created_at,created_by,source_sync_event_id,pushed_sync_event_id';

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
      console.error('list-snapshots error: missing SUPABASE_URL or SUPABASE_ANON_KEY');
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
    const projectIdParam = qs.project_id;

    if (!slug && !projectIdParam) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing slug or project_id' }),
      };
    }

    if (slug !== undefined && slug !== null) {
      if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid slug' }),
        };
      }
    }

    if (projectIdParam !== undefined && projectIdParam !== null && !slug) {
      if (typeof projectIdParam !== 'string' || !UUID_PATTERN.test(projectIdParam)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid project_id' }),
        };
      }
    }

    // 1. Resolve slug → project_id if slug was provided. RLS on
    //    public.projects hides rows where the caller is not a member, so
    //    an empty array means "forbidden" from the client's POV.
    let projectId;
    if (slug) {
      const projRes = await sbSelect(
        supabaseUrl,
        accessToken,
        anonKey,
        null,
        `projects?select=id&slug=eq.${encodeURIComponent(slug)}`,
      );
      if (!projRes.ok) {
        console.error('list-snapshots: projects fetch status', projRes.status);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
      }
      const projects = projRes.body || [];
      if (projects.length === 0) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
      }
      projectId = projects[0].id;
    } else {
      projectId = projectIdParam;
    }

    // 2. Fetch the snapshot list. RLS on ppgantt.snapshots scopes to
    //    project members via public.is_project_member(project_id). If
    //    the caller isn't a member they simply get [].
    const snapRes = await sbSelect(
      supabaseUrl,
      accessToken,
      anonKey,
      'ppgantt',
      `snapshots?select=${LIST_COLUMNS}&project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc`,
    );
    if (!snapRes.ok) {
      console.error('list-snapshots: snapshots fetch status', snapRes.status);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }

    // 3. Batch-fetch profile initials for distinct created_by UUIDs so
    //    the sidebar can render an owner badge (e.g. "PP"). RLS on
    //    public.profiles is "select for authenticated" — safe to query
    //    without exposing anything the user couldn't already see via
    //    auth.users introspection. Missing rows fall back to null and
    //    the frontend renders "?" or email-initial.
    const snapshots = snapRes.body || [];
    const distinctCreatorIds = Array.from(
      new Set(snapshots.map((s) => s.created_by).filter(Boolean)),
    );
    const initialsByUserId = {};
    if (distinctCreatorIds.length > 0) {
      try {
        const idList = distinctCreatorIds
          .map((id) => encodeURIComponent(id))
          .join(',');
        const profRes = await sbSelect(
          supabaseUrl,
          accessToken,
          anonKey,
          null,
          `profiles?select=id,initials&id=in.(${idList})`,
        );
        if (profRes.ok) {
          for (const row of profRes.body || []) {
            if (row.initials) initialsByUserId[row.id] = row.initials;
          }
        }
      } catch (_) {
        // Silent fall-through — initials are a UX nicety, not a blocker.
      }
    }
    const enrichedSnapshots = snapshots.map((s) => ({
      ...s,
      created_by_initials: initialsByUserId[s.created_by] || null,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ snapshots: enrichedSnapshots }),
    };
  } catch (err) {
    console.error(
      'list-snapshots error:',
      err && err.name ? err.name : 'unknown',
      err && err.message ? err.message : '',
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

// Exported for unit tests.
exports._internal = {
  extractBearer,
  SLUG_PATTERN,
  UUID_PATTERN,
  LIST_COLUMNS,
};
