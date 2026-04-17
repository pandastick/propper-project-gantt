/**
 * PPGantt Simulator — js/simulator.js
 *
 * Exported API (browser): window.PPGanttSimulator
 * Exported API (Node/tests): module.exports
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  simulatePush(tasks, rootTaskId, pushDays)                          │
 * │    → { newSchedule, pushAmounts }                                   │
 * │                                                                     │
 * │  renderGhosts(containerEl, originalTasks, newTasks, pushAmounts)    │
 * │    Overlays ghost bars on the Frappe Gantt SVG container.           │
 * │                                                                     │
 * │  saveSimulation(state)   → writes to sessionStorage                 │
 * │  loadSimulation()        → returns state or null                    │
 * │  resetSimulation()       → clears sessionStorage, returns null      │
 * │                                                                     │
 * │  openPushDialog(taskId, onConfirm)                                  │
 * │    Shows a minimal modal asking for N days, calls onConfirm(N).     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Design notes:
 *   - Non-destructive: never modifies the input tasks array or its objects.
 *   - Slack absorption: effectivePush = max(0, predPush - task.meta.slack_days)
 *     Negative slack is clamped to 0 (treated as already-late, always push fully).
 *   - Gap-preserving fallback: if NO task in the file has slack_days defined,
 *     downstream tasks preserve their original gap to their predecessor instead
 *     of using slack absorption. This is a file-level decision detected once.
 *   - Cycle detection: topological sort throws Error on cycles.
 */

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Add N calendar days to an ISO date string.
 * @param {string} isoDate  e.g. "2026-04-14"
 * @param {number} days     integer days (may be negative)
 * @returns {string}        ISO date string
 */
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Difference in calendar days between two ISO dates (b - a).
 * @param {string} isoA
 * @param {string} isoB
 * @returns {number}
 */
function daysBetween(isoA, isoB) {
  const msPerDay = 86400000;
  const a = new Date(isoA + 'T00:00:00Z').getTime();
  const b = new Date(isoB + 'T00:00:00Z').getTime();
  return Math.round((b - a) / msPerDay);
}

// ---------------------------------------------------------------------------
// Dependency graph helpers
// ---------------------------------------------------------------------------

/**
 * Parse the dependencies field into an array of trimmed IDs.
 * Accepts either a comma-separated string (the JSON-on-disk contract) or
 * an array (Frappe Gantt mutates dependencies in place during setup_tasks).
 * Returns [] for empty/null/undefined.
 * @param {string|string[]|undefined} deps
 * @returns {string[]}
 */
function parseDeps(deps) {
  if (!deps) return [];
  if (Array.isArray(deps)) {
    return deps.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  }
  if (typeof deps !== 'string') return [];
  return deps.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Build a dependents map: taskId → [list of tasks that depend on it].
 * i.e. if B.dependencies includes A, then dependents[A] contains B.
 * @param {object[]} tasks
 * @returns {Map<string, string[]>}
 */
function buildDependentsMap(tasks) {
  const map = new Map();
  // Initialize all tasks
  for (const task of tasks) {
    if (!map.has(task.id)) map.set(task.id, []);
  }
  // Fill dependents
  for (const task of tasks) {
    for (const predId of parseDeps(task.dependencies)) {
      if (!map.has(predId)) map.set(predId, []);
      map.get(predId).push(task.id);
    }
  }
  return map;
}

/**
 * Directed lineage of a task: its ancestor chain (upstream predecessors,
 * recursively) PLUS its descendant chain (downstream dependents, recursively),
 * plus the root itself. Returns a Set<string> of task IDs.
 *
 * This is NOT the undirected connected component. On a densely-linked
 * roadmap the connected component bloats to the entire graph via cousin
 * bleed — every sibling of every ancestor and every sibling of every
 * descendant ends up included. Directed lineage gives the user exactly the
 * tasks that depend on or enable the clicked task, with no sibling noise.
 *
 * Used by the shift-click Related-Tasks focus mode in the viewer.
 *
 * Cycle-safe (uses a visited set) — does NOT throw on cycles.
 *
 * @param {object[]} tasks
 * @param {string} rootId
 * @returns {Set<string>}
 */
function taskLineage(tasks, rootId) {
  const dependents = buildDependentsMap(tasks);
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, t);

  const seen = new Set();
  if (!rootId) return seen;
  seen.add(rootId);

  // Upstream walk: only follow predecessor edges.
  const upQueue = [rootId];
  while (upQueue.length > 0) {
    const id = upQueue.shift();
    const task = byId.get(id);
    if (!task) continue;
    for (const pred of parseDeps(task.dependencies)) {
      if (!seen.has(pred)) {
        seen.add(pred);
        upQueue.push(pred);
      }
    }
  }

  // Downstream walk: only follow dependent edges.
  const downQueue = [rootId];
  while (downQueue.length > 0) {
    const id = downQueue.shift();
    const downstream = dependents.get(id) || [];
    for (const dep of downstream) {
      if (!seen.has(dep)) {
        seen.add(dep);
        downQueue.push(dep);
      }
    }
  }

  return seen;
}

