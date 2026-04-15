/**
 * PPGantt Cascade Unit Tests — tests/test_cascade.js
 *
 * Run with: node tests/test_cascade.js
 *
 * Uses Node's built-in `node:test` module (available in Node 18+).
 * All tests exercise simulatePush() from js/simulator.js.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const simulator = require(path.join(__dirname, '../js/simulator.js'));
const { simulatePush } = simulator;

// ---------------------------------------------------------------------------
// Fixture builder helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal task object matching the JSON contract.
 * @param {string} id
 * @param {string} start        ISO date
 * @param {string} end          ISO date
 * @param {string} dependencies Comma-separated task IDs
 * @param {number|null} slackDays
 * @returns {object}
 */
function makeTask(id, start, end, dependencies = '', slackDays = 0) {
  return {
    id,
    name: id,
    start,
    end,
    progress: 0,
    dependencies,
    custom_class: '',
    meta: {
      phase: 'Test',
      stream: 'Test',
      owner: 'Test',
      status: 'Not started',
      risk_level: 'None',
      critical_path: false,
      is_milestone: false,
      slack_days: slackDays,
      duration_days: 1,
      duration_text: '1 day',
      reference: '',
      notes: '',
      notion_url: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Simple chain A→B→C, no slack, push A by 3 days
// ---------------------------------------------------------------------------
test('1 - Simple chain A→B→C, no slack: B and C both move by 3', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', 0),
    makeTask('C', '2026-04-16', '2026-04-17', 'B', 0),
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 3);

  // Root task A moves by 3
  assert.equal(newSchedule.find(t => t.id === 'A').start, '2026-04-17');
  assert.equal(newSchedule.find(t => t.id === 'A').end,   '2026-04-18');
  assert.equal(pushAmounts.get('A'), 3);

  // B moves by 3
  assert.equal(newSchedule.find(t => t.id === 'B').start, '2026-04-18');
  assert.equal(newSchedule.find(t => t.id === 'B').end,   '2026-04-19');
  assert.equal(pushAmounts.get('B'), 3);

  // C moves by 3
  assert.equal(newSchedule.find(t => t.id === 'C').start, '2026-04-19');
  assert.equal(newSchedule.find(t => t.id === 'C').end,   '2026-04-20');
  assert.equal(pushAmounts.get('C'), 3);
});

// ---------------------------------------------------------------------------
// Test 2: Chain with full slack absorption — A→B, B.slack=3, push A by 2
// ---------------------------------------------------------------------------
test('2 - Slack absorption: B.slack=3, push A by 2 → B does NOT move', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-16', '2026-04-17', 'A', 3),
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 2);

  // A moves by 2
  assert.equal(newSchedule.find(t => t.id === 'A').start, '2026-04-16');
  assert.equal(pushAmounts.get('A'), 2);

  // B does NOT move (push 2 < slack 3)
  assert.equal(newSchedule.find(t => t.id === 'B').start, '2026-04-16');
  assert.equal(pushAmounts.has('B'), false);
});

// ---------------------------------------------------------------------------
// Test 3: Partial absorption — A→B, B.slack=2, push A by 5 → B moves by 3
// ---------------------------------------------------------------------------
test('3 - Partial absorption: B.slack=2, push A by 5 → B moves by 3', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-16', '2026-04-17', 'A', 2),
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 5);

  // A moves by 5
  assert.equal(pushAmounts.get('A'), 5);

  // B moves by 5 - 2 = 3
  const b = newSchedule.find(t => t.id === 'B');
  assert.equal(b.start, '2026-04-19');   // 2026-04-16 + 3
  assert.equal(b.end,   '2026-04-20');   // 2026-04-17 + 3
  assert.equal(pushAmounts.get('B'), 3);
});

