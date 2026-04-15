'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ChangeLog,
  buildScheduleDiffEvents,
} = require(path.join(__dirname, '../js/change-log.js'));

function makeTask(id, name, start, end, notionUrl) {
  return {
    id,
    name,
    start,
    end,
    meta: {
      notion_url: notionUrl || '',
    },
  };
}

test('buildScheduleDiffEvents marks root push and cascades from visible schedule diff', () => {
  const original = [
    makeTask('A', 'Root task', '2026-04-10', '2026-04-12', 'https://notion.so/root'),
    makeTask('B', 'Dependent task', '2026-04-13', '2026-04-14', 'https://notion.so/dependent'),
    makeTask('C', 'Unchanged task', '2026-04-15', '2026-04-16', 'https://notion.so/unchanged'),
  ];
  const current = [
    makeTask('A', 'Root task', '2026-04-12', '2026-04-14', 'https://notion.so/root'),
    makeTask('B', 'Dependent task', '2026-04-15', '2026-04-16', 'https://notion.so/dependent'),
    makeTask('C', 'Unchanged task', '2026-04-15', '2026-04-16', 'https://notion.so/unchanged'),
  ];

  const events = buildScheduleDiffEvents(original, current, {
    rootTaskId: 'A',
    rootTaskName: 'Root task',
    pushAmounts: { A: 2, B: 2 },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].taskId, 'A');
  assert.equal(events[0].reason, 'user push');
  assert.equal(events[1].taskId, 'B');
  assert.equal(events[1].reason, 'cascade from task Root task');
});

test('replaceEvents rebuilds export output from diff events', () => {
  const log = new ChangeLog({
    table_name: 'Test Table',
    notion_url: 'https://notion.so/table',
    synced_at: '2026-04-09T10:00:00Z',
  });

  log.replaceEvents([
    {
      taskId: 'A',
      taskName: 'Root task',
      taskNotionUrl: 'https://notion.so/root',
      originalStart: '2026-04-10',
      originalEnd: '2026-04-12',
      newStart: '2026-04-12',
      newEnd: '2026-04-14',
      reason: 'user push',
    },
    {
      taskId: 'B',
      taskName: 'Dependent task',
      taskNotionUrl: 'https://notion.so/dependent',
      originalStart: '2026-04-13',
      originalEnd: '2026-04-14',
      newStart: '2026-04-15',
      newEnd: '2026-04-16',
      reason: 'cascade from task Root task',
    },
  ]);

  const markdown = log.exportMarkdown();
  assert.ok(markdown.includes('Task "Root task"'));
  assert.ok(markdown.includes('Task "Dependent task"'));
  assert.ok(markdown.includes('Reason: cascade from task Root task'));
});