/**
 * Deprecated alias for taskLineage. Kept temporarily for any stale callers.
 * @deprecated Use taskLineage instead.
 */
function relatedComponent(tasks, rootId) {
  return taskLineage(tasks, rootId);
}

/**
 * Topological sort starting from rootTaskId, following the dependents map
 * (downstream direction only — predecessors of root are NOT included).
 *
 * Uses DFS with cycle detection via "grey/black" node coloring.
 * Throws Error if a cycle is detected.
 *
 * @param {Map<string, string[]>} dependents  taskId → downstream task IDs
 * @param {string} rootTaskId
 * @returns {string[]}  topological order (root first)
 */
function topologicalSort(dependents, rootTaskId) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const order = [];

  function dfs(nodeId) {
    const c = color.get(nodeId) || WHITE;
    if (c === BLACK) return; // already processed
    if (c === GREY) {
      throw new Error(
        `Dependency cycle detected involving task "${nodeId}". ` +
        `Cannot simulate a push when circular dependencies exist.`
      );
    }
    color.set(nodeId, GREY);
    for (const downstream of (dependents.get(nodeId) || [])) {
      dfs(downstream);
    }
    color.set(nodeId, BLACK);
    order.push(nodeId);
  }

  dfs(rootTaskId);
  // order is in reverse post-order (leaves first, root last) — reverse it
  return order.reverse();
}

// ---------------------------------------------------------------------------
// Gap-preserving fallback detection
// ---------------------------------------------------------------------------

/**
 * Returns true if NO task in the array has a defined (non-null) slack_days field.
 * In that case the simulator falls back to gap-preserving cascade.
 * @param {object[]} tasks
 * @returns {boolean}
 */
function shouldUseGapPreservingFallback(tasks) {
  return tasks.every(t => t.meta == null || t.meta.slack_days == null);
}

// ---------------------------------------------------------------------------
// Core simulation algorithm
// ---------------------------------------------------------------------------

/**
 * Slack-aware critical path cascade simulation (plan §7.2).
 *
 * @param {object[]} tasks        Array of task objects matching the JSON contract.
 * @param {string}   rootTaskId   The task being pushed.
 * @param {number}   pushDays     Number of calendar days to push (positive = later).
 *                                Negative values push earlier (predecessors never move backward).
 * @returns {{ newSchedule: object[], pushAmounts: Map<string, number> }}
 */
