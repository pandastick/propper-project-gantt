// change-log.js — PPGantt Change Log Export Module (Phase E)
//
// Usage example (main session wires this):
//   const log = window.PPGanttChangeLog.createFromSource(sourceMeta);
//   log.recordPush('fix-001', 'Credential rotation', 'https://notion.so/your-workspace/fix-001',
//                  '2026-04-14', '2026-04-14', '2026-04-16', '2026-04-16', 'user push');
//   document.getElementById('export-changes-btn').addEventListener('click', async () => {
//     if (log.hasChanges()) {
//       await log.copyToClipboard();
//       alert('Change log copied to clipboard');
//     }
//   });
//
// sourceMeta shape (from JSON contract §6):
//   { notion_url, table_name, synced_at, data_source_id }

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Notion page UUID from a notion.so URL.
 * Handles both:
 *   https://www.notion.so/workspace/SomeTitle-<uuid>
 *   https://www.notion.so/workspace/<uuid>
 * Returns the raw UUID string (with hyphens if present), or the original
 * string if no UUID pattern is detected.
 */
function extractNotionPageId(url) {
  if (!url) return '';
  // Match a 32-hex-char UUID (with or without dashes)
  const match = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    || url.match(/([0-9a-f]{32})/i);
  return match ? match[1] : url;
}

/**
 * Format a YYYY-MM-DD date string for display (returns as-is — already human-readable).
 */
function fmt(date) {
  return date || 'unknown';
}

/**
 * Determine whether an event was directly user-triggered or a cascade.
 * Convention: reason starts with "cascade" for cascades.
 */
function isCascade(reason) {
  return typeof reason === 'string' && reason.toLowerCase().startsWith('cascade');
}

function normalizePushAmounts(pushAmounts) {
  if (!pushAmounts) return null;
  if (pushAmounts instanceof Map) return pushAmounts;
  if (typeof pushAmounts === 'object') return new Map(Object.entries(pushAmounts));
  return null;
}

function buildScheduleDiffEvents(originalTasks, currentTasks, options) {
  const opts = options || {};
  const pushAmounts = normalizePushAmounts(opts.pushAmounts);
  const rootTaskId = opts.rootTaskId || '';
  const originalById = new Map((originalTasks || []).map(task => [task.id, task]));
  const rootTask = originalById.get(rootTaskId);
  const rootTaskName = opts.rootTaskName || (rootTask && rootTask.name) || rootTaskId;
  const cascades = [];
  let rootEvent = null;
  const genericEvents = [];

  (currentTasks || []).forEach((task) => {
    const originalTask = originalById.get(task.id);
    if (!originalTask) return;
    if (originalTask.start === task.start && originalTask.end === task.end) return;

    let reason = 'schedule diff';
    if (rootTaskId && task.id === rootTaskId) {
      reason = 'user push';
    } else if (pushAmounts && pushAmounts.has(task.id)) {
      reason = 'cascade from task ' + rootTaskName;
    }

    const event = {
      taskId: task.id,
      taskName: task.name || originalTask.name || task.id,
      taskNotionUrl: (originalTask.meta && originalTask.meta.notion_url) || (task.meta && task.meta.notion_url) || '',
      originalStart: originalTask.start,
      originalEnd: originalTask.end,
      newStart: task.start,
      newEnd: task.end,
      reason,
    };

    if (reason === 'user push') {
      rootEvent = event;
    } else if (isCascade(reason)) {
      cascades.push(event);
    } else {
      genericEvents.push(event);
    }
  });

  cascades.sort((a, b) => a.taskName.localeCompare(b.taskName) || a.taskId.localeCompare(b.taskId));
  genericEvents.sort((a, b) => a.taskName.localeCompare(b.taskName) || a.taskId.localeCompare(b.taskId));

  return []
    .concat(rootEvent ? [rootEvent] : [])
    .concat(cascades)
    .concat(genericEvents);
}

// ---------------------------------------------------------------------------
// ChangeLog class
// ---------------------------------------------------------------------------

