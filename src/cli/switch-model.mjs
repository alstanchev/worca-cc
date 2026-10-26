// src/cli/switch-model.mjs
// `worca switch-model` — change a running or paused run's remaining stages' models (this run only), or
// the agent picks of a scheduled run (a one-off ticket, or a repeating series by its sch_ id) before it starts.
// Talks to the store, never to the UI server (control.mjs's rule): a paused run is one conditional
// write; a running run is asked through its run-control mailbox, so this works whichever process
// drives it (model-switch.mjs switchRunModels); a scheduled run is a store edit of its stored
// request (schedule-models.mjs switchScheduledModels).

import { getDb } from '../core/db.mjs';
import { cliProjectDirFor } from './control.mjs';
import { engineLabel } from '../shared/engine-switch.mjs';
import { formatInstant } from '../shared/schedule/recurrence.mjs';

export const SWITCH_HELP = `worca switch-model — change the models of a scheduled, running or paused run (this run only)

Usage:
  worca switch-model <id>                       List the run's stages, their state and models
  worca switch-model <id> --stage <stage> [--model <m>] [--effort <e>]
                          [--subagent-model <m>] [--subagent-effort <e>]
  worca switch-model <id> --all --model <m> [...]
                                                Apply to every stage that can still switch
  --json                                        Machine-readable output

<id> is a run id, a scheduled run's id, or a repeating schedule's sch_ id (any unique prefix).
<stage> is a node id (n_refine) or an agent key (refiner) when only one stage uses it.
Pass "default" to clear a field back to the run default. Efforts depend on the run's engine
(Claude: medium–max, Codex: minimal–high, Copilot: none–max, Cursor: none); an effort the engine
does not offer is refused. With --model and no --effort, a stage keeps its effort only if the new
model offers it.
Sub-agent settings depend on the engine too: Claude takes a sub-agent model (sonnet, opus, fable,
auto, inherit) and effort (medium–max); Codex only a sub-agent effort of medium or high; Copilot and
Cursor neither.

A stage can switch unless it is running right now or finished for good. A loop stage that
already ran can switch while its loop is still going; its next cycle uses the new model.

Running run: the process that drives it applies the change; each switched stage uses its new
model when it starts, and a stage that started meanwhile is skipped and reported. The run never
pauses.
Paused run: a stage whose model changed starts a fresh session when you resume:
  worca resume <id>
Scheduled run (a one-off run, or a repeating schedule by its sch_ id): every stage can change before
the run starts. --model, --effort and --subagent-model only ("default" clears a pick back to the
project's setting). A repeating schedule's change also updates the runs it already queued, and a
schedule that follows a run preset keeps these picks instead of the preset's. One run of a repeating
schedule is changed through its sch_ id.
`;

const FLAG_FIELDS = Object.freeze({
  '--model': 'model', '--effort': 'effort', '--subagent-model': 'subagentModel', '--subagent-effort': 'subagentEffort',
});

/** Hand-parsed like the other verbs (no argument library in this CLI). */
export function parseSwitchArgs(argv) {
  const out = { ref: null, stage: null, all: false, json: false, change: {}, unknown: [], missing: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--stage' || Object.hasOwn(FLAG_FIELDS, a)) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { out.missing.push(a); continue; }
      i += 1;
      if (a === '--stage') out.stage = v;
      else out.change[FLAG_FIELDS[a]] = v === 'default' ? '' : v;
    } else if (a.startsWith('-')) out.unknown.push(a);
    else if (!out.ref) out.ref = a;
    else out.unknown.push(a);
  }
  return out;
}

/** A node id, else a UNIQUE agent key. */
function resolveStage(stages, sel, fail) {
  const exact = stages.find((s) => s.nodeId === sel);
  if (exact) return exact;
  const byKey = stages.filter((s) => s.key === sel);
  if (byKey.length === 1) return byKey[0];
  if (byKey.length > 1) fail(`"${sel}" names ${byKey.length} stages — pass a node id: ${byKey.map((s) => s.nodeId).join(', ')}`);
  fail(`no stage "${sel}" in this run (see: worca switch-model <id>)`);
  return null;
}

function refusal(msg) {
  process.stderr.write(`worca: ${msg}\n`);
  return 1;
}

