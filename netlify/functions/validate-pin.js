const jwt = require('jsonwebtoken');

const TIMING_DELAY_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || '');
    } catch (parseErr) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const pin = body && body.pin;
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid PIN format' }),
      };
    }

    const pinsEnv = process.env.PPGANTT_PINS;
    const jwtSecretEnv = process.env.PPGANTT_JWT_SECRET;

    if (!pinsEnv || !jwtSecretEnv) {
      console.error('validate-pin error: missing required env vars');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal error' }),
      };
    }

    let pinMap;
    try {
      const decoded = Buffer.from(pinsEnv, 'base64').toString('utf8');
      pinMap = JSON.parse(decoded);
    } catch (decodeErr) {
      console.error('validate-pin error: failed to decode PPGANTT_PINS');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal error' }),
      };
    }

    const entry = Object.prototype.hasOwnProperty.call(pinMap, pin)
      ? pinMap[pin]
      : null;

    // Constant-time delay regardless of match to mitigate timing attacks.
    await sleep(TIMING_DELAY_MS);

    if (!entry) {
      return {
        statusCode: 401,
        body: JSON.stringify({ valid: false, error: 'Invalid PIN' }),
      };
    }

    const secret = Buffer.from(jwtSecretEnv, 'base64');
    const payload = {
      name: entry.name,
      slugs: entry.slugs,
      iat: Math.floor(Date.now() / 1000),
    };

    const token = jwt.sign(payload, secret, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `ppg_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
      },
      body: JSON.stringify({
        valid: true,
        name: entry.name,
        slugs: entry.slugs,
      }),
    };
  } catch (err) {
    console.error('validate-pin error:', err && err.name ? err.name : 'unknown');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};
