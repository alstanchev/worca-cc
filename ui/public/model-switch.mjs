// ui/public/model-switch.mjs
// The "Models" panel: one row per agent stage, model + effort + sub-agent model + sub-agent effort.
//  - a running or paused run (run detail, both screens; GET /api/pipelines/:id/models, model-switch.mjs
//    describeModelSwitch): locked rows are stages that are running or finished for good;
//  - a scheduled run (Schedules › Models…; GET /api/schedules/:id/models, schedule-models.mjs
//    describeScheduledModels): every stage can change, `payload.fields` drops the sub-agent effort column (a scheduled
//    run stores none), each stage names its project default, and Save is the only action.
// Pure DOM — returns a detached element; the caller mounts it and owns the fetches.
import { h } from './script-forms.mjs';

export const FIELDS = Object.freeze(['model', 'effort', 'subagentModel', 'subagentEffort']);
const FIELD_NAME = { model: 'model', effort: 'effort', subagentModel: 'sub-agent model', subagentEffort: 'sub-agent effort' };
const FIELD_HEAD = { model: 'Model', effort: 'Effort', subagentModel: 'Sub-agents', subagentEffort: 'Sub-agent effort' };
const STATE_LABEL = { completed: 'completed', paused: 'paused here', pending: 'not started',
  running: 'running now', 'may-rerun': 'ran · may run again', scheduled: 'scheduled' };

/** The columns a payload shows, in FIELDS order: `payload.fields` when given, else all four. */
export const fieldsOf = (payload) => (Array.isArray(payload?.fields) && payload.fields.length
  ? FIELDS.filter((f) => payload.fields.includes(f)) : [...FIELDS]);

export const effortsFor = (models, modelId) => (models || []).find((m) => m.id === modelId)?.efforts || [];

/** Keep the effort when the model offers it, else '' (default) — always a valid pair. */
export function reconcileEffort(models, modelId, effort) {
  return effort && effortsFor(models, modelId).includes(effort) ? effort : '';
}

/** Only touched fields of switchable stages (only `fields`); `effort` always rides with `model` (the server
 *  checks the merged model/effort pair). */
export function diffChanges(stages, picks, fields = FIELDS) {
  const out = {};
  for (const s of stages || []) {
    const p = picks?.[s.nodeId];
    if (!s.switchable || !p) continue;
    const ch = {};
    for (const f of fields) if ((p[f] ?? '') !== (s[f] ?? '')) ch[f] = p[f] ?? '';
    if ('model' in ch && !('effort' in ch) && fields.includes('effort')) ch.effort = p.effort ?? '';
    if (Object.keys(ch).length) out[s.nodeId] = ch;
  }
  return out;
}

function fillSelect(doc, sel, items, value) {
  sel.replaceChildren();
  for (const it of items) {
    const o = doc.createElement('option');
    o.value = it.value; o.textContent = it.text;
    sel.appendChild(o);
  }
  sel.value = items.some((it) => it.value === value) ? value : '';
}

/** Default + `list`; a stored value the list does not hold still shows as itself (it is what the stage
 *  holds now), so rendering never changes a pick. */
function listItems(defaultText, list, current) {
  const items = [{ value: '', text: defaultText }, ...(list || []).map((v) => ({ value: v, text: v }))];
  if (current && !items.some((it) => it.value === current)) items.push({ value: current, text: `${current} (not offered on this run)` });
  return items;
}

function modelItems(payload, current) {
  const items = [{ value: '', text: payload.runDefault ? `Default (${payload.runDefault})` : 'Default' }];
  for (const m of payload.models || []) items.push({ value: m.id, text: m.label || m.id });
  // A frozen model that left the catalog still shows as itself (it is what the stage holds now).
  if (current && !items.some((it) => it.value === current)) items.push({ value: current, text: `${current} (not offered on this run)` });
  return items;
}

/** "project: Opus 5.5 · high" — what a scheduled stage runs on without a pick (describeScheduledModels projectDefault). */
export function projectDefaultText(payload, d) {
  const label = d?.model ? ((payload.models || []).find((m) => m.id === d.model)?.label || d.model) : 'default';
  return `project: ${label}${d?.model && d.effort ? ` · ${d.effort}` : ''}`;
}

/** The toast after a save: what changed, what a running run skipped, the waiting runs a series edit also updated, and
 *  the warnings. */
export function switchNotice(out) {
  const n = out?.changed?.length || 0;
  const skipped = Array.isArray(out?.skipped) ? out.skipped : [];
  const pending = Number(out?.pendingTickets) || 0;
  const detail = [
    ...skipped.map((s) => `${s.label} ${s.reason === 'running' ? 'had already started' : 'already completed'} — kept its model.`),
    ...(n && pending ? [`Also updated ${pending} waiting run${pending === 1 ? '' : 's'}.`] : []),
    ...(out?.warnings || []),
  ].join(' ');
  return {
    tone: !n && skipped.length ? 'warn' : 'ok',
    title: n ? `Switched ${n} ${n === 1 ? 'stage' : 'stages'}` : 'Nothing switched',
    detail,
  };
}