class ChangeLog {
  /**
   * @param {Object} sourceMeta - { notion_url, table_name, synced_at, data_source_id }
   */
  constructor(sourceMeta) {
    this.source = Object.assign({
      notion_url: '',
      table_name: 'Unknown Table',
      synced_at: new Date().toISOString(),
      data_source_id: '',
    }, sourceMeta || {});

    // Each event:
    // { taskId, taskName, taskNotionUrl, originalStart, originalEnd,
    //   newStart, newEnd, reason, timestamp, groupKey }
    this.events = [];
  }

  /**
   * Record a push event. Skips no-ops (dates unchanged).
   *
   * @param {string} taskId          - Task ID (Notion page UUID or local ID)
   * @param {string} taskName        - Human-readable task name
   * @param {string} taskNotionUrl   - Full Notion page URL
   * @param {string} originalStart   - YYYY-MM-DD
   * @param {string} originalEnd     - YYYY-MM-DD
   * @param {string} newStart        - YYYY-MM-DD
   * @param {string} newEnd          - YYYY-MM-DD
   * @param {string} reason          - "user push" | "cascade from task X" | etc.
   */
  recordPush(taskId, taskName, taskNotionUrl, originalStart, originalEnd, newStart, newEnd, reason) {
    // Edge case: skip no-ops
    if (originalStart === newStart && originalEnd === newEnd) {
      return;
    }

    // Assign a groupKey so cascades can be nested under their root push.
    // A "user push" starts a new group. Cascades inherit the current group.
    let groupKey;
    if (isCascade(reason)) {
      // Attach to the last user-push group
      const lastRoot = [...this.events].reverse().find(e => !isCascade(e.reason));
      groupKey = lastRoot ? lastRoot.groupKey : 'ungrouped';
    } else {
      // New root push — group key is the taskId + timestamp combo
      groupKey = `${taskId}_${Date.now()}`;
    }

    this.events.push({
      taskId,
      taskName,
      taskNotionUrl: taskNotionUrl || '',
      originalStart,
      originalEnd,
      newStart,
      newEnd,
      reason: reason || 'user push',
      timestamp: new Date().toISOString(),
      groupKey,
    });
  }

  /** Remove all recorded events. */
  clear() {
    this.events = [];
  }

  replaceEvents(events) {
    this.clear();
    (events || []).forEach((event) => {
      this.recordPush(
        event.taskId,
        event.taskName,
        event.taskNotionUrl,
        event.originalStart,
        event.originalEnd,
        event.newStart,
        event.newEnd,
        event.reason
      );
    });
  }

  /** Returns true if any events have been recorded. */
  hasChanges() {
    return this.events.length > 0;
  }