function printStages(info, { out, c }) {
  const tail = info.status === 'running' ? '— running' : `— paused${info.pauseReason ? ` (${info.pauseReason})` : ''}`;
  out(`${c('bold', info.title || info.pipelineId)} ${c('gray', tail)}`);
  out(`Engine: ${engineLabel(info.engine)}`);
  if (info.modelForAll) {
    out(c('yellow', `Resumed with ${info.modelForAll} for every remaining stage — per-stage models and efforts do not apply.`));
  }
  const rows = [['STAGE', 'NODE', 'STATE', 'MODEL', 'EFFORT', 'SUBS', 'SUBS EFFORT']];
  for (const s of info.stages) {
    rows.push([s.key || s.label, s.nodeId, s.state, s.model || 'default', s.effort || '—',
      s.fanOut ? (s.subagentModel || 'default') : '—', s.fanOut ? (s.subagentEffort || '—') : '—']);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) out('  ' + r.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd());
}

/** One stage's change. `--model` without `--effort`: a stored effort the new model does not offer on this
 *  run's engine (the describe payload's engine-scoped `models[].efforts`) is cleared — the Models panel's
 *  reconcileEffort rule — so the pair stays valid. An explicit `--effort` is sent as given (the run checks it). */
export function stageChange(stage, change, models) {
  if (!('model' in change) || 'effort' in change || !stage.effort) return { ...change };
  const offered = (models || []).find((m) => m.id === change.model)?.efforts || [];
  return offered.includes(stage.effort) ? { ...change } : { ...change, effort: '' };
}

const LIKE = (q) => `${q.replace(/[\\%_]/g, '\\$&')}%`;
/**
 * What `<id>` names: a pipeline (resolveRunRef's prefix rule), a waiting ticket (scheduled or missed, by prefix) or a
 * series (a sch_ prefix; any status — an ended one gets the core's refusal). An exact id wins outright; otherwise more
 * than one kind, or more than one hit, is refused. @returns {{kind:'run'|'once'|'recurring', id:string}}
 */
export function resolveSwitchRef(ref, fail) {
  const q = String(ref || '').trim();
  if (!q) fail('a run id is required (see: worca runs list)');
  const db = getDb();
  const pick = (sql, kind) => db.prepare(sql).all(LIKE(q)).map((r) => ({ kind, id: r.id }));
  const hits = [
    ...pick("SELECT id FROM pipelines WHERE id LIKE ? ESCAPE '\\' LIMIT 21", 'run'),
    ...pick("SELECT id FROM scheduled_runs WHERE id LIKE ? ESCAPE '\\' AND status IN ('scheduled', 'missed') LIMIT 21", 'once'),
    ...(q.startsWith('sch_') ? pick("SELECT id FROM schedules WHERE id LIKE ? ESCAPE '\\' LIMIT 21", 'recurring') : []),
  ];
  const exact = hits.find((h) => h.id === q);
  if (exact) return exact;
  // A series is looked up by its sch_ form only: without it, its 8 hex digits read like a pipeline id.
  if (!hits.length) fail(`no run matches "${q}" (see: worca runs list, worca schedule list${q.startsWith('sch_') ? '' : '; a repeating schedule is named by its sch_ id'})`);
  if (new Set(hits.map((h) => h.kind)).size > 1) fail(`"${q}" matches a run and a scheduled run — use a longer id`);
  if (hits.length > 1) {
    const n = hits.length > 20 ? 'more than 20' : hits.length;
    fail(`"${q}" matches ${n} ${{ run: 'runs', once: 'scheduled runs', recurring: 'schedules' }[hits[0].kind]} — use a longer id`);
  }
  return hits[0];
}

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The header's tail: "— scheduled, starts …", "— missed, was due …", "— waiting for ‘…’", "— repeating schedule, …". */
function scheduledTail(info) {
  if (info.kind === 'recurring') return `— repeating schedule${info.itemStatus === 'paused' ? ' (paused)' : ''}, ${info.sentence || ''}`.trimEnd();
  if (info.afterTitle) return `— waiting for ‘${info.afterTitle}’`;
  const when = info.startsAt ? formatInstant(Date.parse(info.startsAt), localTz(), { withYear: true }) : '—';
  return info.itemStatus === 'missed' ? `— missed, was due ${when}` : `— scheduled, starts ${when}`;
}

