// src/core/schedule-models.mjs
// Models… on a SCHEDULED run (plans/scheduled-run-models-design.md): the model, effort and sub-agent model of the agent
// stages of a one-off ticket, or of a repeating series and the waiting tickets it already materialized, changed before
// it fires. A ticket fires its stored request (fireTicket → startRunHandler with `internal`, which skips the overlay
// check), so the edit is a store edit of `request.overlay.nodes`, checked here as POST /api/run checks a pick: the
// run route's gate for the workflow (assertRunnableWorkflow), its shape pass (parseOverlayNodes) and its catalog pass
// (checkRunOverlay) against the engine the start resolves. ONE module behind GET/POST /api/schedules/:id/models, the
// Schedules page's Models panel and `worca switch-model <ticket | sch_id>`.
//  - A series edit rewrites schedules.request and its waiting tickets IN PLACE (scheduler.mjs rewriteSeriesRequest):
//    the occurrence keeps its id and attempts. An occurrence alone is refused — its series owns the picks.
//  - A preset follower is edited on its EFFECTIVE request (the preset's current setup, as fireTicket builds it) and
//    stored with 'overlay' in internal.presetOverrides, so bodyFollowingPreset keeps the edit at fire time.
//  - Refusals are ModelSwitchError (model-switch.mjs): the server, the CLI and the panel reuse their handling.
import { getTicket, getSchedule, afterRefOf, updateTicketRequest, rewriteSeriesRequest, editableSeriesTickets } from './scheduler.mjs';
import {
  ModelSwitchError, engineCatalog, effortsOfEngine, engineHasSubagents, subagentModelsOf, stageChangeError, modelSwitchWarnings,
} from './model-switch.mjs';
import { parseOverlayNodes, checkRunOverlay, overlayWorkflowRefusal, OVERLAY_ERRORS, OVERLAY_KEYS } from './run-overlay.mjs';
import { assertRunnableWorkflow, resolveGraph } from './workflows.mjs';
import { loadAgentRegistry } from './agent-registry.mjs';
import { listModels } from './config.mjs';
import { resolveRunEngine } from './settings-cascade.mjs';
import { selectRunEngine } from './engines/index.mjs';
import { resolveShapeRequest } from './shape/run.mjs';
import { AUTO_WORKFLOW_ID, WORKSPACE_SCAN_WORKFLOW_ID } from './graph/builtin-workflows.mjs';
import { readPreset } from './run-presets-store.mjs';
import { addNotification } from './notifications.mjs';
import { byActor } from './identity.mjs';
import { bodyFollowingPreset, nodeLabel } from '../shared/run-presets.mjs';

/** The fields a scheduled pick stores (D6): the overlay's node keys the run card's lane sends. No sub-agent effort. */
export const SCHEDULED_FIELDS = Object.freeze(['model', 'effort', 'subagentModel']);
const TICKET_EDITABLE = ['scheduled', 'missed'];
const MAX_VALUE = 200;   // parseOverlayNodes' model bound: a value never echoes whole into an error

const str = (v) => (typeof v === 'string' ? v : '');
const pickOf = (sel) => Object.fromEntries(SCHEDULED_FIELDS.map((f) => [f, str(sel?.[f])]));
const hasPick = (sel) => SCHEDULED_FIELDS.some((f) => str(sel?.[f]));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const overlayNodes = (overlay) => (isObj(overlay) && isObj(overlay.nodes) ? overlay.nodes : {});
const overlayWires = (overlay) => (isObj(overlay) && isObj(overlay.wires) ? overlay.wires : {});

/** "Opus 5.5 · high", "project default", plus ", sub-agents opus" — a pick as the feed, the CLI and `schedule show` word it. */
export function scheduledPickText(pick, models = []) {
  const model = str(pick?.model);
  const label = model ? ((models || []).find((m) => m.id === model)?.label || model) : '';
  const main = label ? `${label}${str(pick?.effort) ? ` · ${pick.effort}` : ''}` : 'project default';
  return str(pick?.subagentModel) ? `${main}, sub-agents ${pick.subagentModel}` : main;
}

/** The ticket or series behind `id` (findScheduleItem's rule: a sch_ prefix names a series, else a ticket by exact id)
 *  with its stored request — or the refusal that says why its models cannot change. */
