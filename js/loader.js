/**
 * loader.js — PPGantt Multi-File Loader
 *
 * Public API (window.PPGanttLoader):
 *   loadManifest()            → Promise<manifest>
 *   loadFile(filename)        → Promise<json>
 *   loadFiles(filenames)      → Promise<Array<{filename, json, error?}>>
 *
 * Works in both http:// and file:// contexts.
 * Uses the same two-path fetch+XHR strategy as index.html (Safari file:// quirk).
 *
 * Dependencies: none (plain JS, no imports)
 * Phase C scope: Sonnet-C owns this file.
 */

(function (global) {
  'use strict';

  var DATA_DIR = 'data/';
  var MANIFEST_FILE = '_manifest.json';
  var API_MANIFEST = '/api/manifest';
  var API_DATA = '/api/data/';

  /**
   * Low-level file fetcher.
   * Path 1: fetch() for http/https.
   * Path 2: XHR for file:// (Safari-compatible).
   * Returns a Promise<Object> (parsed JSON).
   *
   * @param {string} url - The URL to fetch (relative or absolute)
   * @returns {Promise<Object>}
   */
  function _fetchJson(url) {
    var isFileProtocol = window.location.protocol === 'file:';

    if (!isFileProtocol) {
      // Path 1: standard fetch
      return fetch(url).then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' fetching ' + url);
        }
        return response.json();
      });
    }

    // Path 2: XHR for file://
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'json';

      xhr.onload = function () {
        var json = xhr.response;
        if (!json) {
          reject(new Error('Empty or non-JSON response for: ' + url));
          return;
        }
        resolve(json);
      };

      xhr.onerror = function () {
        reject(new Error('XHR failed for: ' + url + ' (file:// restriction?)'));
      };

      xhr.send();
    });
  }

  function _validate(manifest, sourceUrl) {
    if (!manifest || !Array.isArray(manifest.files)) {
      throw new Error('Invalid manifest: missing "files" array at ' + sourceUrl);
    }
    return manifest;
  }

  /**
   * Fetch and parse the data manifest.
   * Try /api/manifest first (when Express server is running with DATA_DIR).
   * Fall back to data/_manifest.json (direct static serving or file:// open).
   * @returns {Promise<Object>} The manifest object
   */
  function loadManifest() {
    var isFileProtocol = window.location.protocol === 'file:';
    if (isFileProtocol) {
      return _fetchJson(DATA_DIR + MANIFEST_FILE).then(function (m) {
        return _validate(m, DATA_DIR + MANIFEST_FILE);
      });
    }
    return _fetchJson(API_MANIFEST).then(
      function (m) { return _validate(m, API_MANIFEST); },
      function () {
        return _fetchJson(DATA_DIR + MANIFEST_FILE).then(function (m) {
          return _validate(m, DATA_DIR + MANIFEST_FILE);
        });
      }
    );
  }

  /**
   * Fetch and parse a specific data file by filename.
   * Try /api/data/<file> first, fall back to data/<file>.
   *
   * @param {string} filename - Just the filename, not the full path
   * @returns {Promise<Object>} The parsed JSON
   */
  function loadFile(filename) {
    if (!filename) {
      return Promise.reject(new Error('loadFile: filename is required'));
    }
    var isFileProtocol = window.location.protocol === 'file:';
    if (isFileProtocol) {
      return _fetchJson(DATA_DIR + filename);
    }
    // On gated slug routes (Supabase-backed), we MUST NOT fall back to the
    // static data/ directory — doing so quietly returns the Notion-era
    // snapshot (roadmap.json) and masks auth/authz errors.  The gate sets
    // window.__PPGANTT_SLUG__ on gated routes; its presence is the signal
    // to stay on the API path and let errors surface.
    var isGated = typeof window !== 'undefined' && !!window.__PPGANTT_SLUG__;
    if (isGated) {
      return _fetchJson(API_DATA + filename);
    }
    return _fetchJson(API_DATA + filename).catch(function () {
      return _fetchJson(DATA_DIR + filename);
    });
  }

  /**
   * Fetch multiple files in parallel.
   * Each result is { filename, json } on success or { filename, error } on failure.
   * Never rejects — individual file failures are captured in the result array.
   *
   * @param {string[]} filenames
   * @returns {Promise<Array<{filename: string, json?: Object, error?: Error}>>}
   */
  function loadFiles(filenames) {
    if (!filenames || filenames.length === 0) {
      return Promise.resolve([]);
    }

    var promises = filenames.map(function (filename) {
      return loadFile(filename).then(
        function (json) {
          return { filename: filename, json: json };
        },
        function (err) {
          console.warn('[PPGanttLoader] Failed to load "' + filename + '":', err);
          return { filename: filename, error: err };
        }
      );
    });

    return Promise.all(promises);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  global.PPGanttLoader = {
    loadManifest: loadManifest,
    loadFile: loadFile,
    loadFiles: loadFiles
  };

}(window));
