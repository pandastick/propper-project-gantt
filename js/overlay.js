/**
 * overlay.js — PPGantt Multi-Layer Overlay Renderer
 *
 * Public API (window.PPGanttOverlay):
 *   render(containerEl, layers)       → renders stacked Gantt layers, returns layer descriptors
 *   setOpacity(filename, opacity)     → change a specific layer's opacity
 *   removeLayer(filename)             → remove a specific layer
 *   clear()                           → tear down all layers (switch back to single-file mode)
 *   rewireScrollSync()                → re-attach scroll sync after layer changes (no-op here;
 *                                       scroll is natural because all layers share the parent)
 *
 * Layer stacking strategy: §3.6 Option A (stacked DOM layers with CSS opacity).
 *
 * Date alignment strategy: §10 R4 Option A — inject synthetic "anchor" tasks
 * into each layer's task list so all instances span the same date range.
 * Anchor tasks are hidden via the CSS class "overlay-anchor-task".
 *
 * Scroll sync: Because all .overlay-layer divs are absolute children of the
 * same scrollable containerEl, they scroll naturally together — the parent
 * scroll drives them all. No JS scroll-sync event wiring is needed for the
 * horizontal axis. This is the cleanest possible solution and sidesteps R4.
 *
 * Hue shift: Layer 1 = 0deg, Layer 2 = 60deg, Layer 3 = 120deg, etc.
 * Applied only to node-level SVG elements so text and chart chrome remain legible.
 *
 * Dependencies:
 *   - viewer.js (window.renderGantt must be loaded first)
 *   - frappe-gantt.min.js (must be loaded first)
 *
 * Phase C scope: Sonnet-C owns this file.
 */