function loadItem(id) {
  const ref = typeof id === 'string' ? id.trim() : '';
  if (!ref) throw new ModelSwitchError('BAD_REQUEST', 'an id is required', 400);
  if (ref.startsWith('sch_')) {
    const s = getSchedule(ref, { withRequest: true });
    if (!s) throw new ModelSwitchError('NOT_FOUND', 'schedule not found', 404);
    if (s.status === 'ended') throw new ModelSwitchError('NOT_SCHEDULABLE', 'this repeating schedule has ended — it starts no more runs');
    return { kind: 'recurring', item: s };
  }
  const t = getTicket(ref, { withRequest: true });
  if (!t) throw new ModelSwitchError('NOT_FOUND', 'schedule not found', 404);
  if (!TICKET_EDITABLE.includes(t.status)) {
    throw new ModelSwitchError('NOT_SCHEDULABLE', `this scheduled run is ${t.status} — its models can change only while it waits to start`);
  }
  if (t.scheduleId) {
    throw new ModelSwitchError('OCCURRENCE', `this is a run of the repeating schedule ${t.scheduleId} and cannot be changed on its own. `
      + `Change the schedule's models (worca switch-model ${t.scheduleId}); that updates this run too`, 400);
  }
  if (t.resumePipelineId) {
    throw new ModelSwitchError('RESUME_TICKET', `this schedule resumes run ${t.resumePipelineId} — switch that run's models (worca switch-model ${t.resumePipelineId})`);
  }
  if (t.ownerPid != null) throw new ModelSwitchError('HELD_BY_TERMINAL', 'held by a waiting terminal, which starts the run with its own setup');
  return { kind: 'once', item: t };
}

/** The request the run would start from: the stored one, or — for a preset follower — the preset's CURRENT setup over it,
 *  as fireTicket builds it (keep = internal.presetOverrides), minus the presetId that body carries (a stored request
 *  never holds one: storedRequestOf). A deleted preset, or run presets turned off, leaves the stored request: that
 *  ticket fails at its start anyway, and the card names why. */
function effectiveOf(item) {
  const stored = isObj(item.request) ? item.request : {};
  if (!item.presetId) return { request: stored, preset: null };
  const internal = isObj(stored.internal) ? stored.internal : {};
  const keep = Array.isArray(internal.presetOverrides) ? internal.presetOverrides.filter((k) => typeof k === 'string') : [];
  const overridden = keep.includes('overlay');
  const name = str(internal.presetName) || item.presetId;
  const preset = readPreset(item.presetId, { owner: str(internal.presetOwner) || null });
  if (!preset) return { request: stored, preset: { id: item.presetId, name, overridden, missing: true } };
  const { presetId: _link, ...request } = bodyFollowingPreset(stored, preset, { keep });
  return { request, preset: { id: preset.id, name: preset.name, overridden, missing: false } };
}

/** The workflow, engine and catalog the start would use (startRunHandler's rules: resolveShapeRequest,
 *  assertRunnableWorkflow, runEngineOpts, listModels), with the refusals that apply before any pick is read. */
async function contextOf({ kind, item }) {
  const { request, preset } = effectiveOf(item);
  const shape = resolveShapeRequest({ shape: request.shape, workflowId: request.workflowId }, { internal: true });
  if (!shape.ok) throw new ModelSwitchError('WORKFLOW_GONE', `this run cannot start its workflow: ${shape.error}`);
  const workflowId = shape.workflowId || 'wf_default';
  if (workflowId === AUTO_WORKFLOW_ID) throw new ModelSwitchError('AUTO_WORKFLOW', 'the Auto workflow picks its models when the run starts', 400);
  let workflow;
  // The run route's gate: a missing, archived or plugin-disabled workflow and a broken graph refuse with its message.
  try { workflow = await assertRunnableWorkflow(workflowId); }
  catch (err) { throw new ModelSwitchError('WORKFLOW_GONE', `this run cannot start its workflow: ${err && err.message ? err.message : String(err)}`); }
  const refusal = overlayWorkflowRefusal(workflow, { scan: workflowId === WORKSPACE_SCAN_WORKFLOW_ID });
  if (refusal) throw new ModelSwitchError(refusal === OVERLAY_ERRORS.scan ? 'SCAN_TARGET' : 'AUTO_WORKFLOW', refusal, 400);
  if (workflow.version !== 2 || !Array.isArray(workflow.nodes)) {
    throw new ModelSwitchError('WORKFLOW_GONE', `the workflow ${workflowId} is not a graph workflow (v1) — it cannot start`);
  }
  const scope = item.workspaceId ? { workspace: true } : { projectDir: item.projectDir || null };
  let engine;
  try {
    engine = selectRunEngine(resolveRunEngine({ explicit: typeof request.engine === 'string' ? request.engine : null, ...scope }).engine || 'claude');
  } catch (err) {
    throw new ModelSwitchError('ENGINE_UNKNOWN', `this run cannot start on its engine: ${err && err.message ? err.message : String(err)}`);
  }
  const models = await listModels(item.workspaceId ? '' : (item.projectDir || ''));   // the RAW catalog (checkRunOverlay needs `harnesses`)
  const agents = workflow.nodes.filter((n) => n && n.kind === 'agent' && typeof n.id === 'string');
  return { kind, item, request, preset, workflowId, workflow, engine, models, agents };
}