function titleOf(p) {
  if (p.status === 'scheduled') return p.kind === 'recurring' ? 'Models for every run of this schedule' : 'Models for this scheduled run';
  return p.status === 'running' ? 'Switch models for the stages that have not started' : 'Switch models for the remaining stages';
}
function subtitleOf(p) {
  if (p.status === 'scheduled') {
    const n = Number(p.pendingTickets) || 0;
    return `Each pick applies when the run starts. Default keeps the project's setting.${n ? ` Also updates ${n} waiting run${n === 1 ? '' : 's'}.` : ''}`;
  }
  return p.status === 'running'
    ? 'This run only. Each stage uses its new model when it starts; a stage that is running keeps its model.'
    : 'This run only. A stage whose model changes starts a fresh session when the run resumes.';
}

/**
 * @param {object} payload describeModelSwitch's or describeScheduledModels' shape
 * @param {{doc?:Document, onSave?:(x:{changes:object, resume:boolean})=>Promise<void>, onCancel?:()=>void}} [opts]
 * @returns {{el:HTMLElement, picks:()=>object, showError:(msg:string)=>void, setBusy:(b:boolean)=>void}}
 */
export function renderModelSwitchPanel(payload, { doc = globalThis.document, onSave, onCancel } = {}) {
  const picks = {};
  const selects = {};   // nodeId -> { model, effort, locked }
  const live = payload.status === 'running';
  const scheduled = payload.status === 'scheduled';
  const fields = fieldsOf(payload);
  const root = h(doc, 'section', 'msw');
  root.dataset.mode = scheduled ? 'scheduled' : live ? 'running' : 'paused';
  root.setAttribute('aria-label', 'Switch models');
  const head = h(doc, 'div', 'msw-head');
  head.appendChild(h(doc, 'b', 'msw-title', titleOf(payload)));
  head.appendChild(h(doc, 'small', 'msw-sub', subtitleOf(payload)));
  root.appendChild(head);
  if (payload.pauseDetail) root.appendChild(h(doc, 'p', 'msw-why', payload.pauseDetail));
  const allLocked = !!payload.modelForAll;   // run-harness _nodeModelPair ignores per-stage model/effort
  // Named after the Resume menu item that set it (index.html .resume-with-model), not this panel.
  if (allLocked) root.appendChild(h(doc, 'p', 'msw-note', `This run was resumed with ${payload.modelForAll} for every remaining stage (Resume › Switch model…) — per-stage models and efforts do not apply.`));
  // A preset follower: the save is an override that wins at fire time (schedule-models.mjs, D4).
  if (scheduled && payload.preset && !payload.preset.missing) {
    root.appendChild(h(doc, 'p', 'msw-note', `Overrides the agent picks of the run preset ${payload.preset.name} for this schedule.`));
  }

  // Fill-only (render): shows the stored effort even if its model does not offer it; never touches picks.
  const fillEffort = (nodeId) => {
    const s = selects[nodeId];
    const p = picks[nodeId];
    const offered = effortsFor(payload.models, p.model);
    fillSelect(doc, s.effort, listItems('Default', offered, p.effort), p.effort);
    s.effort.disabled = s.locked || !p.model || allLocked || offered.length === 0;
  };
  // A user model change (or "Set all to…"): keep the effort only if the new model offers it.
  const syncEffort = (nodeId) => {
    if (!selects[nodeId].effort) return;   // a payload without the effort column
    const p = picks[nodeId];
    p.effort = reconcileEffort(payload.models, p.model, p.effort);
    fillEffort(nodeId);
  };

  const table = h(doc, 'table', 'msw-table');
  const thead = h(doc, 'tr', 'msw-hrow');
  for (const t of ['Stage', ...fields.map((f) => FIELD_HEAD[f])]) thead.appendChild(h(doc, 'th', '', t));
  table.appendChild(thead);

  // "All remaining stages": one model for every switchable row (the usage-limit case).
  const switchable = (payload.stages || []).filter((s) => s.switchable);
  if (switchable.length > 1 && fields.includes('model')) {
    const tr = h(doc, 'tr', 'msw-all-row');
    tr.appendChild(h(doc, 'td', 'msw-stage', scheduled ? 'All stages' : 'All remaining stages'));
    const td = h(doc, 'td');
    const all = h(doc, 'select', 'msw-all ins-select');
    all.setAttribute('aria-label', 'Set every remaining stage to a model');
    fillSelect(doc, all, [{ value: '__keep', text: 'Set all to…' }, ...modelItems(payload, '')], '__keep');
    all.disabled = allLocked;
    all.addEventListener('change', () => {
      if (all.value === '__keep') return;
      for (const s of switchable) {
        picks[s.nodeId].model = all.value;
        selects[s.nodeId].model.value = all.value;
        syncEffort(s.nodeId);
      }
      all.value = '__keep';   // an action, not a state: the rows now hold the pick
    });
    td.appendChild(all);
    tr.appendChild(td);
    for (let i = 1; i < fields.length; i++) tr.appendChild(h(doc, 'td'));   // one empty cell per remaining column (3 for a run payload, as before)
    table.appendChild(tr);
  }

  for (const s of payload.stages || []) {
    picks[s.nodeId] = Object.fromEntries(fields.map((f) => [f, s[f] || '']));
    const locked = !s.switchable;
    const tr = h(doc, 'tr', `msw-row${locked ? ' is-locked' : ''}`);
    tr.dataset.node = s.nodeId;
    const stage = h(doc, 'td', 'msw-stage');
    stage.appendChild(h(doc, 'span', 'msw-label', s.label));
    stage.appendChild(h(doc, 'small', `msw-state st-${s.state}`, STATE_LABEL[s.state] || s.state));
    if (s.projectDefault) stage.appendChild(h(doc, 'small', 'msw-default', projectDefaultText(payload, s.projectDefault)));
    tr.appendChild(stage);

    const mk = (field, items, value) => {
      const sel = h(doc, 'select', 'ins-select');
      sel.dataset.field = field;
      sel.setAttribute('aria-label', `${s.label} ${FIELD_NAME[field]}`);
      fillSelect(doc, sel, items, value);
      sel.disabled = locked || (allLocked && (field === 'model' || field === 'effort'));
      sel.addEventListener('change', () => {
        picks[s.nodeId][field] = sel.value;
        if (field === 'model') syncEffort(s.nodeId);
      });
      const td = h(doc, 'td');
      td.appendChild(sel);
      tr.appendChild(td);
      return sel;
    };
    selects[s.nodeId] = { locked };
    if (fields.includes('model')) selects[s.nodeId].model = mk('model', modelItems(payload, s.model), s.model || '');
    if (fields.includes('effort')) {
      selects[s.nodeId].effort = mk('effort', [{ value: '', text: 'Default' }], '');
      fillEffort(s.nodeId);
    }
    // Sub-agent cells: only the values this run's engine applies (subagentModels / subagentEfforts); a field it takes
    // none of reads '—', like a stage without fan-out.
    const fan = s.fanOut && payload.subagents !== false;
    const subField = (field, defaultText, list) => {
      if (fan && list?.length) mk(field, listItems(defaultText, list, s[field] || ''), s[field] || '');
      else tr.appendChild(h(doc, 'td', 'msw-na', '—'));
    };
    if (fields.includes('subagentModel')) subField('subagentModel', 'Default (agent picks)', payload.subagentModels);
    if (fields.includes('subagentEffort')) subField('subagentEffort', 'Default', payload.subagentEfforts);
    table.appendChild(tr);
  }
  root.appendChild(table);

  const err = h(doc, 'div', 'msw-error');
  err.hidden = true;
  root.appendChild(err);
  const actions = h(doc, 'div', 'msw-actions');
  const cancel = h(doc, 'button', 'msw-cancel btn', 'Cancel');
  // A running or a scheduled run has nothing to resume: Save is the primary (and only) action.
  const save = h(doc, 'button', live || scheduled ? 'msw-save btn btn-primary' : 'msw-save btn', 'Save');
  const saveResume = live || scheduled ? null : h(doc, 'button', 'msw-save-resume btn btn-primary', 'Save & resume');
  const buttons = [cancel, save, ...(saveResume ? [saveResume] : [])];
  for (const b of buttons) { b.type = 'button'; actions.appendChild(b); }
  root.appendChild(actions);

  const api = {
    el: root,
    picks: () => JSON.parse(JSON.stringify(picks)),
    showError: (msg) => { err.textContent = msg || ''; err.hidden = !msg; },
    setBusy: (busy) => { for (const b of buttons) b.disabled = !!busy; },
  };
  const submit = async (resume) => {
    api.showError('');
    api.setBusy(true);
    try { await onSave?.({ changes: diffChanges(payload.stages, picks, fields), resume }); }
    catch (e) { api.showError(e?.message || String(e)); }
    finally { api.setBusy(false); }
  };
  save.addEventListener('click', () => { void submit(false); });
  saveResume?.addEventListener('click', () => { void submit(true); });
  cancel.addEventListener('click', () => onCancel?.());
  return api;
}