(function (global) {
  'use strict';

  // ─── Internal state ───────────────────────────────────────────────────────

  /** @type {Array<{filename, ganttInstance, containerEl, layerDiv}>} */
  var _activeLayers = [];

  /** @type {HTMLElement|null} The parent container that holds all layer divs */
  var _containerEl = null;

  // ─── Date range helpers ───────────────────────────────────────────────────

  /**
   * Parse "YYYY-MM-DD" into a UTC Date object (avoids local-timezone offset).
   * @param {string} dateStr
   * @returns {Date}
   */
  function _parseDate(dateStr) {
    // Append T00:00:00Z to force UTC parsing regardless of local timezone
    return new Date(dateStr + 'T00:00:00Z');
  }

  /**
   * Format a Date as "YYYY-MM-DD" (UTC).
   * @param {Date} date
   * @returns {string}
   */
  function _formatDate(date) {
    var y = date.getUTCFullYear();
    var m = String(date.getUTCMonth() + 1).padStart(2, '0');
    var d = String(date.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  /**
   * Compute the union date range across all layers' task arrays.
   * Returns { minDate: Date, maxDate: Date } or null if no valid dates.
   *
   * @param {Array<{json: Object}>} layers
   * @returns {{ minDate: Date, maxDate: Date }|null}
   */
  function _computeUnionDateRange(layers) {
    var minMs = Infinity;
    var maxMs = -Infinity;

    layers.forEach(function (layer) {
      var tasks = (layer.json && layer.json.tasks) || [];
      tasks.forEach(function (task) {
        if (task.start) {
          var t = _parseDate(task.start).getTime();
          if (t < minMs) minMs = t;
        }
        if (task.end) {
          var t2 = _parseDate(task.end).getTime();
          if (t2 > maxMs) maxMs = t2;
        }
      });
    });

    if (!isFinite(minMs) || !isFinite(maxMs)) return null;

    return {
      minDate: new Date(minMs),
      maxDate: new Date(maxMs)
    };
  }

  /**
   * Add synthetic anchor tasks to a task list so Frappe Gantt renders from
   * the union start to the union end. Anchor tasks are invisible (CSS hides them).
   *
   * Strategy (Option A from spec):
   * - Two tasks with fixed IDs: "__overlay_anchor_start__" and "__overlay_anchor_end__"
   * - custom_class includes "overlay-anchor-task" for CSS hiding
   * - Uses dates 1 day before the real min and 1 day after the real max to ensure
   *   Frappe Gantt's internal padding doesn't clip the real range.
   * - If a task with the same date range already exists this is essentially a no-op.
   *
   * @param {Array} tasks - Original task array (NOT mutated; returns new array)
   * @param {Date} minDate
   * @param {Date} maxDate
   * @returns {Array} New task array with anchor tasks prepended
   */
  function _injectAnchorTasks(tasks, minDate, maxDate) {
    // Shift anchor dates 1 day outward to give Frappe Gantt room
    var anchorStart = new Date(minDate.getTime() - 86400000); // -1 day
    var anchorEnd = new Date(maxDate.getTime() + 86400000);   // +1 day

    var startStr = _formatDate(anchorStart);
    var endStr = _formatDate(anchorEnd);

    var anchors = [
      {
        id: '__overlay_anchor_start__',
        name: '',
        start: startStr,
        end: startStr,
        progress: 0,
        dependencies: '',
        custom_class: 'overlay-anchor-task',
        meta: {}
      },
      {
        id: '__overlay_anchor_end__',
        name: '',
        start: endStr,
        end: endStr,
        progress: 0,
        dependencies: '',
        custom_class: 'overlay-anchor-task',
        meta: {}
      }
    ];

    // Return anchors first (so Frappe Gantt sees the full range early)
    return anchors.concat(tasks);
  }

  // ─── Hue shift helpers ────────────────────────────────────────────────────

  /**
   * Compute hue rotation in degrees for a given layer index.
   * Layer 0 = 0deg (primary, no shift)
   * Layer 1 = 60deg
   * Layer 2 = 120deg, etc.
   *
   * @param {number} layerIndex - 0-based
   * @returns {number} degrees
   */
  function _hueShiftForIndex(layerIndex) {
    return layerIndex * 60;
  }

  // ─── Layer DOM management ─────────────────────────────────────────────────

  /**
   * Create a positioned layer <div> inside containerEl.
   *
   * @param {HTMLElement} containerEl
   * @param {string} filename
   * @param {number} layerIndex
   * @param {number} opacity
   * @returns {HTMLElement} The created layer div
   */
  function _createLayerDiv(containerEl, filename, layerIndex, opacity) {
    var div = document.createElement('div');
    div.className = 'overlay-layer' + (layerIndex === 0 ? ' primary-layer' : '');
    div.setAttribute('data-filename', filename);
    div.setAttribute('data-layer-index', String(layerIndex));

    containerEl.appendChild(div);
    return div;
  }

  function _applyLayerVisuals(layerDiv, layerIndex, opacity) {
    if (!layerDiv) return;

    var svg = layerDiv.querySelector('svg');
    if (!svg) return;

    var isPrimary = layerIndex === 0;
    var clampedOpacity = Math.max(0, Math.min(1, opacity));
    var hue = _hueShiftForIndex(layerIndex);
    var taskFilter = hue > 0 ? 'hue-rotate(' + hue + 'deg)' : 'none';

    var grid = svg.querySelector('.grid');
    var date = svg.querySelector('.date');
    var details = svg.querySelector('.details');

    if (grid) grid.style.opacity = isPrimary ? '1' : '0';
    if (date) date.style.opacity = isPrimary ? '1' : '0';
    if (details) details.style.opacity = isPrimary ? '1' : '0';

    svg.querySelectorAll('.bar').forEach(function (node) {
      node.style.opacity = String(clampedOpacity);
      node.style.filter = taskFilter;
    });

    svg.querySelectorAll('.bar-progress').forEach(function (node) {
      node.style.opacity = String(clampedOpacity);
      node.style.filter = taskFilter;
    });

    svg.querySelectorAll('.bar-label').forEach(function (node) {
      node.style.opacity = String(clampedOpacity);
      node.style.filter = 'none';
    });

    svg.querySelectorAll('.handle').forEach(function (node) {
      node.style.opacity = isPrimary ? '' : '0';
    });

    svg.querySelectorAll('.arrow').forEach(function (node) {
      node.style.opacity = '';
      node.style.filter = 'none';
    });

    svg.querySelectorAll('.slack-tail').forEach(function (node) {
      node.style.opacity = '';
      node.style.filter = 'none';
    });
  }

  function _syncContainerMetrics() {
    if (!_containerEl) return;

    var maxHeight = 0;
    var maxWidth = 0;

    _activeLayers.forEach(function (layer) {
      if (!layer || !layer.containerEl) return;
      var svg = layer.containerEl.querySelector('svg');
      if (!svg) return;

      var height = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 0;
      var width = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 0;
      if (height > maxHeight) maxHeight = height;
      if (width > maxWidth) maxWidth = width;
    });

    _containerEl.style.minHeight = maxHeight > 0 ? String(Math.ceil(maxHeight)) + 'px' : '';
    _containerEl.style.height = maxHeight > 0 ? String(Math.ceil(maxHeight)) + 'px' : '';
    _containerEl.style.minWidth = maxWidth > 0 ? String(Math.ceil(maxWidth)) + 'px' : '';
  }

  // ─── Public: render ───────────────────────────────────────────────────────

  /**
   * Clear any existing overlay and render a fresh set of stacked layers.
   *
   * @param {HTMLElement} containerEl
   * @param {Array<{filename: string, json: Object, opacity?: number, hueShift?: number}>} layers
   * @returns {Array<{filename, ganttInstance, containerEl: HTMLElement}>}
   */
  function render(containerEl, layers) {
    if (!containerEl) {
      throw new Error('PPGanttOverlay.render: containerEl is required');
    }
    if (!layers || layers.length === 0) {
      throw new Error('PPGanttOverlay.render: layers array must be non-empty');
    }
    if (typeof window.renderGantt !== 'function') {
      throw new Error('PPGanttOverlay.render: window.renderGantt (viewer.js) must be loaded first');
    }

    // Tear down any existing layers first
    clear();

    _containerEl = containerEl;

    // Mark the container as in overlay mode
    containerEl.classList.add('overlay-active');

    // Ensure the container is relatively positioned (overlay-css handles this,
    // but defensively set it here too for file:// contexts where CSS may load late)
    if (getComputedStyle(containerEl).position === 'static') {
      containerEl.style.position = 'relative';
    }

    // Compute the union date range across ALL layers (Option A date alignment)
    var unionRange = _computeUnionDateRange(layers);

    var results = [];

    layers.forEach(function (layer, index) {
      var isPrimary = (index === 0);
      var opacity = (layer.opacity != null) ? layer.opacity : (isPrimary ? 1.0 : 0.45);

      // Create the positioned layer div
      var layerDiv = _createLayerDiv(containerEl, layer.filename, index, opacity);

      // Prepare task list with anchor tasks for date-range alignment
      var tasks = (layer.json && layer.json.tasks) || [];
      if (unionRange) {
        tasks = _injectAnchorTasks(tasks, unionRange.minDate, unionRange.maxDate);
      }

      // Render this Gantt instance into its own layer div
      var ganttInstance = null;
      try {
        ganttInstance = window.renderGantt(
          layerDiv,
          tasks,
          layer.json.phase_palette || {},
          {
            // Disable click interaction on secondary layers
            on_click: isPrimary ? undefined : function () {}
          }
        );
      } catch (err) {
        console.error('[PPGanttOverlay] Failed to render layer "' + layer.filename + '":', err);
        layerDiv.remove();
        return;
      }

      var descriptor = {
        filename: layer.filename,
        ganttInstance: ganttInstance,
        containerEl: layerDiv,
        layerIndex: index
      };

      _activeLayers.push(descriptor);
      results.push(descriptor);
      _applyLayerVisuals(layerDiv, index, opacity);
    });

    _syncContainerMetrics();

    return results;
  }

  // ─── Public: setOpacity ───────────────────────────────────────────────────

  /**
   * Set the opacity of a specific layer by filename.
   * @param {string} filename
   * @param {number} opacity - 0.0 to 1.0
   */
  function setOpacity(filename, opacity) {
    var layer = _findLayer(filename);
    if (!layer) {
      console.warn('[PPGanttOverlay] setOpacity: layer not found for "' + filename + '"');
      return;
    }
    _applyLayerVisuals(layer.containerEl, layer.layerIndex || 0, opacity);
  }

  // ─── Public: removeLayer ──────────────────────────────────────────────────

  /**
   * Remove a specific layer by filename.
   * @param {string} filename
   */
  function removeLayer(filename) {
    var index = _findLayerIndex(filename);
    if (index === -1) {
      console.warn('[PPGanttOverlay] removeLayer: layer not found for "' + filename + '"');
      return;
    }

    var layer = _activeLayers[index];
    layer.containerEl.remove();
    _activeLayers.splice(index, 1);

    // If only one layer remains, remove the overlay-active class
    if (_activeLayers.length <= 1 && _containerEl) {
      _containerEl.classList.remove('overlay-active');
    }

    _syncContainerMetrics();
  }

  // ─── Public: clear ────────────────────────────────────────────────────────

  /**
   * Tear down all overlay layers and reset state.
   * Called when switching back to single-file mode.
   */
  function clear() {
    _activeLayers.forEach(function (layer) {
      try {
        layer.containerEl.remove();
      } catch (e) {}
    });
    _activeLayers = [];

    if (_containerEl) {
      _containerEl.classList.remove('overlay-active');
      _containerEl.style.minHeight = '';
      _containerEl.style.height = '';
      _containerEl.style.minWidth = '';
    }
    _containerEl = null;
  }

  // ─── Public: rewireScrollSync ─────────────────────────────────────────────

  /**
   * Re-wire scroll synchronization.
   *
   * In our stacked-DOM-layers architecture, all .overlay-layer divs are
   * absolutely positioned children of the same scrollable containerEl.
   * When containerEl scrolls, ALL layers scroll together naturally — no JS
   * event bridging is needed. This function is a no-op provided for API
   * completeness (in case a future implementation needs it).
   *
   * If per-layer horizontal scroll drift is observed (R4 in plan §10), the
   * fix is to set an explicit min-width on all layers equal to the widest
   * SVG, forcing the container to grow to that width. That would be done here.
   */
  function rewireScrollSync() {
    // No-op in the current architecture.
    // Natural DOM scroll handles it: all layers share the same scrollable parent.
    // See comment above for the R4 mitigation path if needed.
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  function _findLayer(filename) {
    for (var i = 0; i < _activeLayers.length; i++) {
      if (_activeLayers[i].filename === filename) return _activeLayers[i];
    }
    return null;
  }

  function _findLayerIndex(filename) {
    for (var i = 0; i < _activeLayers.length; i++) {
      if (_activeLayers[i].filename === filename) return i;
    }
    return -1;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  global.PPGanttOverlay = {
    render: render,
    setOpacity: setOpacity,
    removeLayer: removeLayer,
    clear: clear,
    rewireScrollSync: rewireScrollSync
  };

}(window));