/** What each agent node runs on WITHOUT a pick — resolveGraph with no overlay, on the run's engine — keyed by node id.
 *  A graph that does not resolve here (a missing agent file, a plugin turned off) leaves it unknown ({}). */
async function nodeDefaultsOf(ctx) {
  try {
    const dir = ctx.item.workspaceId ? null : (ctx.item.projectDir || null);
    const resolved = await resolveGraph(dir, ctx.workflowId, loadAgentRegistry(), undefined, { engine: ctx.engine, isWorkspace: !!ctx.item.workspaceId });
    return resolved && resolved.nodes ? resolved.nodes : {};
  } catch { return {}; }
}

/** The panel's rows. A workspace target shows no project default: its run merges over the primary member's settings,
 *  which a card does not show (docs/models.md). A resolved cell's model/effort may be undefined (= none → ''). */
function stagesOf(ctx, defaults) {
  const picks = overlayNodes(ctx.request.overlay);
  return ctx.agents.map((n) => {
    const sel = isObj(picks[n.id]) ? picks[n.id] : {};
    const d = defaults[n.id];
    return {
      nodeId: n.id,
      key: n.key || '',
      label: nodeLabel(n),
      fanOut: typeof sel.fanOut === 'boolean' ? sel.fanOut : (d ? !!d.fanOut : true),
      ...pickOf(sel),
      picked: hasPick(sel),
      projectDefault: d && !ctx.item.workspaceId ? pickOf(d) : null,
      state: 'scheduled',
      switchable: true,
    };
  });
}

/**
 * What the Models panel / `worca switch-model <id>` show for a scheduled run.
 * @param {string} id a ticket id or a sch_ series id
 * @returns {Promise<object>} the Models panel's payload (describeModelSwitch's shape) plus the scheduled fields
 * @throws {ModelSwitchError}
 */
export async function describeScheduledModels(id) {
  const ctx = await contextOf(loadItem(id));
  const { kind, item, engine } = ctx;
  const chained = kind === 'once' && item.after ? item.after : null;
  const after = chained ? afterRefOf(chained.id) : null;
  return {
    kind,
    id: item.id,
    title: item.title || '',
    status: 'scheduled',
    itemStatus: item.status,
    startsAt: kind === 'once' && !chained ? item.runAt : null,
    afterTitle: chained ? ((after && after.title) || chained.id.slice(0, 8)) : null,
    sentence: kind === 'recurring' ? (item.sentence || null) : null,
    workflowId: ctx.workflowId,
    engine,
    models: engineCatalog(ctx.models, engine),
    efforts: [...effortsOfEngine(engine)],
    subagents: engineHasSubagents(engine),
    subagentModels: subagentModelsOf(engine),
    subagentEfforts: [],
    fields: [...SCHEDULED_FIELDS],
    preset: ctx.preset,
    pendingTickets: kind === 'recurring' ? editableSeriesTickets(item.id).length : 0,
    stages: stagesOf(ctx, await nodeDefaultsOf(ctx)),
  };
}

function normalizeChanges(changes, agentIds) {
  if (!isObj(changes) || !Object.keys(changes).length) throw new ModelSwitchError('BAD_REQUEST', 'changes must name at least one stage', 400);
  const out = {};
  for (const [nodeId, raw] of Object.entries(changes)) {
    if (!agentIds.has(nodeId)) throw new ModelSwitchError('UNKNOWN_STAGE', `no agent stage "${String(nodeId).slice(0, 64)}" in this workflow`, 400);
    if (!isObj(raw)) throw new ModelSwitchError('BAD_REQUEST', `changes for "${nodeId}" must be an object`, 400);
    const change = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'subagentEffort') throw new ModelSwitchError('BAD_FIELD', `a scheduled run stores no sub-agent effort (only ${SCHEDULED_FIELDS.join(', ')})`, 400);
      if (!SCHEDULED_FIELDS.includes(k)) throw new ModelSwitchError('BAD_FIELD', `"${String(k).slice(0, 64)}" cannot be changed on a scheduled run (only ${SCHEDULED_FIELDS.join(', ')})`, 400);
      if (v != null && typeof v !== 'string') throw new ModelSwitchError('BAD_REQUEST', `${k} for "${nodeId}" must be a string`, 400);
      if (typeof v === 'string' && v.length > MAX_VALUE) throw new ModelSwitchError('BAD_REQUEST', `${k} for "${nodeId}" is too long`, 400);
      change[k] = v == null ? '' : v.trim();
    }
    out[nodeId] = change;
  }
  return out;
}

