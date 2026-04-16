/**
 * auth-gate.js — PPGantt Hosted Auth Gate
 *
 * Loaded on every page of the hosted instance, but only activates on
 * gated slug routes (e.g. /societist). On the public root (/) and all
 * other routes, this file is a no-op so the OSS demo viewer and local
 * `npm start` keep working unchanged.
 *
 * Behavior on a gated route (path matches /^\/[a-z0-9-]+\/?$/ and is NOT
 * a known-public route like /login, /index.html, etc.):
 *
 *   1. SYNCHRONOUSLY install a fetch() override. This rewrites:
 *        /api/manifest          → synthetic one-file manifest for this slug
 *        /api/data/<slug>.json  → /.netlify/functions/get-roadmap?slug=<slug>
 *      All other fetches pass through untouched. Must install sync so the
 *      viewer's DOMContentLoaded fetches go through the rewrite.
 *
 *   2. ASYNCHRONOUSLY ping /.netlify/functions/get-roadmap?slug=__ping__
 *      to check session validity. A 401 means no session → redirect to
 *      /login?redirect=<current-path>. Any other status → user is authed.
 *
 *   3. Store the slug on window.__PPGANTT_SLUG__ for the manifest override.
 *
 * This file is a plain <script> (NOT an ES module). No imports. Safe to
 * ship in the public OSS repo — it only does anything on routes that
 * don't exist in the local dev setup.
 */
(function () {
  'use strict';

  // ─── Is this a gated route? ──────────────────────────────────────────
  //
  // Gated: a single-segment path with only letters/numbers/hyphens,
  // e.g. /societist, /cpu, /rvms. NOT the root, NOT /login, NOT
  // /index.html, NOT anything with a file extension.

  var PUBLIC_PATHS = new Set(['/', '/index.html', '/login', '/login.html']);
  var path = location.pathname;

  function isGatedSlugRoute() {
    if (PUBLIC_PATHS.has(path)) return false;
    // Strip a trailing slash for matching
    var normalized = path.replace(/\/$/, '');
    // Must be a single segment of [a-z0-9-]+ with no file extension
    return /^\/[a-z0-9-]+$/.test(normalized);
  }

  if (!isGatedSlugRoute()) {
    // Public/local mode — do nothing. The viewer loads static files as normal.
    return;
  }

  // ─── Extract the slug from the URL ───────────────────────────────────

  var slug = path.replace(/\/$/, '').slice(1); // "/societist" → "societist"
  window.__PPGANTT_SLUG__ = slug;

  // ─── (1) Install the fetch override SYNCHRONOUSLY ────────────────────

  var _origFetch = window.fetch;

  window.fetch = function (url, opts) {
    var urlStr = typeof url === 'string' ? url : (url && url.url) || '';

    // Rewrite /api/manifest → synthetic one-file manifest for current slug
    if (urlStr === '/api/manifest' || urlStr.endsWith('/api/manifest')) {
      var manifest = {
        version: 1,
        generated_at: new Date().toISOString(),
        files: [{
          filename: slug + '.json',
          table_name: slug.toUpperCase(),
          notion_url: '',
          data_source_id: '',
          synced_at: new Date().toISOString(),
          row_count: null,
          is_fixture: false
        }]
      };
      return Promise.resolve(new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // Rewrite /api/data/<slug>.json → Netlify Function
    var dataMatch = urlStr.match(/\/api\/data\/([a-z0-9-]+)\.json$/i);
    if (dataMatch) {
      var dataSlug = dataMatch[1];
      return _origFetch('/.netlify/functions/get-roadmap?slug=' + dataSlug, {
        credentials: 'include'
      });
    }

    // Everything else — pass through untouched.
    return _origFetch.apply(this, arguments);
  };

  // ─── (2) Async auth ping ─────────────────────────────────────────────
  //
  // Kicks off in parallel with the viewer's own initialization. If the
  // session is invalid, redirect. The fetch override is already live, so
  // the viewer can start rendering while we verify.

  (async function () {
    try {
      var res = await _origFetch('/.netlify/functions/get-roadmap?slug=__ping__', {
        credentials: 'include'
      });
      if (res.status === 401) {
        var redirect = encodeURIComponent(location.pathname + location.search);
        location.href = '/login?redirect=' + redirect;
      }
      // Any other status (400 for bad slug, 404 for not-found, etc.) means
      // the user is authed. Let the viewer continue.
    } catch (_) {
      // Network failure — fail safe, send to login.
      location.href = '/login';
    }
  }());
}());
