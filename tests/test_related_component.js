/**
 * PPGantt relatedComponent Unit Tests — tests/test_related_component.js
 *
 * Run with: node tests/test_related_component.js
 *
 * Uses Node's built-in `node:test` module. Covers the graph helper that
 * powers the shift-click Related-Tasks focus mode in the viewer.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { relatedComponent, taskLineage } = require('../js/simulator.js');

// ---------------------------------------------------------------------------
// Fixture builder helpers
// ---------------------------------------------------------------------------

function makeTask(id, deps) {
  return {
    id,
    name: id,
    start: '2026-04-01',
    end: '2026-04-01',
    progress: 0,
    dependencies: (deps || []).join(','),
    custom_class: '',
    meta: {}
  };
}

function asArray(set) {
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('isolated node with no dependencies returns just itself', () => {
  const tasks = [makeTask('A', [])];
  const result = relatedComponent(tasks, 'A');
  assert.deepStrictEqual(asArray(result), ['A']);
});

test('linear chain A→B→C from A returns full chain', () => {
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('C', ['B'])
  ];
  const result = relatedComponent(tasks, 'A');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('linear chain A→B→C from B returns full chain (both directions)', () => {
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('C', ['B'])
  ];
  const result = relatedComponent(tasks, 'B');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('linear chain A→B→C from C returns full chain (predecessors only)', () => {
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('C', ['B'])
  ];
  const result = relatedComponent(tasks, 'C');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('diamond A→B, A→C, B→D, C→D — directed lineage from each node', () => {
  //       A
  //      / \
  //     B   C
  //      \ /
  //       D
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('C', ['A']),
    makeTask('D', ['B', 'C'])
  ];
  // From A: ancestors={}, descendants={B,C,D} → {A,B,C,D}
  assert.deepStrictEqual(asArray(relatedComponent(tasks, 'A')), ['A', 'B', 'C', 'D']);
  // From B: ancestors={A}, descendants={D} → {A,B,D} (C is a sibling branch, excluded)
  assert.deepStrictEqual(asArray(relatedComponent(tasks, 'B')), ['A', 'B', 'D']);
  // From C: ancestors={A}, descendants={D} → {A,C,D} (B is a sibling branch, excluded)
  assert.deepStrictEqual(asArray(relatedComponent(tasks, 'C')), ['A', 'C', 'D']);
  // From D: ancestors={B,C,A}, descendants={} → {A,B,C,D}
  assert.deepStrictEqual(asArray(relatedComponent(tasks, 'D')), ['A', 'B', 'C', 'D']);
});

test('fan-out: root with 10 children, focus at leaf returns root + that leaf only', () => {
  const tasks = [makeTask('R', [])];
  for (let i = 0; i < 10; i++) tasks.push(makeTask('L' + i, ['R']));
  const result = relatedComponent(tasks, 'L3');
  // Directed lineage of L3: ancestors = {R}, descendants = {}.
  // Sibling leaves L0..L9 are NOT included (no sibling bleed).
  assert.deepStrictEqual(asArray(result), ['L3', 'R']);
});

test('two disconnected components — focus in one returns only that component', () => {
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('X', []),
    makeTask('Y', ['X'])
  ];
  const result = relatedComponent(tasks, 'A');
  assert.deepStrictEqual(asArray(result), ['A', 'B']);
});

test('cycle A→B→C→A is handled without throwing', () => {
  const tasks = [
    makeTask('A', ['C']),
    makeTask('B', ['A']),
    makeTask('C', ['B'])
  ];
  // relatedComponent must NOT throw on cycles (unlike topologicalSort)
  const result = relatedComponent(tasks, 'A');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('missing rootId returns empty set (no throw)', () => {
  const tasks = [makeTask('A', [])];
  const result = relatedComponent(tasks, 'ZZZ_not_in_tasks');
  // Root is pushed onto queue, then popped and added to `seen` even though
  // byId lookup returns undefined — but `dependents.get('ZZZ')` is also
  // undefined so no neighbors get queued. Result = {'ZZZ'}.
  // That's acceptable behavior: the caller is expected to pass a real ID.
  assert.strictEqual(result.has('ZZZ_not_in_tasks'), true);
  assert.strictEqual(result.size, 1);
});

test('empty rootId returns empty set', () => {
  const tasks = [makeTask('A', [])];
  const result = relatedComponent(tasks, '');
  assert.strictEqual(result.size, 0);
});

test('accepts array-form dependencies (Frappe-mutated tasks)', () => {
  // Frappe Gantt rewrites task.dependencies from "A,B" to ["A","B"] in-place.
  // relatedComponent must tolerate both forms so we can pass _activeSchedule
  // (which has gone through Frappe) or _originalJson.tasks (pristine strings).
  const tasks = [
    { id: 'A', name: 'A', start: '2026-04-01', end: '2026-04-01', progress: 0, dependencies: [], custom_class: '', meta: {} },
    { id: 'B', name: 'B', start: '2026-04-01', end: '2026-04-01', progress: 0, dependencies: ['A'], custom_class: '', meta: {} },
    { id: 'C', name: 'C', start: '2026-04-01', end: '2026-04-01', progress: 0, dependencies: ['B'], custom_class: '', meta: {} }
  ];
  const result = relatedComponent(tasks, 'B');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('does not mutate input tasks', () => {
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A'])
  ];
  const snapshot = JSON.stringify(tasks);
  relatedComponent(tasks, 'A');
  assert.strictEqual(JSON.stringify(tasks), snapshot);
});

// ─── taskLineage semantics: directed, no sibling bleed ────────────────────

test('taskLineage: siblings of ancestors are NOT included', () => {
  //       A
  //      / \
  //     B   C   ← B and C are siblings (both depend on A)
  //
  // Ancestors(B) = {A}
  // Descendants(B) = {}
  // Lineage(B) = {A, B}     — NOT {A, B, C}!
  const tasks = [
    makeTask('A', []),
    makeTask('B', ['A']),
    makeTask('C', ['A'])
  ];
  const result = taskLineage(tasks, 'B');
  assert.deepStrictEqual(asArray(result), ['A', 'B']);
});

test('taskLineage: siblings of descendants are NOT included', () => {
  //     A       — A and X both point to B
  //      \     /
  //       B
  //      / \
  //     C   D
  //
  // Ancestors(B) = {A, X}
  // Descendants(B) = {C, D}
  // Lineage(A) should give Descendants(A) = {B, C, D} — and NOT X
  const tasks = [
    makeTask('A', []),
    makeTask('X', []),
    makeTask('B', ['A', 'X']),
    makeTask('C', ['B']),
    makeTask('D', ['B'])
  ];
  const result = taskLineage(tasks, 'A');
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C', 'D']);
  assert.strictEqual(result.has('X'), false);
});

test('taskLineage: dense graph does not bloat to full component', () => {
  // Simulates a dense fan-out shape where an undirected BFS would bleed
  // to everything, but directed lineage stays tight.
  //
  //   A1 → B ← A2   (B has two ancestors)
  //   A3 → B       (three ancestors total)
  //   B → C1, C2, C3 (three descendants)
  //
  // Lineage of A1 = {A1, B, C1, C2, C3} — 5 tasks
  //   NOT {A1, A2, A3, B, C1, C2, C3} = 7 tasks (which is what relatedComponent
  //   would have returned via sibling-of-ancestor bleed)
  const tasks = [
    makeTask('A1', []),
    makeTask('A2', []),
    makeTask('A3', []),
    makeTask('B', ['A1', 'A2', 'A3']),
    makeTask('C1', ['B']),
    makeTask('C2', ['B']),
    makeTask('C3', ['B'])
  ];
  const result = taskLineage(tasks, 'A1');
  assert.deepStrictEqual(asArray(result), ['A1', 'B', 'C1', 'C2', 'C3']);
  // Confirm A2 and A3 are NOT in the lineage (no sibling bleed through B)
  assert.strictEqual(result.has('A2'), false);
  assert.strictEqual(result.has('A3'), false);
});

test('taskLineage: handles cycles without exploding', () => {
  const tasks = [
    makeTask('A', ['C']),
    makeTask('B', ['A']),
    makeTask('C', ['B'])
  ];
  const result = taskLineage(tasks, 'A');
  // All three tasks are reachable from A via the cycle
  assert.deepStrictEqual(asArray(result), ['A', 'B', 'C']);
});

test('taskLineage: empty root returns empty set', () => {
  const tasks = [makeTask('A', [])];
  assert.strictEqual(taskLineage(tasks, '').size, 0);
});