function printScheduled(info, { out, c }) {
  out(`${c('bold', info.title || info.id)} ${c('gray', scheduledTail(info))}`);
  out(`Engine: ${engineLabel(info.engine)}`);
  if (info.preset && !info.preset.missing) out(c('yellow', `Follows run preset ${info.preset.name}; agent picks here override it.`));
  if (info.pendingTickets) out(`A change also updates ${info.pendingTickets} waiting run${info.pendingTickets === 1 ? '' : 's'}.`);
  // A stage with no pick shows its project default, dimmed: widths are measured on the plain text, colour comes after.
  const rows = [['STAGE', 'NODE', 'STATE', 'MODEL', 'EFFORT', 'SUBS'].map((t) => ({ t }))];
  for (const s of info.stages) {
    const d = s.projectDefault;
    const own = !!(s.model || s.effort);
    rows.push([
      { t: s.key || s.label }, { t: s.nodeId }, { t: s.state },
      own ? { t: s.model || 'default' } : { t: d && d.model ? `${d.model} (project)` : 'default', dim: true },
      own ? { t: s.effort || '—' } : { t: d && d.model && d.effort ? d.effort : '—', dim: true },
      { t: s.fanOut ? (s.subagentModel || 'default') : '—' },
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].t.length)));
  for (const r of rows) out(`  ${r.map((cell, i) => (cell.dim ? c('gray', cell.t.padEnd(widths[i])) : cell.t.padEnd(widths[i]))).join('  ')}`.trimEnd());
}

/** A scheduled target (schedule-models.mjs): list, or change and print what changed. @returns {Promise<number>} exit code */
async function cmdSwitchScheduled(ref, a, hasChange, { out, c, fail }) {
  if ('subagentEffort' in a.change) fail('a scheduled run stores no sub-agent effort — use --model, --effort or --subagent-model');
  const { describeScheduledModels, switchScheduledModels, scheduledPickText } = await import('../core/schedule-models.mjs');
  const { ModelSwitchError } = await import('../core/model-switch.mjs');
  try {
    const info = await describeScheduledModels(ref.id);
    if (!hasChange) {
      if (a.json) out(JSON.stringify(info, null, 2)); else printScheduled(info, { out, c });
      return 0;
    }
    const targets = a.all ? info.stages : [resolveStage(info.stages, a.stage, fail)];
    if (!targets.length) return refusal(`${info.title || ref.id} has no agent stage to switch`);   // every scheduled stage is switchable; a workflow without agent nodes
    const changes = Object.fromEntries(targets.map((s) => [s.nodeId, stageChange(s, a.change, info.models)]));
    const res = await switchScheduledModels(ref.id, { changes, by: 'local' });
    if (a.json) {
      out(JSON.stringify({ id: res.id, kind: res.kind, changed: res.changed, warnings: res.warnings, pendingTickets: res.pendingTickets }, null, 2));
      return 0;
    }
    if (!res.changed.length) out(c('gray', 'Nothing changed — the stages already use that selection.'));
    for (const ch of res.changed) {
      out(`${c('green', 'Changed')} ${c('bold', ch.label)} ${c('gray', `(${ch.nodeId})`)}: ${scheduledPickText(ch.before, info.models)} → ${scheduledPickText(ch.after, info.models)}`);
    }
    if (res.changed.length && res.pendingTickets) out(`Also updated ${res.pendingTickets} waiting run${res.pendingTickets === 1 ? '' : 's'}.`);
    for (const w of res.warnings) out(c('yellow', w));
    return 0;
  } catch (err) {
    if (!(err instanceof ModelSwitchError)) throw err;
    if (a.json) { out(JSON.stringify({ id: ref.id, error: err.message, code: err.code }, null, 2)); return 1; }
    return refusal(err.message);
  }
}

const switchedLine = (ch, c) => `${c('green', 'Switched')} ${c('bold', ch.label)} ${c('gray', `(${ch.nodeId})`)}: ${ch.before.model || 'default'} → ${ch.after.model || 'default'}`;