/** The overlay to store: the checked nodes (none → no `nodes` key) beside the checked loop budgets (none → no `wires`).
 *  `keepKey` (a preset follower): an EMPTY overlay rather than none — bodyFromSetup spreads the preset's own overlay
 *  back under a request without the key. */
function overlayFrom(nodes, wires, { keepKey = false } = {}) {
  const out = {
    ...(Object.keys(nodes || {}).length ? { nodes } : {}),
    ...(Object.keys(wires || {}).length ? { wires } : {}),
  };
  return Object.keys(out).length || keepKey ? out : null;
}

/** `request` with `overlay` in place (null → the key deleted) and, for a preset follower, 'overlay' in its OWN
 *  internal.presetOverrides (deduplicated). Everything else — its internal included — stays its own. */
export function requestWithOverlay(request, overlay, { follower = false } = {}) {
  const next = { ...(isObj(request) ? request : {}) };
  if (overlay) next.overlay = overlay; else delete next.overlay;
  if (follower) {
    const internal = isObj(next.internal) ? { ...next.internal } : {};
    const keep = Array.isArray(internal.presetOverrides) ? internal.presetOverrides.filter((k) => typeof k === 'string') : [];
    internal.presetOverrides = keep.includes('overlay') ? keep : [...keep, 'overlay'];
    next.internal = internal;
  }
  return next;
}

const changedError = () => new ModelSwitchError('CHANGED', 'the scheduled run changed meanwhile — reload and try again');

/**
 * Land a stamp-guarded write (P9). `attempt(stamp)` is the guarded UPDATE: the written row, or null when `updated_at`
 * moved since the caller read `item`. A miss re-reads through `reload()`, which throws the item's own refusal when its
 * status changed (fired, held, ended). A bump that left the REQUEST as read — the scheduler's runs_count/next_run_at/
 * last_result stamps, a move, a retry — gets ONE more attempt on the fresh stamp; a request that differs (another edit
 * landed first) or a second miss is a lost update: CHANGED 409. Exported for its test.
 */
export function writeWithStamp(item, { attempt, reload }) {
  const first = attempt(item.updatedAt);
  if (first) return first;
  const again = reload();
  if (JSON.stringify(again.request ?? null) !== JSON.stringify(item.request ?? null)) throw changedError();
  const second = attempt(again.updatedAt);
  if (second) return second;
  throw changedError();
}

/**
 * Change the agent picks of a scheduled run. The first bad stage, field or selection refuses the WHOLE request.
 * @param {string} id a ticket id or a sch_ series id
 * @param {{changes: Record<string, {model?:string, effort?:string, subagentModel?:string}>, by?: string}} opts
 *   '' (the panel's Default, the CLI's `default`) clears a field; `by` is the identity.mjs actor
 * @returns {Promise<{ok:true, kind:'once'|'recurring', id:string, changed:object[], overlay:object|null, warnings:string[], pendingTickets:number}>}
 * @throws {ModelSwitchError}
 */
