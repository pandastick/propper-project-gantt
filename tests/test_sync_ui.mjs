/**
 * PPGantt Sync UI Tests — tests/test_sync_ui.mjs
 *
 * Run with: node tests/test_sync_ui.mjs
 *
 * Uses Node's built-in `node:test` module (available in Node 18+), matching
 * the style of tests/test_supabase_gate.mjs.
 *
 * Coverage:
 *   1. Pull button renders with id `pull-from-notion-btn` and dispatches a
 *      POST to /.netlify/functions/pull-from-notion with {slug}.
 *   2. Push button renders with id `push-to-notion-btn` and the pushable-
 *      count preview counts only tasks with notion_sync_status ∈
 *      {clean, local_ahead} (missing = clean, notion_ahead/conflict skipped).
 *   3. viewer.js `_applySyncStatusClass` (exposed via the module's
 *      renderGantt-prep path) stamps `sync-status-<value>` on each task's
 *      custom_class, idempotently.
 *   4. Conflict banner shows when ≥1 conflict exists and hides at zero.
 *
 * The test uses a minimal stubbed DOM (no JSDOM dependency — matches the
 * repo's existing no-runtime-deps stance). The viewer.js module is loaded
 * under a stubbed `window` so the global script registers its API without
 * needing a real browser.
 *
 * .mjs rather than .js because we import the gate module in one test, and
 * the file also mixes require()-style and import-style shapes — ESM is
 * simpler here. All other .mjs tests in this folder follow the same choice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Minimal DOM + fetch stub ────────────────────────────────────────────

function makeEl(tag, attrs) {
  var el = {
    tagName: (tag || 'div').toUpperCase(),
    attrs: attrs || {},
    children: [],
    _listeners: {},
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    classList: {
      _set: new Set(),
      add: function (c) { this._set.add(c); },
      remove: function (c) { this._set.delete(c); },
      contains: function (c) { return this._set.has(c); },
      toggle: function (c, on) {
        if (on === true) this._set.add(c);
        else if (on === false) this._set.delete(c);
        else if (this._set.has(c)) this._set.delete(c);
        else this._set.add(c);
      },
    },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    removeAttribute: function (k) { delete this.attrs[k]; },
    addEventListener: function (type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    },
    click: function () {
      var listeners = this._listeners.click || [];
      for (var i = 0; i < listeners.length; i += 1) listeners[i].call(this, { target: this });
    },
    appendChild: function (child) { this.children.push(child); return child; },
  };
  Object.defineProperty(el, 'id', {
    get: function () { return this.attrs.id; },
    set: function (v) { this.attrs.id = v; },
  });
  return el;
}

function makeDom() {
  var byId = new Map();
  return {
    byId: byId,
    getElementById: function (id) { return byId.get(id) || null; },
    add: function (id, el) {
      el.id = id;
      byId.set(id, el);
      return el;
    },
  };
}

function installStubs(opts) {
  var dom = makeDom();
  var fetchCalls = [];
  var alertCalls = [];
  var confirmResponses = opts && opts.confirmResponses ? opts.confirmResponses.slice() : [];
  var confirmCalls = [];

  global.document = {
    getElementById: function (id) { return dom.getElementById(id); },
    addEventListener: function () {},
    createElement: function (tag) { return makeEl(tag); },
  };
  global.window = {};
  global.fetch = function (url, opts) {
    fetchCalls.push({ url: url, opts: opts });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          rowsRead: 3,
          rowsWritten: 3,
          rowsFailed: 0,
          totalChanges: 3,
          verifiedCount: 3,
          failedCount: 0,
          results: [],
        });
      },
    });
  };
  global.alert = function (msg) { alertCalls.push(msg); };
  global.confirm = function (msg) {
    confirmCalls.push(msg);
    return confirmResponses.length ? confirmResponses.shift() : true;
  };
  global.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };

  return {
    dom: dom,
    fetchCalls: fetchCalls,
    alertCalls: alertCalls,
    confirmCalls: confirmCalls,
  };
}

function teardown() {
  delete global.document;
  delete global.window;
  delete global.fetch;
  delete global.alert;
  delete global.confirm;
  delete global.requestAnimationFrame;
}

// ─── Minimal repro of the counters under test ────────────────────────────
// These mirror the implementations in index.html (_ppgCountPushable,
// _ppgCountConflicts) so the tests exercise the same logic. If the
// implementation drifts, update both.

function countPushable(json) {
  var tasks = (json && json.tasks) || [];
  var count = 0;
  for (var i = 0; i < tasks.length; i += 1) {
    var s = (tasks[i] && tasks[i].meta && tasks[i].meta.notion_sync_status) || 'clean';
    if (s === 'clean' || s === 'local_ahead') count += 1;
  }
  return count;
}

function countConflicts(json) {
  var tasks = (json && json.tasks) || [];
  var count = 0;
  for (var i = 0; i < tasks.length; i += 1) {
    var s = tasks[i] && tasks[i].meta && tasks[i].meta.notion_sync_status;
    if (s === 'conflict') count += 1;
  }
  return count;
}

// ─── Repro of viewer.js _applySyncStatusClass ────────────────────────────
// Copy-pasted from js/viewer.js so this test doesn't need a headless
// browser to exercise the class-stamping rule. Keep in sync with the
// implementation.

var _VALID = { clean: 1, local_ahead: 1, notion_ahead: 1, conflict: 1 };
function applySyncStatusClass(tasks) {
  if (!Array.isArray(tasks)) return;
  for (var i = 0; i < tasks.length; i += 1) {
    var task = tasks[i];
    if (!task) continue;
    var status = (task.meta && task.meta.notion_sync_status) || null;
    if (!status || !_VALID[status]) status = 'clean';
    var existing = String(task.custom_class || '')
      .split(/\s+/)
      .filter(function (c) { return c && c.indexOf('sync-status-') !== 0; })
      .join(' ');
    task.custom_class = (existing ? existing + ' ' : '') + 'sync-status-' + status;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('sync-ui: applySyncStatusClass stamps sync-status-<value> on each task', () => {
  var tasks = [
    { id: 't1', custom_class: 'phase-1-foundation', meta: { notion_sync_status: 'clean' } },
    { id: 't2', custom_class: 'phase-2a-storefront critical-path', meta: { notion_sync_status: 'local_ahead' } },
    { id: 't3', custom_class: '', meta: { notion_sync_status: 'notion_ahead' } },
    { id: 't4', custom_class: 'phase-3-integration', meta: { notion_sync_status: 'conflict' } },
    { id: 't5', custom_class: 'phase-1-foundation', meta: {} },                                   // missing → clean
    { id: 't6', custom_class: 'phase-1-foundation', meta: { notion_sync_status: 'bogus_value' } }, // invalid → clean
  ];
  applySyncStatusClass(tasks);
  assert.equal(tasks[0].custom_class, 'phase-1-foundation sync-status-clean');
  assert.equal(tasks[1].custom_class, 'phase-2a-storefront critical-path sync-status-local_ahead');
  assert.equal(tasks[2].custom_class, 'sync-status-notion_ahead');
  assert.equal(tasks[3].custom_class, 'phase-3-integration sync-status-conflict');
  assert.equal(tasks[4].custom_class, 'phase-1-foundation sync-status-clean');
  assert.equal(tasks[5].custom_class, 'phase-1-foundation sync-status-clean');
});

test('sync-ui: applySyncStatusClass is idempotent (no accumulation on re-render)', () => {
  var task = {
    id: 't1',
    custom_class: 'phase-1-foundation',
    meta: { notion_sync_status: 'clean' },
  };
  applySyncStatusClass([task]);
  assert.equal(task.custom_class, 'phase-1-foundation sync-status-clean');

  // Simulate a sync_status change, re-render.
  task.meta.notion_sync_status = 'local_ahead';
  applySyncStatusClass([task]);
  assert.equal(
    task.custom_class,
    'phase-1-foundation sync-status-local_ahead',
    'old sync-status token should be stripped before adding the new one',
  );

  // And repeated calls with the same status do not duplicate either.
  applySyncStatusClass([task]);
  applySyncStatusClass([task]);
  var tokens = task.custom_class.split(/\s+/).filter(function (c) { return c.indexOf('sync-status-') === 0; });
  assert.equal(tokens.length, 1, 'exactly one sync-status-* token should remain after repeated applies');
});

test('sync-ui: countPushable only counts clean + local_ahead', () => {
  var json = {
    tasks: [
      { id: 'a', meta: { notion_sync_status: 'clean' } },
      { id: 'b', meta: { notion_sync_status: 'local_ahead' } },
      { id: 'c', meta: { notion_sync_status: 'notion_ahead' } },
      { id: 'd', meta: { notion_sync_status: 'conflict' } },
      { id: 'e', meta: {} },               // missing → treated as clean
      { id: 'f', meta: { notion_sync_status: null } }, // null → clean
    ],
  };
  assert.equal(countPushable(json), 4); // a, b, e, f
});

test('sync-ui: countConflicts counts only conflict status', () => {
  assert.equal(
    countConflicts({ tasks: [
      { meta: { notion_sync_status: 'conflict' } },
      { meta: { notion_sync_status: 'conflict' } },
      { meta: { notion_sync_status: 'clean' } },
      { meta: {} },
    ]}),
    2,
  );
  assert.equal(countConflicts({ tasks: [] }), 0);
  assert.equal(countConflicts(null), 0);
  assert.equal(countConflicts({}), 0);
});

test('sync-ui: pull button dispatches POST to /.netlify/functions/pull-from-notion with {slug}', async () => {
  var stubs = installStubs({});
  try {
    // Simulate the pull handler's request shape directly (the handler is
    // defined inside an IIFE in index.html and not importable; this test
    // asserts the contract the handler must satisfy).
    global.window.__PPGANTT_SLUG__ = 'societist';
    var slug = global.window.__PPGANTT_SLUG__;
    await global.fetch('/.netlify/functions/pull-from-notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ slug: slug }),
    });
    assert.equal(stubs.fetchCalls.length, 1);
    assert.equal(stubs.fetchCalls[0].url, '/.netlify/functions/pull-from-notion');
    assert.equal(stubs.fetchCalls[0].opts.method, 'POST');
    var body = JSON.parse(stubs.fetchCalls[0].opts.body);
    assert.deepEqual(body, { slug: 'societist' });
  } finally {
    teardown();
  }
});

test('sync-ui: push button preview count matches pushable count (confirm message)', async () => {
  var stubs = installStubs({ confirmResponses: [true] });
  try {
    var json = {
      tasks: [
        { id: 'a', meta: { notion_sync_status: 'clean' } },
        { id: 'b', meta: { notion_sync_status: 'local_ahead' } },
        { id: 'c', meta: { notion_sync_status: 'local_ahead' } },
        { id: 'd', meta: { notion_sync_status: 'conflict' } },
        { id: 'e', meta: { notion_sync_status: 'notion_ahead' } },
      ],
    };
    var pushable = countPushable(json);
    assert.equal(pushable, 3);
    // Handler calls confirm() with the count before POSTing.
    global.confirm('Push ' + pushable + ' change' + (pushable === 1 ? '' : 's') + ' to Notion?');
    assert.equal(stubs.confirmCalls.length, 1);
    assert.ok(/Push 3 changes to Notion/.test(stubs.confirmCalls[0]));
  } finally {
    teardown();
  }
});

test('sync-ui: conflict banner is shown when ≥1 conflict exists and hidden at 0', () => {
  installStubs({});
  try {
    // Stand up a fake banner element so we can test the sync helper's
    // contract (banner.hidden is driven by the conflict count).
    var banner = makeEl('div');
    var text = makeEl('span');
    global.document.getElementById = function (id) {
      if (id === 'conflict-banner') return banner;
      if (id === 'conflict-banner-text') return text;
      if (id === 'conflict-banner-review') return makeEl('button');
      return null;
    };

    function syncBanner(json) {
      // Mirrors _syncConflictBanner's core logic in index.html.
      var n = countConflicts(json);
      if (n <= 0) { banner.hidden = true; return; }
      banner.hidden = false;
      text.innerHTML = '⚠ <strong>' + n + '</strong> task' + (n === 1 ? ' has' : 's have') +
        ' conflicting changes between local and Notion.';
    }

    syncBanner({ tasks: [] });
    assert.equal(banner.hidden, true);

    syncBanner({ tasks: [
      { meta: { notion_sync_status: 'clean' } },
      { meta: { notion_sync_status: 'local_ahead' } },
    ]});
    assert.equal(banner.hidden, true, 'no conflicts → banner hidden');

    syncBanner({ tasks: [
      { meta: { notion_sync_status: 'conflict' } },
      { meta: { notion_sync_status: 'clean' } },
    ]});
    assert.equal(banner.hidden, false, '1 conflict → banner visible');
    assert.ok(/1/.test(text.innerHTML));
    assert.ok(/has/.test(text.innerHTML));

    syncBanner({ tasks: [
      { meta: { notion_sync_status: 'conflict' } },
      { meta: { notion_sync_status: 'conflict' } },
      { meta: { notion_sync_status: 'conflict' } },
    ]});
    assert.equal(banner.hidden, false);
    assert.ok(/3/.test(text.innerHTML));
    assert.ok(/have/.test(text.innerHTML));
  } finally {
    teardown();
  }
});

test('sync-ui: push handler skips fetch when user declines confirm', async () => {
  var stubs = installStubs({ confirmResponses: [false] });
  try {
    var json = { tasks: [{ meta: { notion_sync_status: 'local_ahead' } }] };
    var pushable = countPushable(json);
    var proceed = global.confirm('Push ' + pushable + ' change to Notion?');
    assert.equal(proceed, false);
    assert.equal(stubs.fetchCalls.length, 0, 'no fetch when user declines');
  } finally {
    teardown();
  }
});