/** A running run's answer (or the lack of one). @returns {number} exit code */
function printLive(id, res, { json }, { out, c }) {
  if (!res.ok) {
    const notApplied = res.outcome === 'not-applied';
    if (json) { out(JSON.stringify({ id, outcome: res.outcome, status: res.runStatus }, null, 2)); return notApplied ? 1 : 0; }
    if (notApplied) return refusal(`run ${id} is "${res.runStatus}" now — nothing was switched (see: worca switch-model ${id})`);
    out(c('yellow', res.outcome === 'received'
      ? `Switch received — the run has not confirmed it yet (check: worca switch-model ${id})`
      : `Switch sent — the run has not picked it up yet (check: worca switch-model ${id})`));
    return 0;
  }
  if (json) {
    out(JSON.stringify({ id, outcome: 'switched', changed: res.changed, skipped: res.skipped, warnings: res.warnings }, null, 2));
    return 0;
  }
  if (!res.changed.length && !res.skipped.length) out(c('gray', 'Nothing changed — the stages already use that selection.'));
  for (const ch of res.changed) out(switchedLine(ch, c));
  for (const s of res.skipped) {
    out(`${c('yellow', 'Skipped')} ${c('bold', s.label)} ${c('gray', `(${s.nodeId})`)}: ${s.reason === 'running' ? 'already running — it keeps its model' : 'already completed'}`);
  }
  for (const w of res.warnings) out(c('yellow', w));
  return 0;
}

/** @returns {Promise<number>} exit code */
export async function cmdSwitchModel(argv, { out, c, fail }) {
  if (['help', '--help', '-h'].includes(argv[0])) { process.stdout.write(SWITCH_HELP); return 0; }
  const a = parseSwitchArgs(argv);
  if (a.unknown.length) fail(`unknown option(s): ${a.unknown.join(' ')} — see: worca switch-model help`);
  if (a.missing.length) fail(`${a.missing.join(', ')} needs a value — see: worca switch-model help`);
  if (!a.ref) fail('a run id is required (see: worca runs list)');
  const hasChange = Object.keys(a.change).length > 0;
  if (a.stage && a.all) fail('--stage and --all cannot be combined');
  if (hasChange && !a.stage && !a.all) fail('name the stage to change: --stage <stage> or --all');
  if (!hasChange && (a.stage || a.all)) fail('name what to change: --model, --effort, --subagent-model or --subagent-effort');
  const ref = resolveSwitchRef(a.ref, fail);
  if (ref.kind !== 'run') return cmdSwitchScheduled(ref, a, hasChange, { out, c, fail });
  const id = ref.id;

  const { describeModelSwitch, switchRunModels, ModelSwitchError } = await import('../core/model-switch.mjs');
  try {
    const info = await describeModelSwitch(id, { projectDirFor: cliProjectDirFor });
    if (!hasChange) {
      if (a.json) out(JSON.stringify(info, null, 2)); else printStages(info, { out, c });
      return 0;
    }
    const targets = a.all ? info.stages.filter((s) => s.switchable) : [resolveStage(info.stages, a.stage, fail)];
    if (!targets.length) return refusal(`run ${id} has no stage left to switch`);
    const changes = Object.fromEntries(targets.map((s) => [s.nodeId, stageChange(s, a.change, info.models)]));
    const res = await switchRunModels(id, { changes, by: 'local', projectDirFor: cliProjectDirFor });
    if (res.mode === 'running') return printLive(id, res, a, { out, c });
    if (a.json) { out(JSON.stringify({ id, changed: res.changed, warnings: res.warnings }, null, 2)); return 0; }
    if (!res.changed.length) out(c('gray', 'Nothing changed — the stages already use that selection.'));
    for (const ch of res.changed) out(switchedLine(ch, c));
    for (const w of res.warnings) out(c('yellow', w));
    if (res.changed.length) out(c('gray', `Resume with: worca resume ${id}`));
    return 0;
  } catch (err) {
    if (!(err instanceof ModelSwitchError)) throw err;
    if (a.json) { out(JSON.stringify({ id, error: err.message, code: err.code }, null, 2)); return 1; }
    return refusal(err.message);
  }
}
