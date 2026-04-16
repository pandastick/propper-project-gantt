const jwt = require('jsonwebtoken');

const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return result;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
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

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const jwtSecretEnv = process.env.PPGANTT_JWT_SECRET;
    const githubToken = process.env.GITHUB_DATA_TOKEN;

    if (!jwtSecretEnv || !githubToken) {
      console.error('get-roadmap error: missing required env vars');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal error' }),
      };
    }

    const cookieHeader = getHeader(event.headers, 'cookie');
    const cookies = parseCookies(cookieHeader);
    const token = cookies.ppg_session;

    if (!token || typeof token !== 'string') {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const secret = Buffer.from(jwtSecretEnv, 'base64');
    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (verifyErr) {
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

    const slugs = Array.isArray(payload.slugs) ? payload.slugs : [];
    const hasAccess = slugs.includes('*') || slugs.includes(slug);

    if (!hasAccess) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }

    const url = `https://api.github.com/repos/pandastick/ppgantt-data/contents/roadmap/${slug}.json`;
    const ghRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'ppgantt-hosted',
      },
    });

    if (ghRes.status === 404) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Roadmap not found' }),
      };
    }

    if (!ghRes.ok) {
      console.error('get-roadmap error: github fetch status', ghRes.status);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal error' }),
      };
    }

    const rawBody = await ghRes.text();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: rawBody,
    };
  } catch (err) {
    console.error('get-roadmap error:', err && err.name ? err.name : 'unknown');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};