// ---------------------------------------------------------------------------
// Test 4: Diamond dependency A→B, A→C, B→D, C→D
//   push A by 4, B.slack=1, C.slack=0
//   → D moves by max(4-1, 4-0) = max(3, 4) = 4
// ---------------------------------------------------------------------------
test('4 - Diamond: D moves by max push from B and C', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',    0),
    makeTask('B', '2026-04-15', '2026-04-17', 'A',   1),
    makeTask('C', '2026-04-15', '2026-04-17', 'A',   0),
    makeTask('D', '2026-04-18', '2026-04-20', 'B,C', 0),
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 4);

  // A pushed by 4
  assert.equal(pushAmounts.get('A'), 4);

  // B: effectivePush = max(0, 4 - 1) = 3
  assert.equal(pushAmounts.get('B'), 3);

  // C: effectivePush = max(0, 4 - 0) = 4
  assert.equal(pushAmounts.get('C'), 4);

  // D: max(B's push of 3, C's push of 4) = 4 (after D's own slack of 0)
  // D.slack = 0 → effectivePush from B = max(0, 3-0) = 3; from C = max(0, 4-0) = 4 → takes 4
  assert.equal(pushAmounts.get('D'), 4);

  const d = newSchedule.find(t => t.id === 'D');
  assert.equal(d.start, '2026-04-22');  // 2026-04-18 + 4
  assert.equal(d.end,   '2026-04-24');  // 2026-04-20 + 4
});

// ---------------------------------------------------------------------------
// Test 5: Circular dependency detection — A→B→A throws an Error
// ---------------------------------------------------------------------------
test('5 - Circular dependency throws Error', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', 'B', 0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', 0),
  ];

  assert.throws(
    () => simulatePush(tasks, 'A', 2),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.toLowerCase().includes('cycle') ||
        err.message.toLowerCase().includes('circular'),
        `Expected cycle/circular in message: "${err.message}"`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Test 6: Missing slack_days treated as 0 (push fully)
// ---------------------------------------------------------------------------
test('6 - Missing slack_days treated as 0: B moves by full push', () => {
  // Manually set slack_days to undefined to simulate missing field
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', null), // null → treated as 0
  ];
  // Also test explicitly undefined
  tasks[1].meta.slack_days = undefined;

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 2);

  assert.equal(pushAmounts.get('A'), 2);
  assert.equal(pushAmounts.get('B'), 2);
  assert.equal(newSchedule.find(t => t.id === 'B').start, '2026-04-17');
});

// ---------------------------------------------------------------------------
// Test 7: Negative slack clamped to 0 — B moves by full push
// ---------------------------------------------------------------------------
test('7 - Negative slack clamped to 0: B moves by full push', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',   0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', -3), // negative slack
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'A', 2);

  // Negative slack is clamped to 0 → effectivePush = max(0, 2 - max(0,-3)) = max(0, 2-0) = 2
  assert.equal(pushAmounts.get('A'), 2);
  assert.equal(pushAmounts.get('B'), 2);
  assert.equal(newSchedule.find(t => t.id === 'B').start, '2026-04-17');
});

// ---------------------------------------------------------------------------
// Test 8: Predecessors not affected — push middle task, upstream unchanged
// ---------------------------------------------------------------------------
test('8 - Predecessors unchanged: push B, A must not move', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', 0), // B depends on A
    makeTask('C', '2026-04-16', '2026-04-17', 'B', 0),
  ];

  const { newSchedule, pushAmounts } = simulatePush(tasks, 'B', 3);

  // A (predecessor of B) must NOT move
  const a = newSchedule.find(t => t.id === 'A');
  assert.equal(a.start, '2026-04-14', 'A.start should be unchanged');
  assert.equal(a.end,   '2026-04-15', 'A.end should be unchanged');
  assert.equal(pushAmounts.has('A'), false, 'A should not be in pushAmounts');

  // B (root of push) moves by 3
  assert.equal(pushAmounts.get('B'), 3);
  assert.equal(newSchedule.find(t => t.id === 'B').start, '2026-04-18');

  // C (downstream of B) moves by 3
  assert.equal(pushAmounts.get('C'), 3);
  assert.equal(newSchedule.find(t => t.id === 'C').start, '2026-04-19');
});

// ---------------------------------------------------------------------------
// Bonus: Non-destructive check — original tasks array must not be mutated
// ---------------------------------------------------------------------------
test('Bonus - Non-destructive: original tasks array is not mutated', () => {
  const tasks = [
    makeTask('A', '2026-04-14', '2026-04-15', '',  0),
    makeTask('B', '2026-04-15', '2026-04-16', 'A', 0),
  ];
  const origStartA = tasks[0].start;
  const origStartB = tasks[1].start;

  simulatePush(tasks, 'A', 5);

  assert.equal(tasks[0].start, origStartA, 'Original A.start must not be mutated');
  assert.equal(tasks[1].start, origStartB, 'Original B.start must not be mutated');
});