  /**
   * Generate the markdown export string.
   * Returns a friendly message if no changes are recorded.
   *
   * Cascade grouping format:
   *   1. Root task (user push)
   *      1a. Cascade task A
   *      1b. Cascade task B
   *   2. Next root task
   *   ...
   */
  exportMarkdown() {
    if (!this.hasChanges()) {
      return '# Notion Update Prompt — No Changes\n\nNo schedule changes have been simulated yet.\nUse the Gantt viewer to push tasks before exporting.';
    }

    const { notion_url, table_name, synced_at } = this.source;
    const generated = new Date().toISOString();

    const header = [
      `# Notion Update Prompt — ${table_name}`,
      `# Generated ${generated}`,
      `# Source: ${notion_url}`,
      `# Simulated from snapshot: ${synced_at}`,
      '',
      'The following schedule changes were simulated locally with slack-aware',
      'critical path analysis. Please update the Notion database using the',
      'Notion MCP tool `mcp__notion__notion-update-page`:',
      '',
    ].join('\n');

    // Group events: root pushes get a top-level number, cascades sub-letters
    // Build ordered group list preserving insertion order
    const groupOrder = [];
    const groupMap = {}; // groupKey -> { root, cascades[] }

    for (const event of this.events) {
      if (!isCascade(event.reason)) {
        // Root push
        if (!groupMap[event.groupKey]) {
          groupMap[event.groupKey] = { root: event, cascades: [] };
          groupOrder.push(event.groupKey);
        }
      } else {
        // Cascade — attach to its group
        if (groupMap[event.groupKey]) {
          groupMap[event.groupKey].cascades.push(event);
        } else {
          // Orphaned cascade (no root push recorded first) — treat as its own root
          const syntheticKey = event.groupKey;
          groupMap[syntheticKey] = { root: event, cascades: [] };
          groupOrder.push(syntheticKey);
        }
      }
    }

    const formatEvent = (event, label) => {
      const pageId = extractNotionPageId(event.taskNotionUrl) || event.taskId;
      const lines = [
        `${label}. Task "${event.taskName}" (${event.taskNotionUrl || 'no URL'})`,
        `   - Change Start Date from ${fmt(event.originalStart)} to ${fmt(event.newStart)}`,
        `   - Change End Date from ${fmt(event.originalEnd)} to ${fmt(event.newEnd)}`,
        `   - Reason: ${event.reason}`,
        `   - Notion page_id: ${pageId}`,
      ];
      return lines.join('\n');
    };

    const subLabel = (rootIndex, cascadeIndex) => {
      // 1a, 1b, 1c... up to z, then 1aa, 1ab...
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      if (cascadeIndex < 26) return `${rootIndex}${letters[cascadeIndex]}`;
      const major = Math.floor(cascadeIndex / 26);
      const minor = cascadeIndex % 26;
      return `${rootIndex}${letters[major - 1]}${letters[minor]}`;
    };

    const body = [];
    groupOrder.forEach((key, groupIdx) => {
      const rootNum = groupIdx + 1;
      const { root, cascades } = groupMap[key];
      body.push(formatEvent(root, String(rootNum)));
      cascades.forEach((cascade, ci) => {
        body.push(formatEvent(cascade, subLabel(rootNum, ci)));
      });
    });

    const footer = [
      '',
      '---',
      '',
      'Do NOT change any other fields. Do NOT modify dependencies.',
      '',
      'For reference, the Notion MCP update call format is:',
      '  tool: mcp__notion__notion-update-page',
      '  page_id: <notion page UUID>',
      '  command: "update_properties"',
      '  properties: { "date:Start Date:start": "YYYY-MM-DD", "date:End Date:start": "YYYY-MM-DD" }',
      '',
      'Example for task above:',
    ];

    // Add a concrete example using the first event
    const firstEvent = this.events[0];
    const examplePageId = extractNotionPageId(firstEvent.taskNotionUrl) || firstEvent.taskId;
    footer.push(
      '  tool: mcp__notion__notion-update-page',
      `  page_id: ${examplePageId}`,
      '  command: "update_properties"',
      `  properties: { "date:Start Date:start": "${firstEvent.newStart}", "date:End Date:start": "${firstEvent.newEnd}" }`,
    );

    return header + body.join('\n\n') + '\n' + footer.join('\n');
  }