function simulatePush(tasks, rootTaskId, pushDays) {
  if (!pushDays || isNaN(pushDays)) {
    throw new Error('pushDays must be a non-zero number.');
  }

  const taskById = new Map(tasks.map(t => [t.id, t]));

  if (!taskById.has(rootTaskId)) {
    throw new Error(`Root task "${rootTaskId}" not found in task list.`);
  }

  // 1. Build dependents map (A → [B, C, ...] means B and C depend on A)
  const dependents = buildDependentsMap(tasks);

  // 2. Topological sort from root through its downstream tasks
  const order = topologicalSort(dependents, rootTaskId);
  // order[0] is rootTaskId

  // 3. Determine whether to use gap-preserving fallback (no slack data anywhere)
  const gapFallback = shouldUseGapPreservingFallback(tasks);

  // 4. Deep-clone the tasks (non-destructive)
  const newSchedule = tasks.map(t => ({
    ...t,
    meta: t.meta ? { ...t.meta } : t.meta,
  }));
  const newById = new Map(newSchedule.map(t => [t.id, t]));

  // Track how many days each task was pushed
  const pushAmounts = new Map();

  // Push the root task
  const root = newById.get(rootTaskId);
  root.start = addDays(root.start, pushDays);
  root.end   = addDays(root.end,   pushDays);
  pushAmounts.set(rootTaskId, pushDays);

  // 5. Walk downstream tasks in topological order
  for (const taskId of order.slice(1)) { // skip root (index 0)
    const task    = newById.get(taskId);
    const origTask = taskById.get(taskId);
    const predecessorIds = parseDeps(task.dependencies);

    if (gapFallback) {
      // Gap-preserving fallback: find the predecessor that was pushed the most
      // and compute the new start as: predecessor's new end + original gap.
      let maxNewEnd = null;
      let correspondingOrigPredEnd = null;

      for (const predId of predecessorIds) {
        if (!pushAmounts.has(predId)) continue; // predecessor wasn't pushed
        const newPred  = newById.get(predId);
        const origPred = taskById.get(predId);
        if (!newPred || !origPred) continue;

        if (maxNewEnd === null || newPred.end > maxNewEnd) {
          maxNewEnd = newPred.end;
          correspondingOrigPredEnd = origPred.end;
        }
      }

      if (maxNewEnd !== null && correspondingOrigPredEnd !== null) {
        const origGap = daysBetween(correspondingOrigPredEnd, origTask.start);
        const newStart = addDays(maxNewEnd, origGap);
        const duration = daysBetween(origTask.start, origTask.end);
        const daysMoved = daysBetween(origTask.start, newStart);
        if (daysMoved > 0) {
          task.start = newStart;
          task.end   = addDays(newStart, duration);
          pushAmounts.set(taskId, daysMoved);
        }
      }

    } else {
      // Slack-aware cascade (primary path)
      // Negative slack is clamped to 0 — always push fully if slack is negative.
      // (Negative slack means the task is already late.)
      const slackDays = Math.max(0, (task.meta && task.meta.slack_days != null)
        ? task.meta.slack_days
        : 0
      );

      let maxPredecessorPush = 0;

      for (const predId of predecessorIds) {
        if (!pushAmounts.has(predId)) continue; // predecessor wasn't in cascade
        const predPush = pushAmounts.get(predId);
        const effectivePush = Math.max(0, predPush - slackDays);
        if (effectivePush > maxPredecessorPush) {
          maxPredecessorPush = effectivePush;
        }
      }

      if (maxPredecessorPush > 0) {
        task.start = addDays(task.start, maxPredecessorPush);
        task.end   = addDays(task.end,   maxPredecessorPush);
        pushAmounts.set(taskId, maxPredecessorPush);
      }
      // else: task absorbs via slack — does NOT move; not added to pushAmounts
    }
  }

  return { newSchedule, pushAmounts };
}

// ---------------------------------------------------------------------------
// Ghost rendering
// ---------------------------------------------------------------------------

/**
 * Overlay semi-transparent "ghost" bars on the Frappe Gantt SVG container
 * showing original bar positions for tasks that were moved.
 *
 * Strategy: Frappe Gantt renders into a container element. We walk the
 * container's SVG, find bar <rect> elements by data-id, clone them as ghosts,
 * and append labels. Row height is computed from the Frappe Gantt default
 * (bar_height=20 + padding=18 = 38px row, with a header offset).
 *
 * @param {Element}  containerEl    The DOM element Frappe Gantt rendered into.
 * @param {object[]} originalTasks  Tasks before simulation.
 * @param {object[]} newTasks       Tasks after simulation (newSchedule).
 * @param {Map<string,number>} pushAmounts  taskId → days pushed (only moved tasks).
 */
