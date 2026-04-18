/**
 * supabase-gate.js — PPGantt Supabase Auth Gate
 *
 * Replacement for the legacy PIN-based auth-gate.js. Same shape:
 *   - No-op on `/` (public demo).
 *   - On a gated slug route (matches /^\/[a-z0-9-]+$/), check Supabase
 *     session; if none, redirect to /login?redirect=<current-path>.
 *   - If session exists, install a fetch() override that rewrites:
 *       /api/manifest          → synthetic one-file manifest for the slug
 *       /api/data/<slug>.json  → /.netlify/functions/get-roadmap?slug=<slug>
 *                                with `Authorization: Bearer <access_token>`
 *     All other fetches pass through untouched.
 *
 * Loaded as the first <script type="module"> in <head>. Because module
 * scripts are deferred by default, the viewer's later script tags will
 * execute AFTER this one — so the fetch override is in place before the
 * viewer makes its first fetch.
 *
 * Exports: installGate(), isGatedSlugRoute(), PUBLIC_PATHS, supabase,
 * logout. `installGate` is factored out so unit tests can inject a fake
 * Supabase client and a fake window/location object.
 */

// Top-of-file: pure, dependency-free helpers. Safe to import from tests.

const PUBLIC_PATHS = new Set(['/', '/index.html', '/login', '/login.html', '/auth/callback']);

function isGatedSlugRoute(path) {
  if (PUBLIC_PATHS.has(path)) return false;
  const normalized = path.replace(/\/$/, '');
  return /^\/[a-z0-9-]+$/.test(normalized);
}

/**
 * Core gate logic. All side effects happen on the passed-in `win`.
 *
 * @param {object} deps
 * @param {object} deps.supabase  — Supabase client (uses .auth.getSession)
 * @param {object} deps.win       — window-like: fetch, location, assignable props
 * @returns {object} descriptor: { mode, slug?, sessionPromise?, next? }
 */
function installGate({ supabase, win }) {
  const loc = win.location;
  const path = loc.pathname;

  // /auth/callback: Supabase client handles URL-hash tokens via
  // detectSessionInUrl:true. We just forward to `next`.
  if (path === '/auth/callback') {
    const params = new URLSearchParams(loc.search || '');
    const nextRaw = params.get('next') || '/';
    const next =
      (nextRaw.charAt(0) === '/' && nextRaw.indexOf('//') === -1) ? nextRaw : '/';
    supabase.auth.getSession().then(() => { loc.replace(next); });
    return { mode: 'callback', next };
  }

  if (!isGatedSlugRoute(path)) {
    return { mode: 'public' };
  }

  const slug = path.replace(/\/$/, '').slice(1);
  win.__PPGANTT_SLUG__ = slug;

  const sessionPromise = supabase.auth.getSession().then(({ data }) => {
    const session = data && data.session;
    if (!session) {
      const redirect = encodeURIComponent(loc.pathname + (loc.search || ''));
      loc.replace('/login?redirect=' + redirect);
      return new Promise(() => {}); // hang in-flight fetches
    }
    return session;
  });

  const _origFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;

  win.fetch = function (url, opts) {
    const urlStr = typeof url === 'string' ? url : (url && url.url) || '';

    if (urlStr === '/api/manifest' || urlStr.endsWith('/api/manifest')) {
      const manifest = {
        version: 1,
        generated_at: new Date().toISOString(),
        files: [{
          filename: slug + '.json',
          table_name: slug.toUpperCase(),
          notion_url: '',
          data_source_id: '',
          synced_at: new Date().toISOString(),
          row_count: null,
          is_fixture: false,
        }],
      };
      return Promise.resolve(new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    const dataMatch = urlStr.match(/\/api\/data\/([a-z0-9-]+)\.json$/i);
    if (dataMatch) {
      const dataSlug = dataMatch[1];
      return sessionPromise.then((session) => {
        const headers = new Headers((opts && opts.headers) || {});
        headers.set('Authorization', 'Bearer ' + session.access_token);
        return _origFetch('/.netlify/functions/get-roadmap?slug=' + dataSlug, {
          ...opts,
          headers,
        });
      });
    }

    return _origFetch(url, opts);
  };

  return { mode: 'gated', slug, sessionPromise };
}

export { installGate, isGatedSlugRoute, PUBLIC_PATHS };

// ─── Browser bootstrap ───────────────────────────────────────────────────
// Only run when we're in a real browser. In node-based tests, callers
// import installGate directly and provide their own fakes.

let supabase = null;
let logout = async () => {};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const [clientMod, configMod] = await Promise.all([
    import('https://esm.sh/@supabase/supabase-js@2'),
    import('./supabase-config.js'),
  ]);
  const { createClient } = clientMod;
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = configMod;

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  logout = async function () {
    try { await supabase.auth.signOut(); } catch (_) { /* ignore */ }
    window.location.replace('/login?logout=1');
  };

  window.__PPGANTT_SUPABASE__ = supabase;
  window.__PPGANTT_LOGOUT__ = logout;

  installGate({ supabase, win: window });
}

export { supabase, logout };