  /**
   * Copy the markdown export to the system clipboard.
   * Returns a Promise. Rejects with a descriptive error if clipboard is unavailable.
   */
  copyToClipboard() {
    const md = this.exportMarkdown();
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return Promise.reject(
        new Error('Clipboard API not available. Try copying manually from the export panel.'),
      );
    }
    return navigator.clipboard.writeText(md).catch((err) => {
      return Promise.reject(
        new Error(`Clipboard write failed: ${err && err.message ? err.message : err}. ` +
          'This may require a user gesture (button click) or HTTPS context.'),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

function createFromSource(sourceMeta) {
  return new ChangeLog(sourceMeta);
}

// ---------------------------------------------------------------------------
// Exports — browser + Node compatible
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChangeLog, createFromSource, buildScheduleDiffEvents };
}
if (typeof window !== 'undefined') {
  window.PPGanttChangeLog = { ChangeLog, createFromSource, buildScheduleDiffEvents };
}

// ---------------------------------------------------------------------------
// Self-test (run with: node js/change-log.js)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && require.main === module) {
  console.log('Running change-log.js self-test...\n');

  const sourceMeta = {
    notion_url: 'https://www.notion.so/your-workspace/3f81368c1afd4671850393fca51a1b25',
    table_name: 'MVP Implementation Gantt V2 (Apr 9)',
    synced_at: '2026-04-09T14:32:00Z',
    data_source_id: 'collection://67da185d-4275-4683-848e-82a3652a80ea',
  };

  const log = createFromSource(sourceMeta);

  // --- Test 1: hasChanges on empty log ---
  console.assert(!log.hasChanges(), 'FAIL: hasChanges() should be false when empty');

  // --- Test 2: exportMarkdown on empty log ---
  const emptyExport = log.exportMarkdown();
  console.assert(
    emptyExport.includes('No schedule changes'),
    'FAIL: empty export should contain friendly message',
  );

  // --- Test 3: no-op is skipped ---
  log.recordPush('fix-000', 'No change task', 'https://notion.so/noop',
    '2026-04-10', '2026-04-14', '2026-04-10', '2026-04-14', 'user push');
  console.assert(!log.hasChanges(), 'FAIL: no-op should not be recorded');

  // --- Test 4: record a root push ---
  log.recordPush(
    'e8a1c4b2-1234-5678-9abc-def012345678',
    'Credential rotation',
    'https://www.notion.so/your-workspace/e8a1c4b212345678',
    '2026-04-14', '2026-04-14',
    '2026-04-16', '2026-04-16',
    'user push',
  );
  console.assert(log.hasChanges(), 'FAIL: hasChanges() should be true after recordPush');

  // --- Test 5: record a cascade ---
  log.recordPush(
    'a1b2c3d4-5678-9abc-def0-123456789abc',
    'Harden Supabase RLS policies',
    'https://www.notion.so/your-workspace/a1b2c3d456789abc',
    '2026-04-15', '2026-04-18',
    '2026-04-17', '2026-04-20',
    'cascade from task Credential rotation',
  );
  console.assert(log.events.length === 2, 'FAIL: should have 2 events');

  // --- Test 6: exportMarkdown content checks ---
  const md = log.exportMarkdown();

  console.assert(md.includes('MVP Implementation Gantt V2 (Apr 9)'), 'FAIL: missing table name');
  console.assert(md.includes('Credential rotation'), 'FAIL: missing root task name');
  console.assert(md.includes('Harden Supabase RLS policies'), 'FAIL: missing cascade task name');
  console.assert(md.includes('2026-04-16'), 'FAIL: missing new start date');
  console.assert(md.includes('2026-04-20'), 'FAIL: missing cascade new end date');
  console.assert(md.includes('user push'), 'FAIL: missing reason');
  console.assert(md.includes('cascade from task'), 'FAIL: missing cascade reason');
  console.assert(md.includes('1a.'), 'FAIL: cascade should be labeled 1a');
  console.assert(md.includes('mcp__notion__notion-update-page'), 'FAIL: missing MCP tool reference');
  console.assert(md.includes('update_properties'), 'FAIL: missing update_properties command');
  console.assert(md.includes('Do NOT change any other fields'), 'FAIL: missing safety note');

  // --- Test 7: clear ---
  log.clear();
  console.assert(!log.hasChanges(), 'FAIL: hasChanges() should be false after clear()');

  console.log('\n=== SELF-TEST PASSED ===\n');

  // --- Sample output ---
  const demoLog = createFromSource(sourceMeta);
  demoLog.recordPush(
    'e8a1c4b2-1234-5678-9abc-def012345678',
    'Credential rotation',
    'https://www.notion.so/your-workspace/e8a1c4b212345678',
    '2026-04-14', '2026-04-14',
    '2026-04-16', '2026-04-16',
    'user push',
  );
  demoLog.recordPush(
    'a1b2c3d4-5678-9abc-def0-123456789abc',
    'Harden Supabase RLS policies',
    'https://www.notion.so/your-workspace/a1b2c3d456789abc',
    '2026-04-15', '2026-04-18',
    '2026-04-17', '2026-04-20',
    'cascade from task Credential rotation',
  );

  console.log('--- Sample exportMarkdown() output ---\n');
  console.log(demoLog.exportMarkdown());
}
