const jwt = require('jsonwebtoken');

const NOTION_API_VERSION = '2022-06-28';
const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
const THROTTLE_MS = 400;
const PAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
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

async function fetchRoadmapMapping(slug, githubToken) {
  const url = `https://api.github.com/repos/pandastick/societist-workspace/contents/roadmap/${slug}.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'ppgantt-hosted',
    },
  });
  if (!res.ok) {
    return { error: `GitHub fetch failed: ${res.status}`, mapping: null };
  }
  const body = await res.json();
  const mapping = body && body.schema_mapping;
  if (!mapping) {
    return { error: 'Roadmap JSON has no schema_mapping block', mapping: null };
  }
  return { error: null, mapping };
}

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
  return actual.slice(0, 10) === expected.slice(0, 10);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const jwtSecretEnv = process.env.PPGANTT_JWT_SECRET;
    const githubToken = process.env.GITHUB_DATA_TOKEN;
    const notionToken = process.env.NOTION_WRITE_TOKEN;

    if (!jwtSecretEnv || !githubToken || !notionToken) {
      console.error('push-to-notion error: missing required env vars');
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }

    const cookieHeader = getHeader(event.headers, 'cookie');
    const cookies = parseCookies(cookieHeader);
    const token = cookies.ppg_session;
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const secret = Buffer.from(jwtSecretEnv, 'base64');
    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (_) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const userName = typeof payload.name === 'string' ? payload.name : 'Unknown';
    const userSlugs = Array.isArray(payload.slugs) ? payload.slugs : [];

    let body;
    try {
      body = JSON.parse(event.body || '');
    } catch (_) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const slug = body && body.slug;
    const changes = body && body.changes;

    if (!slug || typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid slug' }) };
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No changes provided' }) };
    }
    if (changes.length > 200) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Too many changes in one request (max 200)' }) };
    }

    const hasAccess = userSlugs.includes('*') || userSlugs.includes(slug);
    if (!hasAccess) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    const { error: mappingErr, mapping } = await fetchRoadmapMapping(slug, githubToken);
    if (mappingErr || !mapping) {
      console.error('push-to-notion: mapping fetch error:', mappingErr);
      return { statusCode: 500, body: JSON.stringify({ error: 'Cannot load roadmap schema' }) };
    }

    const startField = mapping.start_field;
    const endField = mapping.end_field;
    const updatedByField = mapping.updated_by_field;
    const lastSyncField = mapping.last_sync_field;

    if (!startField || !endField) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Roadmap schema missing start/end date fields' }) };
    }
    if (!updatedByField || !lastSyncField) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Roadmap schema missing audit fields (updated_by_field, last_sync_field). See PPGantt CLAUDE.md "Per-Roadmap Schema Contract".' }) };
    }

    const results = [];
    const syncTimestamp = new Date().toISOString();

    for (const change of changes) {
      const rawId = change && change.pageId;
      const newStart = change && change.newStart;
      const newEnd = change && change.newEnd;

      const pageId = normalizePageId(rawId);
      if (!pageId) {
        results.push({ pageId: rawId || null, status: 'invalid_input', error: 'Invalid pageId' });
        continue;
      }
      if (!DATE_PATTERN.test(newStart || '') || !DATE_PATTERN.test(newEnd || '')) {
        results.push({ pageId, status: 'invalid_input', error: 'Invalid date (expected YYYY-MM-DD)' });
        continue;
      }

      const properties = {
        [startField]: { date: { start: newStart } },
        [endField]: { date: { start: newEnd } },
        [updatedByField]: {
          rich_text: [{ type: 'text', text: { content: userName } }],
        },
        [lastSyncField]: { date: { start: syncTimestamp } },
      };

      const patchRes = await patchNotionPage(pageId, properties, notionToken);

      if (!patchRes.ok) {
        const errorMessage = patchRes.body && patchRes.body.message
          ? patchRes.body.message
          : `Notion PATCH failed: HTTP ${patchRes.status}`;
        results.push({ pageId, status: 'patch_failed', error: errorMessage, httpStatus: patchRes.status });
        await sleep(THROTTLE_MS);
        continue;
      }

      await sleep(THROTTLE_MS);

      const verifyRes = await getNotionPage(pageId, notionToken);
      if (!verifyRes.ok) {
        results.push({
          pageId,
          status: 'patched_not_verified',
          error: `Read-back failed: HTTP ${verifyRes.status}`,
          httpStatus: verifyRes.status,
        });
        await sleep(THROTTLE_MS);
        continue;
      }

      const actualStart = readDateStart(verifyRes.page, startField);
      const actualEnd = readDateStart(verifyRes.page, endField);
      const startOk = datesMatch(newStart, actualStart);
      const endOk = datesMatch(newEnd, actualEnd);

      if (startOk && endOk) {
        results.push({ pageId, status: 'verified', newStart, newEnd, updatedBy: userName, syncedAt: syncTimestamp });
      } else {
        results.push({
          pageId,
          status: 'patched_not_verified',
          error: 'Read-back mismatch',
          expected: { start: newStart, end: newEnd },
          actual: { start: actualStart, end: actualEnd },
        });
      }

      await sleep(THROTTLE_MS);
    }

    const verifiedCount = results.filter((r) => r.status === 'verified').length;
    const failedCount = results.length - verifiedCount;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        totalChanges: changes.length,
        verifiedCount,
        failedCount,
        syncedAt: syncTimestamp,
        updatedBy: userName,
        results,
      }),
    };
  } catch (err) {
    console.error('push-to-notion error:', err && err.name ? err.name : 'unknown', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
