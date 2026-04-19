/**
 * roadmap-shape.js — Shared assembler for the viewer-contract roadmap shape.
 *
 * Extracted from get-roadmap.js so pull-from-notion.js (snapshot creation)
 * and the snapshot-read path produce payloads with the exact shape the
 * viewer expects. The shape mirrors the legacy data/roadmap.json contract.
 *
 * Exports:
 *   - slugify, phaseSlug, composeCustomClass (low-level helpers)
 *   - assembleRoadmapResponse({ project, mappingRow, phases, streams, tasks, deps, latestSync })
 *       → { source, schema_mapping, phase_palette, tasks: [viewer-shape rows] }
 */

'use strict';

function slugify(text) {
  if (!text) return '';
  let s = String(text).toLowerCase().trim();
  s = s.replace(/[^\w\s-]/g, '');
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

function phaseSlug(phaseName) {
  let slug = slugify(phaseName);
  if (slug.startsWith('phase-')) slug = slug.slice('phase-'.length);
  return slug;
}

function composeCustomClass(phase, critical, risk, milestone) {
  const parts = [];
  if (phase) parts.push(`phase-${phaseSlug(phase)}`);
  if (critical) parts.push('critical-path');
  if (risk && String(risk).toLowerCase() !== 'none') {
    parts.push(`risk-${String(risk).toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (milestone) parts.push('milestone');
  return parts.join(' ');
}

function assembleRoadmapResponse({ mappingRow, phases, streams, tasks, deps, latestSync }) {
  const phaseById = new Map();
  for (const p of phases || []) phaseById.set(p.id, p);
  const streamById = new Map();
  for (const s of streams || []) streamById.set(s.id, s);

  const depsByBlocked = new Map();
  for (const edge of deps || []) {
    const arr = depsByBlocked.get(edge.blocked_task_id) || [];
    arr.push(edge.blocker_task_id);
    depsByBlocked.set(edge.blocked_task_id, arr);
  }

  const taskRows = (tasks || []).map((t) => {
    const phase = phaseById.get(t.phase_id);
    const stream = streamById.get(t.stream_id);
    const phaseName = phase ? phase.name : '';
    const streamName = stream ? stream.name : null;
    const dependencies = (depsByBlocked.get(t.id) || []).join(',');
    const custom_class = composeCustomClass(
      phaseName,
      !!t.critical_path,
      t.risk_level || 'None',
      !!t.is_milestone,
    );
    return {
      id: t.id,
      name: t.name,
      start: t.start_date || '',
      end: t.end_date || '',
      progress: t.progress === null || t.progress === undefined ? 0 : Number(t.progress),
      dependencies,
      custom_class,
      meta: {
        phase: phaseName,
        stream: streamName,
        owner: t.owner_label || null,
        status: t.status || null,
        risk_level: t.risk_level || 'None',
        critical_path: !!t.critical_path,
        is_milestone: !!t.is_milestone,
        slack_days: t.slack_days === null || t.slack_days === undefined ? null : Number(t.slack_days),
        duration_days: t.duration_days === null || t.duration_days === undefined ? null : Number(t.duration_days),
        duration_text: t.duration_text || null,
        reference: t.reference || null,
        notes: t.notes || null,
        notion_url: t.notion_url || '',
        notion_page_id: t.notion_page_id || null,
        notion_sync_status: t.notion_sync_status || 'clean',
      },
    };
  });

  const mapping = mappingRow ? mappingRow.mapping || {} : {};
  const phasePalette = mappingRow ? mappingRow.phase_palette || {} : {};
  const notionDbId = mappingRow ? mappingRow.notion_db_id || '' : '';
  const cleanDbId = (notionDbId || '').replace(/-/g, '');
  const notionUrl = cleanDbId ? `https://www.notion.so/${cleanDbId}` : '';

  return {
    source: {
      notion_url: notionUrl,
      data_source_id: notionDbId ? `collection://${notionDbId}` : '',
      table_name: 'ROADMAP',
      synced_at: latestSync || null,
      row_count: taskRows.length,
    },
    schema_mapping: mapping,
    phase_palette: phasePalette,
    tasks: taskRows,
  };
}

module.exports = {
  slugify,
  phaseSlug,
  composeCustomClass,
  assembleRoadmapResponse,
};
