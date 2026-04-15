/**
 * viewer.js — PPGantt Single-Chart Renderer
 *
 * Public API:
 *   window.renderGantt(containerEl, tasks, palette, options?)
 *     → renders a Frappe Gantt instance into containerEl
 *     → returns the Gantt instance
 *
 *   window.ppGanttSetViewMode(mode)
 *     → updates the view mode on the current gantt instance
 *     → mode: 'Day' | 'Week' | 'Month' | 'Quarter Day'
 *
 * Dependencies:
 *   - frappe-gantt.min.js (must be loaded first; exposes window.Gantt)
 *
 * Phase A scope: static single-file viewer.
 * Integration hooks for simulator.js, overlay.js, loader.js are
 * stubbed as no-ops here and will be wired in the Wave 2 integration pass.
 */

(function (global) {
  'use strict';

  // ─── Internal state ───────────────────────────────────────────────────────

  /** @type {Gantt|null} Active Frappe Gantt instance */
  let _ganttInstance = null;

  /** @type {Array} Task data (raw from JSON) for post-render passes */
  let _tasks = [];

  /** @type {Object} Phase palette from JSON */
  let _palette = {};

  /** @type {HTMLElement|null} Last render container */
  let _containerEl = null;

  /** @type {Object} Last render options */
  let _renderOptions = {};

  /** @type {string} Current active view mode */
  let _viewMode = 'Day';

  /** @type {boolean} Visual simplification toggle */
  let _compactMonthLayout = false;

  /** @type {Function|null} Cleanup for window-level sticky timeline listeners */
  let _stickyTimelineCleanup = null;

  /** @type {number|null} requestAnimationFrame id for sticky timeline refresh */
  let _stickyTimelineFrame = null;

  // ─── Pixel helpers ────────────────────────────────────────────────────────

  /**
   * Convert a date string (YYYY-MM-DD) to pixel X coordinate within the SVG.
   * Reads from the live Gantt instance's internal scale.
   * @param {string} dateStr
   * @returns {number} px offset from SVG origin
   */
  function _dateToX(dateStr) {
    if (!_ganttInstance) return 0;
    const g = _ganttInstance;
    const date = new Date(dateStr + 'T00:00:00');
    const startMs = g.gantt_start.getTime();
    const diffMs = date.getTime() - startMs;
    const diffHours = diffMs / (1000 * 60 * 60);
    return (diffHours / g.options.step) * g.options.column_width;
  }

  /**
   * Get the pixel width corresponding to N days in the current view.
   * @param {number} days
   * @returns {number} px
   */
  function _daysToPixels(days) {
    if (!_ganttInstance) return 0;
    const g = _ganttInstance;
    // step is hours per column; column_width is px per column
    const hoursPerDay = 24;
    return (days * hoursPerDay / g.options.step) * g.options.column_width;
  }

  /**
   * Format a Date (or ISO string) as "YYYY-MM-DD" using LOCAL time —
   * Frappe Gantt emits local-time Date objects for on_date_change.
   */
  function _dateToIso(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);
    if (!(value instanceof Date) || isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function _taskTimeValue(task, field) {
    const value = task && task[field];
    const time = value ? new Date(value + 'T00:00:00').getTime() : NaN;
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  }

  function _taskSortTuple(task) {
    return [
      _taskTimeValue(task, 'start'),
      _taskTimeValue(task, 'end'),
      (task.meta && task.meta.phase) || '',
      task.name || '',
      task.id || ''
    ];
  }

  function _compareTasks(a, b) {
    const left = _taskSortTuple(a);
    const right = _taskSortTuple(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  }

  function _getDisplayTasks(tasks, mode) {
    if (!_compactMonthLayout || !Array.isArray(tasks)) {
      return tasks;
    }

    const taskById = new Map();
    const dependentsById = new Map();
    const indegreeById = new Map();
    const ordered = [];
    const visited = new Set();

    tasks.forEach(function (task) {
      taskById.set(task.id, task);
      dependentsById.set(task.id, []);
      indegreeById.set(task.id, 0);
    });

    tasks.forEach(function (task) {
      (task.dependencies || []).forEach(function (dependencyId) {
        if (!taskById.has(dependencyId)) return;
        dependentsById.get(dependencyId).push(task);
        indegreeById.set(task.id, (indegreeById.get(task.id) || 0) + 1);
      });
    });

    function visit(task) {
      if (!task || visited.has(task.id)) return;
      visited.add(task.id);
      ordered.push(task);
      (dependentsById.get(task.id) || [])
        .slice()
        .sort(_compareTasks)
        .forEach(visit);
    }

    tasks
      .filter(function (task) { return (indegreeById.get(task.id) || 0) === 0; })
      .sort(_compareTasks)
      .forEach(visit);

    tasks
      .slice()
      .sort(_compareTasks)
      .forEach(visit);

    return ordered;
  }

  // ─── Post-render pass: slack tails ───────────────────────────────────────

  /**
   * After Frappe Gantt renders, inject SVG <line> slack tails for every task
   * with meta.slack_days > 0. The line extends from the bar's right edge for
   * slack_days worth of pixels, dashed, with class "slack-tail".
   *
   * Implementation notes:
   * - Each bar's <g class="bar-wrapper"> is already in the SVG.
   * - We read the bar's x/y/width from the rendered <rect class="bar">.
   * - We append a <line> as a sibling in the same <g> so it inherits CSS.
   */
  function _applySlackTails() {
    if (!_ganttInstance) return;

    const svg = _ganttInstance.$svg;
    if (!svg) return;

    _tasks.forEach(function (task) {
      const slackDays = task.meta && task.meta.slack_days;
      if (!slackDays || slackDays <= 0) return;

      // Find the rendered bar-wrapper for this task
      const wrapper = svg.querySelector('[data-id="' + task.id + '"]');
      if (!wrapper) return;

      const bar = wrapper.querySelector('.bar');
      if (!bar) return;

      // Read bar geometry
      const barX = parseFloat(bar.getAttribute('x')) || 0;
      const barY = parseFloat(bar.getAttribute('y')) || 0;
      const barW = parseFloat(bar.getAttribute('width')) || 0;
      const barH = parseFloat(bar.getAttribute('height')) || 0;

      // Remove any previously injected tail (idempotent)
      const existing = wrapper.querySelector('.slack-tail');
      if (existing) existing.remove();

      // Compute tail length in pixels
      const tailPx = _daysToPixels(slackDays);
      if (tailPx <= 0) return;

      const lineX1 = barX + barW;
      const lineX2 = lineX1 + tailPx;
      const lineY = barY + barH / 2;

      // Create SVG <line> in the same namespace
      const ns = 'http://www.w3.org/2000/svg';
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', lineX1);
      line.setAttribute('y1', lineY);
      line.setAttribute('x2', lineX2);
      line.setAttribute('y2', lineY);
      line.setAttribute('class', 'slack-tail');

      wrapper.appendChild(line);
    });
  }

  // ─── Custom popup HTML ────────────────────────────────────────────────────

  /**
   * Build the custom popup HTML for a task.
   * @param {Object} task - Frappe Gantt task object (has .meta via our data)
   * @returns {string} HTML string
   */
  function _buildPopupHtml(task) {
    const m = task.meta || {};
    const riskClass = m.risk_level
      ? 'risk-' + (m.risk_level || 'none').toLowerCase()
      : 'risk-none';

    const slackText = (m.slack_days != null && m.slack_days >= 0)
      ? m.slack_days + ' day' + (m.slack_days !== 1 ? 's' : '')
      : '—';

    const progressText = (task.progress != null)
      ? task.progress + '%'
      : '0%';

    const criticalText = m.critical_path ? 'Yes' : 'No';

    const notesHtml = m.notes
      ? '<div class="popup-notes">' + _escHtml(m.notes) + '</div>'
      : '';

    const notionLink = m.notion_url
      ? '<div style="padding:4px 14px 10px;"><a href="' + m.notion_url + '" style="color:#3B82F6;font-size:11px;text-decoration:none;" target="_blank">Open in Notion</a></div>'
      : '';

    return (
      '<div class="title">' + _escHtml(task.name) + '</div>' +
      '<div class="popup-meta">' +
        '<span class="meta-label">Phase</span><span class="meta-value">' + _escHtml(m.phase || '—') + '</span>' +
        '<span class="meta-label">Owner</span><span class="meta-value">' + _escHtml(m.owner || '—') + '</span>' +
        '<span class="meta-label">Status</span><span class="meta-value">' + _escHtml(m.status || '—') + '</span>' +
        '<span class="meta-label">Progress</span><span class="meta-value">' + progressText + '</span>' +
        '<span class="meta-label">Risk</span><span class="meta-value ' + riskClass + '">' + _escHtml(m.risk_level || 'None') + '</span>' +
        '<span class="meta-label">Critical path</span><span class="meta-value">' + criticalText + '</span>' +
        '<span class="meta-label">Slack</span><span class="meta-value">' + slackText + '</span>' +
      '</div>' +
      notesHtml +
      notionLink
    );
  }

  /** HTML-escape helper */
  function _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Phase palette application ────────────────────────────────────────────

  /**
   * Apply the phase_palette from JSON as CSS custom properties on the root.
   * These can be referenced by the CSS or used by other modules.
   * The palette keys (e.g. "Phase 0.5 - Security") are normalized to slugs
   * matching the custom_class tokens (e.g. "phase-0-5-security").
   *
   * @param {Object} palette - { "Phase Name": "#hexcolor" }
   */
  function _applyPalette(palette) {
    if (!palette || typeof palette !== 'object') return;

    const root = document.documentElement;
    Object.keys(palette).forEach(function (phaseName) {
      const hex = palette[phaseName];
      const slug = _phaseNameToSlug(phaseName);
      root.style.setProperty('--phase-color-' + slug, hex);
    });
  }

  /**
   * Convert a phase name like "Phase 2A - Storefront" to
   * a CSS slug like "phase-2a-storefront".
   * @param {string} name
   * @returns {string}
   */
  function _phaseNameToSlug(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ─── Stream stripe (left-edge accent) ────────────────────────────────────

  const STREAM_COLOR = {
    'stream b (peter)':    '#3B82F6',
    'stream a (lourenço)': '#A855F7',
    'stream a (lourenco)': '#A855F7',
    'shared':              '#9CA3AF',
    'app store':           '#EAB308',
    'white-label':         '#EC4899'
  };

  function _streamColor(stream) {
    if (!stream) return null;
    return STREAM_COLOR[String(stream).toLowerCase()] || null;
  }

  function _applyStreamStripes() {
    if (!_ganttInstance) return;
    const svg = _ganttInstance.$svg;
    if (!svg) return;

    _tasks.forEach(function (task) {
      const stream = task.meta && task.meta.stream;
      const color = _streamColor(stream);
      if (!color) return;

      const wrapper = svg.querySelector('[data-id="' + task.id + '"]');
      if (!wrapper) return;
      const bar = wrapper.querySelector('.bar');
      if (!bar) return;

      const existing = wrapper.querySelector('.stream-stripe');
      if (existing) existing.remove();

      const barX = parseFloat(bar.getAttribute('x')) || 0;
      const barY = parseFloat(bar.getAttribute('y')) || 0;
      const barH = parseFloat(bar.getAttribute('height')) || 0;

      const ns = 'http://www.w3.org/2000/svg';
      const stripe = document.createElementNS(ns, 'rect');
      stripe.setAttribute('class', 'stream-stripe');
      stripe.setAttribute('x', barX);
      stripe.setAttribute('y', barY);
      stripe.setAttribute('width', 5);
      stripe.setAttribute('height', barH);
      stripe.setAttribute('rx', 2);
      stripe.setAttribute('fill', color);
      stripe.setAttribute('pointer-events', 'none');

      // Append as last child of .bar-wrapper so it paints on top of the bar
      // (the label lives inside a nested .bar-group and is not a direct child
      // of .bar-wrapper, so insertBefore would throw during resize re-renders).
      wrapper.appendChild(stripe);
    });
  }

  // ─── Milestone post-processing ────────────────────────────────────────────

  /**
   * Milestone tasks already get the `milestone` class via custom_class.
   * CSS handles the diamond rotation. This function does an additional
   * data attribute annotation for future integration hooks.
   */
  function _annotateMilestones() {
    if (!_ganttInstance) return;
    const svg = _ganttInstance.$svg;
    if (!svg) return;

    _tasks.forEach(function (task) {
      if (!task.meta || !task.meta.is_milestone) return;
      const wrapper = svg.querySelector('[data-id="' + task.id + '"]');
      if (wrapper) {
        wrapper.setAttribute('data-milestone', 'true');
      }
    });
  }

  function _parseColorToRgb(colorValue) {
    if (!colorValue) return null;
    const color = String(colorValue).trim();

    if (color.charAt(0) === '#') {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex.split('').map(function (char) { return char + char; }).join('');
      }
      if (hex.length !== 6) return null;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }

    const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/i);
    if (!rgbMatch) return null;
    const parts = rgbMatch[1].split(',').map(function (part) { return parseFloat(part.trim()); });
    if (parts.length < 3 || parts.some(function (part) { return Number.isNaN(part); })) return null;

    return { r: parts[0], g: parts[1], b: parts[2] };
  }

  function _relativeLuminance(rgb) {
    function channel(value) {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }

    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function _labelShouldUseDarkText(wrapper, label, bar) {
    if (!wrapper || !label || !bar) return false;
    if (label.classList.contains('big')) return false;

    const barFill = bar.getAttribute('fill') || window.getComputedStyle(bar).fill;
    const rgb = _parseColorToRgb(barFill);
    if (!rgb) return false;

    return _relativeLuminance(rgb) > 0.42;
  }

  function _applyLabelContrast() {
    if (!_ganttInstance) return;
    const svg = _ganttInstance.$svg;
    if (!svg) return;

    svg.querySelectorAll('.bar-wrapper').forEach(function (wrapper) {
      const label = wrapper.querySelector('.bar-label');
      const bar = wrapper.querySelector('.bar');
      if (!label || !bar) return;

      const useDarkText = _labelShouldUseDarkText(wrapper, label, bar);
      const fill = useDarkText ? '#020617' : '#ffffff';
      label.setAttribute('fill', fill);
      label.style.fill = fill;
      label.setAttribute('stroke', 'none');
      label.style.stroke = 'none';
    });

    svg.querySelectorAll('.bar-label.big').forEach(function (label) {
      label.setAttribute('fill', '#ffffff');
      label.style.fill = '#ffffff';
      label.setAttribute('opacity', '1');
      label.style.opacity = '1';
      label.setAttribute('stroke', 'none');
      label.style.stroke = 'none';
    });
  }

  function _promoteBarLabels() {
    if (!_ganttInstance) return;
    const svg = _ganttInstance.$svg;
    if (!svg) return;

    svg.querySelectorAll('.bar-group').forEach(function (group) {
      const label = group.querySelector('.bar-label');
      if (!label) return;
      group.appendChild(label);
    });
  }

  function _clearStickyTimelineBinding() {
    if (_stickyTimelineFrame != null) {
      cancelAnimationFrame(_stickyTimelineFrame);
      _stickyTimelineFrame = null;
    }
    if (_stickyTimelineCleanup) {
      _stickyTimelineCleanup();
      _stickyTimelineCleanup = null;
    }
  }

  function _applyStickyTimelinePosition() {
    if (!_ganttInstance || !_containerEl) return;
    if (_containerEl.classList.contains('overlay-layer')) return;

    const svg = _ganttInstance.$svg;
    if (!svg) return;

    const dateLayer = svg.querySelector('.date');
    const headerRect = svg.querySelector('.grid-header');
    if (!dateLayer || !headerRect) return;

    const containerRect = _containerEl.getBoundingClientRect();
    const headerHeight = (_ganttInstance.options && _ganttInstance.options.header_height) || 50;
    const svgHeight = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 0;
    const maxOffset = Math.max(0, svgHeight - headerHeight - 24);
    const offset = Math.min(maxOffset, Math.max(0, -containerRect.top));
    const transform = offset > 0 ? 'translate(0,' + offset + ')' : '';

    headerRect.setAttribute('transform', transform);
    dateLayer.setAttribute('transform', transform);
  }

  // ─── Popup control: suppress during handle-drag, dismiss on click-away ───

  /** @type {Function|null} Cleanup for popup-related document/SVG listeners */
  let _popupControlCleanup = null;

  function _bindPopupControl() {
    if (_popupControlCleanup) {
      _popupControlCleanup();
      _popupControlCleanup = null;
    }
    if (!_ganttInstance || !_ganttInstance.$svg) return;

    const svg = _ganttInstance.$svg;

    // When the user begins a resize drag, Frappe's bar-wrapper receives focus
    // (because the wrapper is focusable) which triggers `show_popup` BEFORE
    // `bar_being_dragged` is set. We pre-set the flag on handle mousedown so
    // show_popup early-returns. Native mouseup clears it back to null.
    //
    // Also intercept SHIFT+click on a bar-wrapper as the trigger for the
    // Related-Tasks focus mode. We dispatch a ppgantt:related-focus CustomEvent
    // from the SVG so index.html can hand-off without the viewer knowing any
    // app state. stopPropagation in the capture phase prevents Frappe's
    // bubble-phase bar handler from firing the popup or the push dialog.
    const onBarMouseDown = function (ev) {
      const handle = ev.target && ev.target.closest && ev.target.closest('.handle');
      if (handle && _ganttInstance) {
        _ganttInstance.bar_being_dragged = '__resize__';
        if (typeof _ganttInstance.hide_popup === 'function') {
          _ganttInstance.hide_popup();
        }
        return;
      }

      const barWrapper = ev.target && ev.target.closest && ev.target.closest('.bar-wrapper');
      if (barWrapper && ev.shiftKey) {
        const taskId = barWrapper.getAttribute('data-id');
        if (!taskId) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (_ganttInstance && typeof _ganttInstance.hide_popup === 'function') {
          _ganttInstance.hide_popup();
        }
        svg.dispatchEvent(new CustomEvent('ppgantt:related-focus', {
          bubbles: false,
          detail: { taskId: taskId }
        }));
      }
    };
    svg.addEventListener('mousedown', onBarMouseDown, true);

    // Click-away dismiss: clicking anywhere that is not a bar and not the
    // popup itself should hide the popup. Frappe only dismisses on .grid-row
    // and .grid-header clicks.
    const onDocumentMouseDown = function (ev) {
      if (!_ganttInstance || typeof _ganttInstance.hide_popup !== 'function') return;
      const target = ev.target;
      if (!target || !(target instanceof Element)) return;
      if (target.closest('.popup-wrapper')) return;
      if (target.closest('.bar-wrapper')) return;
      _ganttInstance.hide_popup();
    };
    document.addEventListener('mousedown', onDocumentMouseDown, true);

    _popupControlCleanup = function () {
      svg.removeEventListener('mousedown', onBarMouseDown, true);
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
    };
  }

  function _bindStickyTimelineHeader() {
    _clearStickyTimelineBinding();

    if (!_ganttInstance || !_containerEl || _containerEl.classList.contains('overlay-layer')) {
      return;
    }

    const update = function () {
      if (_stickyTimelineFrame != null) return;
      _stickyTimelineFrame = requestAnimationFrame(function () {
        _stickyTimelineFrame = null;
        _applyStickyTimelinePosition();
      });
    };

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);

    _stickyTimelineCleanup = function () {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);

      if (_ganttInstance && _ganttInstance.$svg) {
        const svg = _ganttInstance.$svg;
        const dateLayer = svg.querySelector('.date');
        const headerRect = svg.querySelector('.grid-header');
        if (headerRect) headerRect.removeAttribute('transform');
        if (dateLayer) dateLayer.removeAttribute('transform');
      }
    };

    update();
  }

  // ─── Main render function ─────────────────────────────────────────────────

  /**
   * Render a Frappe Gantt chart.
   *
   * @param {HTMLElement} containerEl - DOM element to render into
   * @param {Array} tasks - Task array from JSON contract (plan §6)
   * @param {Object} palette - phase_palette from JSON
   * @param {Object} [options] - Optional overrides for Frappe Gantt options
   * @returns {Gantt} The Frappe Gantt instance
   */
  function renderGantt(containerEl, tasks, palette, options) {
    if (!containerEl) {
      throw new Error('renderGantt: containerEl is required');
    }
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('renderGantt: tasks must be an array');
    }

    // Store for post-render passes and future re-renders
    _containerEl = containerEl;
    _tasks = tasks;
    _palette = palette || {};
    _renderOptions = Object.assign({}, options || {});
    _viewMode = _renderOptions.view_mode || _viewMode || 'Week';

    // Apply palette as CSS custom properties
    _applyPalette(_palette);

    const displayTasks = _getDisplayTasks(tasks, _viewMode);

    // Build Frappe Gantt options
    var ganttOptions = Object.assign(
      {
        view_mode: _viewMode,
        header_height: 44,
        bar_height: 30,
        padding: 18,
        date_format: 'YYYY-MM-DD',
        popup_trigger: 'click',
        custom_popup_html: _buildPopupHtml,
        // on_click fires when user double-clicks a bar
        // Phase D (simulator.js) will hook into this. Stub here.
        on_click: function (task) {
          // STUB: simulator.js will replace this handler in the integration pass
          // For now, no-op. Popup is handled by Frappe Gantt's own popup_trigger.
        },
        on_date_change: function (task, start, end) {
          // Frappe passes (task, start, end-1second). The -1s ensures that
          // converting to a local calendar date via _dateToIso produces the
          // same ISO string the JSON contract uses (inclusive end date).
          const isoStart = _dateToIso(start);
          const isoEnd = _dateToIso(end);
          if (!isoStart || !isoEnd) return;
          if (typeof _renderOptions.on_drag === 'function') {
            _renderOptions.on_drag(task, isoStart, isoEnd);
          }
        },
        on_view_change: function (mode) {
          _viewMode = mode;
          // Re-apply slack tails + stream stripes when view mode changes (pixel scale changes)
          _applySlackTails();
          _applyStreamStripes();
          _applyStickyTimelinePosition();
          // Update active zoom button in the UI
          _syncZoomButtons(mode);
          _syncMonthLayoutButton();
        }
      },
      _renderOptions
    );

    // Destroy previous instance if any (for re-renders)
    if (_ganttInstance) {
      _clearStickyTimelineBinding();
      try {
        containerEl.innerHTML = '';
      } catch (e) {}
    }

    // Instantiate Frappe Gantt
    // Frappe Gantt v0.6.1 constructor: new Gantt(element, tasks, options)
    // element can be a CSS selector string or HTMLElement
    _ganttInstance = new Gantt(containerEl, displayTasks, ganttOptions);

    // Post-render passes (run after a short microtask to let Frappe settle)
    _runPostRender();
    _syncZoomButtons(_viewMode);
    _syncMonthLayoutButton();

    return _ganttInstance;
  }

  /**
   * Run all post-render visual enhancement passes.
   * Uses requestAnimationFrame to wait for Frappe Gantt to finish painting.
   */
  function _runPostRender() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _applySlackTails();
        _annotateMilestones();
        _applyStreamStripes();
        _promoteBarLabels();
        _applyLabelContrast();
        _bindStickyTimelineHeader();
        _bindPopupControl();
      });
    });
  }

  // ─── View mode control ────────────────────────────────────────────────────

  /**
   * Change the zoom/view mode on the active Gantt instance.
   * @param {string} mode - 'Day' | 'Week' | 'Month' | 'Quarter Day' | 'Year'
   */
  function setViewMode(mode) {
    if (!_ganttInstance) return;
    const previousMode = _viewMode;
    _viewMode = mode;
    if (_compactMonthLayout && previousMode !== mode) {
      _rerender();
      return;
    }
    _ganttInstance.change_view_mode(mode);
    // Slack tails are re-drawn via on_view_change callback above
  }

  /**
   * Sync the zoom button active state to the current mode.
   * @param {string} mode
   */
  function _syncZoomButtons(mode) {
    document.querySelectorAll('.zoom-btn').forEach(function (btn) {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function _syncMonthLayoutButton() {
    const button = document.getElementById('month-layout-btn');
    if (!button) return;
    button.disabled = false;
    button.classList.toggle('active', _compactMonthLayout);
    button.setAttribute(
      'title',
      'Reorder rows visually to keep related work and dependency chains closer together'
    );
  }

  function _rerender() {
    if (!_containerEl) return;
    renderGantt(_containerEl, _tasks, _palette, Object.assign({}, _renderOptions, {
      view_mode: _viewMode
    }));
  }

  function setMonthLayoutCompact(enabled) {
    _compactMonthLayout = !!enabled;
    _syncMonthLayoutButton();
    if (_ganttInstance) {
      _rerender();
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  global.renderGantt = renderGantt;
  global.ppGanttSetViewMode = setViewMode;
  global.ppGanttSetMonthLayoutCompact = setMonthLayoutCompact;

  // Expose internal for integration pass (Wave 2)
  global._ppGanttInternal = {
    getInstance: function () { return _ganttInstance; },
    getTasks: function () { return _tasks; },
    getPalette: function () { return _palette; },
    getViewMode: function () { return _viewMode; },
    isMonthLayoutCompact: function () { return _compactMonthLayout; },
    reapplySlackTails: _applySlackTails,
    reapplyStreamStripes: _applyStreamStripes
  };

}(window));