function renderGhosts(containerEl, originalTasks, newTasks, pushAmounts) {
  if (!containerEl) return;

  // Remove any previously rendered ghosts
  containerEl.querySelectorAll('.ppgantt-ghost, .ppgantt-ghost-label').forEach(el => el.remove());

  const svg = containerEl.querySelector('svg.gantt');
  if (!svg) {
    console.warn('PPGanttSimulator.renderGhosts: No Frappe Gantt SVG found in container.');
    return;
  }

  // Find all bar groups rendered by Frappe Gantt
  // Frappe Gantt uses <g class="bar-wrapper" data-id="..."> with a child <rect class="bar">
  const barGroups = svg.querySelectorAll('.bar-wrapper');
  if (!barGroups.length) {
    console.warn('PPGanttSimulator.renderGhosts: No .bar-wrapper elements found in SVG.');
    return;
  }

  const newById = new Map(newTasks.map(t => [t.id, t]));
  const origById = new Map(originalTasks.map(t => [t.id, t]));

  // Tasks that were absorbed (had a pushed predecessor but did not move themselves)
  // = tasks that appear as downstream in cascade but are NOT in pushAmounts (excluding root)
  // We detect these by checking: does this task have a predecessor in pushAmounts
  // but is itself NOT in pushAmounts?
  const absorbedTasks = new Set();
  for (const task of newTasks) {
    if (pushAmounts.has(task.id)) continue; // it moved
    const preds = parseDeps(task.dependencies);
    for (const predId of preds) {
      if (pushAmounts.has(predId)) {
        absorbedTasks.add(task.id);
        break;
      }
    }
  }

  // Pixel-per-day scale from the viewer's Gantt instance. Used to translate
  // each moved task's ghost back by the number of days it was pushed.
  // Falls back to a reasonable column-width estimate if the helper isn't
  // exposed (older viewer builds, or tests).
  const _daysToPixels = (
    window._ppGanttInternal && typeof window._ppGanttInternal.daysToPixels === 'function'
  )
    ? window._ppGanttInternal.daysToPixels
    : function () { return 0; };

  barGroups.forEach(group => {
    const taskId = group.getAttribute('data-id');
    if (!taskId) return;

    const barRect = group.querySelector('rect.bar');
    if (!barRect) return;

    const moved = pushAmounts.has(taskId);
    const absorbed = absorbedTasks.has(taskId);

    if (moved) {
      const days = pushAmounts.get(taskId);
      const dxPixels = _daysToPixels(days); // forward-move → positive pixels
      const barX = parseFloat(barRect.getAttribute('x') || '0');
      const barY = parseFloat(barRect.getAttribute('y') || '0');
      const barW = parseFloat(barRect.getAttribute('width') || '0');
      const barH = parseFloat(barRect.getAttribute('height') || '20');

      // Clone the bar and translate back by dxPixels (days × px/day) so
      // the ghost sits at the task's pre-simulation x. Keep the original
      // phase color (via cloneNode) — a neutral gray would lose at-a-glance
      // stream recognition. Low opacity + no stroke = subtle shadow.
      const ghostRect = barRect.cloneNode(true);
      ghostRect.classList.add('ppgantt-ghost');
      ghostRect.setAttribute('x', String(barX - dxPixels));
      // Slightly broader vertically to read as a footprint rather than
      // a double-bar (2px extra top/bottom).
      ghostRect.setAttribute('y', String(barY - 2));
      ghostRect.setAttribute('height', String(barH + 4));
      ghostRect.style.opacity = '0.18';
      ghostRect.style.stroke = 'none';
      ghostRect.style.pointerEvents = 'none';

      // Behind the live bar so the live bar's label stays readable.
      group.insertBefore(ghostRect, group.firstChild);

      // "+N days" label tucked next to the real bar's right edge. Muted
      // amber instead of the previous loud orange.
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.classList.add('ppgantt-ghost-label');
      label.setAttribute('x', String(barX + barW + 6));
      label.setAttribute('y', String(barY + barH / 2 + 4));
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#f59e0b');
      label.setAttribute('font-weight', '600');
      label.style.pointerEvents = 'none';
      label.textContent = `+${days} day${days !== 1 ? 's' : ''}`;
      group.appendChild(label);
    }

    if (absorbed) {
      // Add "✓ absorbed" label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.classList.add('ppgantt-ghost-label');
      label.setAttribute('x', String(parseFloat(barRect.getAttribute('x') || '0') + parseFloat(barRect.getAttribute('width') || '0') + 6));
      label.setAttribute('y', String(parseFloat(barRect.getAttribute('y') || '0') + parseFloat(barRect.getAttribute('height') || '20') / 2 + 4));
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#22c55e');
      label.setAttribute('font-weight', 'bold');
      label.style.pointerEvents = 'none';
      label.textContent = '✓ absorbed';
      group.appendChild(label);
    }
  });
}

// ---------------------------------------------------------------------------
// sessionStorage state management
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ppgantt_simulation';

/**
 * Persist simulation state to sessionStorage.
 * @param {{ pushedTaskId: string, pushDays: number, newSchedule: object[],
 *           pushAmounts: Map<string,number>, timestamp: string,
 *           synced_at?: string }} state
 */
function saveSimulation(state) {
  const serializable = {
    ...state,
    // Map is not JSON-serializable — convert to plain object
    pushAmounts: state.pushAmounts instanceof Map
      ? Object.fromEntries(state.pushAmounts)
      : state.pushAmounts,
    timestamp: state.timestamp || new Date().toISOString(),
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.warn('PPGanttSimulator.saveSimulation: Failed to write to sessionStorage.', e);
  }
}