export async function switchScheduledModels(id, { changes, by = 'local' } = {}) {
  const ctx = await contextOf(loadItem(id));
  const { kind, item, models, engine } = ctx;
  const agentIds = new Set(ctx.agents.map((n) => n.id));
  const labels = new Map(ctx.agents.map((n) => [n.id, nodeLabel(n)]));
  const normalized = normalizeChanges(changes, agentIds);
  const baseNodes = overlayNodes(ctx.request.overlay);
  // Parts of the stored overlay that can never apply are dropped (P7): a node the workflow lacks, a wire it lost, a node
  // key outside OVERLAY_KEYS (resolveGraph reads exactly those). Left in, parseOverlayNodes/checkRunOverlay would refuse
  // every save with nothing the panel can fix.
  const onlyKeys = (sel) => Object.fromEntries(Object.entries(isObj(sel) ? sel : {}).filter(([k]) => OVERLAY_KEYS.includes(k)));
  const next = Object.fromEntries(Object.entries(structuredClone(baseNodes))
    .filter(([nodeId]) => agentIds.has(nodeId)).map(([nodeId, sel]) => [nodeId, onlyKeys(sel)]));
  const wireIds = new Set((Array.isArray(ctx.workflow.wires) ? ctx.workflow.wires : []).map((w) => w && w.id).filter(Boolean));
  const wires = Object.fromEntries(Object.entries(overlayWires(ctx.request.overlay)).filter(([wireId]) => wireIds.has(wireId)));
  for (const [nodeId, change] of Object.entries(normalized)) {
    const sel = { ...(isObj(next[nodeId]) ? next[nodeId] : {}) };
    for (const [k, v] of Object.entries(change)) { if (v) sel[k] = v; else delete sel[k]; }
    // A stored model-only pick is `{ model, effort: '' }` (the checker's canonical form). Clearing just the model (the
    // API form; the panel and the CLI send effort: '' too) would leave `{ effort: '' }`, which the parser turns into an
    // empty `{}` entry: drop '' values first, then an entry with nothing left.
    for (const k of Object.keys(sel)) if (sel[k] === '') delete sel[k];
    if (Object.keys(sel).length) next[nodeId] = sel; else delete next[nodeId];
  }
  // The run route's two passes: the shape pass (typed, trimmed, bounded, a sub-agent alias the vocabulary knows), then
  // the catalog pass (casing, efforts, the engine). Their messages are the ones the New run card shows.
  const parsed = parseOverlayNodes(next);
  if (parsed.error) throw new ModelSwitchError('INVALID_SELECTION', parsed.error, 400);
  const checked = checkRunOverlay(parsed.nodes || {}, { workflow: ctx.workflow, models, engine, wires });
  // An entry the parser emptied (a stored `{ effort: '' }` from another writer) is noise: never store it. For a node
  // the request changed this overlaps the '' drop above (defence in depth); it alone covers the nodes it did not name.
  for (const [nodeId, sel] of Object.entries(checked.nodes)) if (!Object.keys(sel).length) delete checked.nodes[nodeId];
  const errors = [...checked.errors];
  // checkRunOverlay does not check a sub-agent model against the engine; the run switch's rule does (Codex takes none).
  for (const [nodeId, change] of Object.entries(normalized)) {
    if (!change.subagentModel) continue;
    const issue = stageChangeError({}, { subagentModel: change.subagentModel }, models, { engine });
    if (issue) errors.push(`${labels.get(nodeId)}: ${issue}`);
  }
  if (errors.length) throw new ModelSwitchError('INVALID_SELECTION', errors.join('; '), 400);

  const changed = [];
  for (const nodeId of Object.keys(normalized)) {
    const before = pickOf(baseNodes[nodeId]);
    const after = pickOf(checked.nodes[nodeId]);
    if (SCHEDULED_FIELDS.some((f) => before[f] !== after[f])) changed.push({ nodeId, label: labels.get(nodeId), before, after });
  }
  if (!changed.length) return { ok: true, kind, id: item.id, changed: [], overlay: ctx.request.overlay || null, warnings: [], pendingTickets: 0 };

  const follower = !!item.presetId;
  const overlay = overlayFrom(checked.nodes, checked.wires, { keepKey: follower });
  const nextRequest = requestWithOverlay(item.request, overlay, { follower });
  const attempt = kind === 'once'
    ? (stamp) => updateTicketRequest(item.id, nextRequest, { expectUpdatedAt: stamp, by })
    : (stamp) => rewriteSeriesRequest(item.id, nextRequest, { ticketRequest: (r) => requestWithOverlay(r, overlay, { follower }), expectUpdatedAt: stamp, by });
  const written = writeWithStamp(item, { attempt, reload: () => loadItem(id).item });
  const pendingTickets = kind === 'recurring' ? written.ticketIds.length : 0;
  // After the write (tx committed): the listeners broadcast it and hand it to the chat notifier, which skips 'changed'.
  try {
    addNotification({
      kind: 'changed', severity: 'info',
      scheduleId: kind === 'recurring' ? item.id : null, ticketId: kind === 'once' ? item.id : null,
      projectDir: item.projectDir || null, title: item.title || null,
      message: `agent models changed${byActor(by)}: ${changed.map((c) => `${c.label} → ${scheduledPickText(c.after, models)}`).join('; ')}.`,
    });
  } catch { /* the feed is best-effort; the edit landed */ }
  return { ok: true, kind, id: item.id, changed, overlay, warnings: modelSwitchWarnings(changed, models), pendingTickets };
}