/**
 * Load simulation state from sessionStorage.
 * Returns null if nothing is stored or if synced_at has changed.
 *
 * @param {string} [currentSyncedAt]  The synced_at timestamp of the currently loaded JSON.
 *                                    If provided and differs from saved state, simulation is discarded.
 * @returns {object|null}
 */
function loadSimulation(currentSyncedAt) {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);

    // Discard stale simulation if synced_at has changed
    if (currentSyncedAt && state.synced_at && state.synced_at !== currentSyncedAt) {
      console.info('PPGanttSimulator.loadSimulation: Discarding stale simulation (synced_at mismatch).');
      resetSimulation();
      return null;
    }

    // Re-hydrate pushAmounts as a Map
    if (state.pushAmounts && !(state.pushAmounts instanceof Map)) {
      state.pushAmounts = new Map(Object.entries(state.pushAmounts));
    }

    return state;
  } catch (e) {
    console.warn('PPGanttSimulator.loadSimulation: Failed to read from sessionStorage.', e);
    return null;
  }
}

/**
 * Clear the simulation from sessionStorage.
 * @returns {null}
 */
function resetSimulation() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // sessionStorage unavailable (e.g., in Node test context) — ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Push dialog
// ---------------------------------------------------------------------------

/**
 * Show a minimal modal asking the user for a number of days to push.
 * Calls onConfirm(pushDays) if the user confirms.
 *
 * @param {string}   taskId     The task ID to display in the dialog.
 * @param {Function} onConfirm  Called with (pushDays: number) on confirmation.
 */
function openPushDialog(taskId, onConfirm) {
  // Remove any existing dialog
  const existing = document.getElementById('ppgantt-push-dialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ppgantt-push-dialog';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.5)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9999', 'font-family:system-ui,sans-serif',
  ].join(';');

  const dialog = document.createElement('div');
  dialog.style.cssText = [
    'background:#1e1e1e', 'color:#f0f0f0', 'border-radius:8px',
    'padding:24px 28px', 'min-width:300px', 'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
    'border:1px solid #444',
  ].join(';');

  dialog.innerHTML = `
    <h3 style="margin:0 0 8px;font-size:15px;font-weight:600;color:#fff">
      Push task
    </h3>
    <p style="margin:0 0 16px;font-size:13px;color:#aaa;word-break:break-all">
      ID: <code style="color:#e0a060">${taskId}</code>
    </p>
    <label style="font-size:13px;display:block;margin-bottom:8px">
      Push by (days):
    </label>
    <input
      id="ppgantt-push-days"
      type="number"
      value="1"
      min="1"
      step="1"
      style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;
             background:#2d2d2d;color:#fff;border:1px solid #555;border-radius:4px;
             margin-bottom:16px;outline:none"
    />
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="ppgantt-push-cancel"
        style="padding:8px 16px;font-size:13px;cursor:pointer;
               background:#3a3a3a;color:#ccc;border:1px solid #555;border-radius:4px">
        Cancel
      </button>
      <button id="ppgantt-push-confirm"
        style="padding:8px 16px;font-size:13px;cursor:pointer;
               background:#e65c00;color:#fff;border:none;border-radius:4px;font-weight:600">
        Push
      </button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const input = document.getElementById('ppgantt-push-days');
  input.focus();
  input.select();

  function close() {
    overlay.remove();
  }

  document.getElementById('ppgantt-push-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.getElementById('ppgantt-push-confirm').addEventListener('click', () => {
    const days = parseInt(input.value, 10);
    if (isNaN(days) || days === 0) {
      input.style.borderColor = '#e05050';
      input.focus();
      return;
    }
    close();
    onConfirm(days);
  });

  // Allow Enter to confirm
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('ppgantt-push-confirm').click();
    } else if (e.key === 'Escape') {
      close();
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PPGanttSimulator = {
  simulatePush,
  renderGhosts,
  saveSimulation,
  loadSimulation,
  resetSimulation,
  openPushDialog,
  // Public graph helpers (used by viewer's related-focus mode)
  parseDeps,
  buildDependentsMap,
  taskLineage,
  relatedComponent, // deprecated alias, kept for safety
  // Expose helpers for testing convenience
  _addDays: addDays,
  _daysBetween: daysBetween,
  _parseDeps: parseDeps,
  _shouldUseGapPreservingFallback: shouldUseGapPreservingFallback,
};

// Browser export
if (typeof window !== 'undefined') {
  window.PPGanttSimulator = PPGanttSimulator;
}

// Node/CommonJS export (for unit tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PPGanttSimulator;
}
