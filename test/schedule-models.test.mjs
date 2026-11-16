// test/schedule-models.test.mjs — Models… on a scheduled run (src/core/schedule-models.mjs, design §2, §6, §8): the
// describe payload, the per-key merge into request.overlay.nodes, the run route's checks, the in-place series rewrite,
// a preset follower's override, the stamp guard, the refusals and the quiet feed entry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { addProject } from '../src/core/projects.mjs';
import { getDb } from '../src/core/db.mjs';
import { setNodeModel, listModels } from '../src/core/config.mjs';
import { createPreset } from '../src/core/run-presets-store.mjs';
import { bodyFollowingPreset } from '../src/shared/run-presets.mjs';
import { createTicket, createSchedule, getTicket, getSchedule, claimTicket, runScheduleNow } from '../src/core/scheduler.mjs';
import { listNotifications } from '../src/core/notifications.mjs';
import { ModelSwitchError } from '../src/core/model-switch.mjs';
import { describeScheduledModels, switchScheduledModels, scheduledPickText, writeWithStamp } from '../src/core/schedule-models.mjs';

useTempHome(after);
let DIR;
before(async () => {
  DIR = gitDir('sched-models');
  await addProject({ name: 'sched-models', path: DIR });
  await setNodeModel(DIR, 'wf_default', 'n_impl', { model: 'claude-opus-5-5', effort: 'high' });   // a project default
});
after(async () => {
  if (DIR) await rm(DIR, { recursive: true, force: true, maxRetries: 10 });
});

const REQ = (extra = {}) => ({ projectDir: DIR, prompt: 'Nightly', workflowId: 'wf_default', ...extra });
// createSchedule called directly needs rule.anchor (normalizeRule: 'rule.anchor must be YYYY-MM-DD'); POST /api/run adds it.
const DAILY = (time) => ({ freq: 'daily', time, tz: 'UTC', anchor: '2026-10-01' });
const once = (request = REQ(), extra = {}) => createTicket({ title: 'Nightly', projectDir: DIR, runAtMs: Date.now() + 3600_000, request, ...extra });
const storedOf = (id) => getTicket(id, { withRequest: true }).request;
const rejects = (p, code, re) => assert.rejects(p, (e) => {
  assert.ok(e instanceof ModelSwitchError, String(e && e.stack));
  assert.equal(e.code, code, e.message);
  if (re) assert.match(e.message, re);
  return true;
});
// _resetForTests keeps rows (memory test-reset-keeps-db-rows): count only this item's entries. Newest first.
const changedRows = (id) => listNotifications({ limit: 1000 }).filter((n) => n.kind === 'changed' && (n.ticketId === id || n.scheduleId === id));

test('describe: the workflow\'s agent stages with the stored picks, the project defaults and the engine\'s catalog', async () => {
  const t = once(REQ({ overlay: { nodes: { n_plan: { model: 'claude-haiku-4-5', effort: 'high' } } } }));
  const d = await describeScheduledModels(t.id);
  assert.deepEqual([d.kind, d.id, d.status, d.itemStatus, d.startsAt, d.engine, d.pendingTickets, d.preset],
    ['once', t.id, 'scheduled', 'scheduled', t.runAt, 'claude', 0, null]);
  assert.deepEqual(d.fields, ['model', 'effort', 'subagentModel']);
  assert.deepEqual(d.stages.map((s) => [s.nodeId, s.label]),
    [['n_clarify', 'Clarify'], ['n_plan', 'Planner'], ['n_refine', 'Refiner'], ['n_impl', 'Implementer'], ['n_review', 'Reviewer']]);
  const plan = d.stages.find((s) => s.nodeId === 'n_plan');
  assert.deepEqual([plan.model, plan.effort, plan.subagentModel, plan.picked, plan.state, plan.switchable],
    ['claude-haiku-4-5', 'high', '', true, 'scheduled', true]);
  const impl = d.stages.find((s) => s.nodeId === 'n_impl');
  assert.equal(impl.picked, false);
  assert.deepEqual(impl.projectDefault, { model: 'claude-opus-5-5', effort: 'high', subagentModel: '' }, 'resolveGraph without an overlay');
  assert.ok(d.models.some((m) => m.id === 'claude-opus-5-5'));
  assert.equal(d.models.some((m) => m.id === 'gpt-5.5'), false, 'only what the run\'s engine runs');
  assert.equal(getTicket(t.id).summary.agentPicks, 1);
  assert.equal('agentPicks' in once().summary, false);
});

test('switch: merges per key, clears on "", stores the checker\'s canonical nodes, writes nothing on a no-op, posts a quiet feed entry', async () => {
  const t = once();
  const out = await switchScheduledModels(t.id, { changes: { n_plan: { model: 'Claude-Opus-5-5' } }, by: 'ada' });
  assert.deepEqual([out.ok, out.kind, out.id, out.pendingTickets], [true, 'once', t.id, 0]);
  assert.deepEqual(out.changed, [{ nodeId: 'n_plan', label: 'Planner',
    before: { model: '', effort: '', subagentModel: '' }, after: { model: 'claude-opus-5-5', effort: '', subagentModel: '' } }]);
  assert.deepEqual(storedOf(t.id).overlay, { nodes: { n_plan: { model: 'claude-opus-5-5', effort: '' } } }, 'catalog casing; a model carries its effort');
  assert.equal(getTicket(t.id).updatedBy, 'ada');
  await switchScheduledModels(t.id, { changes: { n_plan: { effort: 'high', subagentModel: 'opus' } } });
  assert.deepEqual(storedOf(t.id).overlay.nodes.n_plan, { model: 'claude-opus-5-5', effort: 'high', subagentModel: 'opus' }, 'merged per key');
  const stamp = getTicket(t.id).updatedAt;
  assert.deepEqual((await switchScheduledModels(t.id, { changes: { n_plan: { effort: 'high' } } })).changed, []);
  assert.equal(getTicket(t.id).updatedAt, stamp, 'a no-op writes nothing');
  await switchScheduledModels(t.id, { changes: { n_plan: { model: '', effort: '', subagentModel: '' } } });
  assert.equal('overlay' in storedOf(t.id), false, 'the last pick cleared: no overlay left');
  const feed = changedRows(t.id);
  assert.equal(feed.length, 3, 'one entry per landed change, none for the no-op');
  const first = feed.at(-1);   // newest first, so the first change is last
  assert.equal(first.message, `agent models changed by ada: Planner → ${scheduledPickText({ model: 'claude-opus-5-5' }, await listModels(DIR))}.`);
  assert.deepEqual([first.severity, first.unread, first.ticketId, first.scheduleId], ['info', false, t.id, null]);
  assert.match(feed[0].message, /^agent models changed: Planner → project default\.$/, 'a local edit names nobody');
  // P7: parts of a stored overlay that can never apply are dropped on save — a node the workflow lacks, a key outside
  // OVERLAY_KEYS, a stale wire — and an API clear of only the model leaves no empty {} entry behind.
  const stale = once(REQ({ overlay: { nodes: { n_plan: { model: 'claude-haiku-4-5', effort: '', reason: 'fast' }, n_gone: { model: 'claude-haiku-4-5', effort: '' } },
    wires: { w5: { maxCycles: 2 }, w_gone: { maxCycles: 9 } } } }));
  await switchScheduledModels(stale.id, { changes: { n_impl: { model: 'claude-opus-5-5' } } });
  assert.deepEqual(storedOf(stale.id).overlay, { nodes: { n_plan: { model: 'claude-haiku-4-5', effort: '' }, n_impl: { model: 'claude-opus-5-5', effort: '' } }, wires: { w5: { maxCycles: 2 } } });
  await switchScheduledModels(stale.id, { changes: { n_plan: { model: '' }, n_impl: { model: '' } } });   // the model only: the API form
  assert.deepEqual(storedOf(stale.id).overlay, { wires: { w5: { maxCycles: 2 } } }, 'no {} node left; the loop budget stays (not an edit target)');
});

test('switch refuses what the run route refuses — and a sub-agent effort, an unknown stage, a Codex sub-agent model', async () => {
  const t = once();
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { model: 'gpt-5.5' } } }), 'INVALID_SELECTION', /node "n_plan": gpt-5\.5 runs on OpenAI Codex, not on Claude Code/);
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { effort: 'high' } } }), 'INVALID_SELECTION', /node "n_plan": an effort needs a model/);
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { model: 'claude-opus-5-5', effort: 'extreme' } } }), 'INVALID_SELECTION', /node "n_plan": model claude-opus-5-5 has no effort "extreme"/);
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { subagentModel: 'gpt' } } }), 'INVALID_SELECTION', /node "n_plan": unknown sub-agent model "gpt"/);   // the shape pass
  await rejects(switchScheduledModels(t.id, { changes: { n_task: { model: 'claude-opus-5-5' } } }), 'UNKNOWN_STAGE');
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { subagentEffort: 'high' } } }), 'BAD_FIELD', /stores no sub-agent effort/);
  await rejects(switchScheduledModels(t.id, { changes: { n_plan: { fanOut: true } } }), 'BAD_FIELD', /"fanOut" cannot be changed/);
  await rejects(switchScheduledModels(t.id, { changes: {} }), 'BAD_REQUEST');
  const codex = once(REQ({ engine: 'codex' }));
  await rejects(switchScheduledModels(codex.id, { changes: { n_plan: { subagentModel: 'opus' } } }), 'INVALID_SELECTION', /Planner: OpenAI Codex does not take a sub-agent model/);
  assert.equal('overlay' in storedOf(t.id), false, 'a refusal writes nothing');
  assert.equal(changedRows(t.id).length, 0);
});

test('a series edit rewrites the series and its waiting tickets in place — not a firing one', async () => {
  const { schedule, ticket } = createSchedule({ title: 'Series', projectDir: DIR, request: REQ(), rule: DAILY('02:00') });
  const missed = runScheduleNow(schedule.id);
  getDb().prepare("UPDATE scheduled_runs SET status = 'missed', forced = 0 WHERE id = ?").run(missed.id);
  const firing = runScheduleNow(schedule.id);
  assert.ok(claimTicket(firing.id), 'the tick took this one');
  getDb().prepare('UPDATE scheduled_runs SET attempts = 2 WHERE id = ?').run(ticket.id);
  assert.equal((await describeScheduledModels(schedule.id)).pendingTickets, 2);
  const out = await switchScheduledModels(schedule.id, { changes: { n_review: { model: 'claude-opus-5-5', effort: 'high' } }, by: 'ada' });
  assert.deepEqual([out.kind, out.pendingTickets], ['recurring', 2]);
  const pick = { nodes: { n_review: { model: 'claude-opus-5-5', effort: 'high' } } };
  assert.deepEqual(getSchedule(schedule.id, { withRequest: true }).request.overlay, pick);
  const t = getTicket(ticket.id, { withRequest: true });
  assert.deepEqual([t.request.overlay, t.attempts, t.status], [pick, 2, 'scheduled'], 'the occurrence keeps its id and attempts');
  assert.deepEqual(getTicket(missed.id, { withRequest: true }).request.overlay, pick, 'a missed one follows too');
  assert.equal(getTicket(firing.id, { withRequest: true }).request.overlay, undefined, 'a firing ticket is untouched');
  const [n] = changedRows(schedule.id);
  assert.deepEqual([n.scheduleId, n.ticketId], [schedule.id, null]);
});

test('a preset follower is edited on its EFFECTIVE request, gains "overlay" in presetOverrides, and keeps an empty overlay when cleared', async () => {
  const preset = createPreset({ name: 'Follow me', scope: { kind: 'global' },
    setup: { workflowId: 'wf_default', overlay: { nodes: { n_plan: { model: 'claude-haiku-4-5', effort: '' } } } } });
  const t = once(REQ({ internal: { presetName: 'Follow me', presetOverrides: ['guardrailsId'] } }), { presetId: preset.id });
  const d = await describeScheduledModels(t.id);
  assert.deepEqual(d.preset, { id: preset.id, name: 'Follow me', overridden: false, missing: false });
  assert.equal(d.stages.find((s) => s.nodeId === 'n_plan').model, 'claude-haiku-4-5', 'the preset\'s CURRENT pick, not the stored copy');
  await switchScheduledModels(t.id, { changes: { n_impl: { model: 'claude-opus-5-5', effort: 'high' } } });
  const stored = storedOf(t.id);
  assert.deepEqual(stored.overlay, { nodes: { n_plan: { model: 'claude-haiku-4-5', effort: '' }, n_impl: { model: 'claude-opus-5-5', effort: 'high' } } });
  assert.deepEqual(stored.internal.presetOverrides, ['guardrailsId', 'overlay']);
  assert.equal(stored.internal.presetName, 'Follow me', 'its own internal is kept');
  assert.equal('presetId' in stored, false, 'the link stays in the preset_id column');
  assert.deepEqual(bodyFollowingPreset(stored, preset, { keep: stored.internal.presetOverrides }).overlay, stored.overlay, 'what fireTicket builds keeps the edit');
  assert.equal((await describeScheduledModels(t.id)).preset.overridden, true);
  await switchScheduledModels(t.id, { changes: { n_plan: { model: '', effort: '' }, n_impl: { model: '', effort: '' } } });
  assert.deepEqual(storedOf(t.id).overlay, {}, 'kept as {}: bodyFromSetup would spread the preset\'s picks back under a missing key');
  assert.deepEqual(storedOf(t.id).internal.presetOverrides, ['guardrailsId', 'overlay'], 'deduplicated');
});

test('writeWithStamp: a bump that left the request alone is retried once; a changed request, a second miss or a status change is refused', () => {
  const R = { prompt: 'x' };
  const stamps = [];
  const attempt = (stamp) => { stamps.push(stamp); return stamp === 'b' ? { ok: true } : null; };
  assert.deepEqual(writeWithStamp({ updatedAt: 'a', request: R }, { attempt, reload: () => ({ updatedAt: 'b', request: { ...R } }) }), { ok: true });
  assert.deepEqual(stamps, ['a', 'b']);
  const changed = (e) => { assert.ok(e instanceof ModelSwitchError); assert.equal(e.code, 'CHANGED'); return true; };
  // The fresh stamp WOULD land here: only the request-equality guard can refuse it before the retry.
  const stamps2 = [];
  assert.throws(() => writeWithStamp({ updatedAt: 'a', request: R }, {
    attempt: (s) => { stamps2.push(s); return s === 'b' ? { ok: true } : null; },
    reload: () => ({ updatedAt: 'b', request: { prompt: 'y' } }),
  }), changed);
  assert.deepEqual(stamps2, ['a'], 'a changed request is refused before the retry, not written on the fresh stamp');
  assert.throws(() => writeWithStamp({ updatedAt: 'a', request: R }, { attempt: () => null, reload: () => ({ updatedAt: 'b', request: { ...R } }) }), changed);
  assert.throws(() => writeWithStamp({ updatedAt: 'a', request: R }, { attempt: () => null, reload: () => { throw new ModelSwitchError('NOT_SCHEDULABLE', 'fired'); } }),
    (e) => e.code === 'NOT_SCHEDULABLE');
});

test('refusals: unknown id, a fired ticket, an occurrence, a resume ticket, a held ticket, the Auto workflow, a gone workflow, an ended series', async () => {
  await rejects(describeScheduledModels('nope'), 'NOT_FOUND');
  await rejects(describeScheduledModels('sch_nope'), 'NOT_FOUND');
  const fired = once();
  getDb().prepare("UPDATE scheduled_runs SET status = 'fired' WHERE id = ?").run(fired.id);
  await rejects(switchScheduledModels(fired.id, { changes: { n_plan: { model: 'claude-opus-5-5' } } }), 'NOT_SCHEDULABLE', /is fired/);
  const { schedule, ticket } = createSchedule({ title: 'S2', projectDir: DIR, request: REQ(), rule: DAILY('03:00') });
  await rejects(describeScheduledModels(ticket.id), 'OCCURRENCE', new RegExp(`worca switch-model ${schedule.id}`));
  const resume = createTicket({ title: 'Resume', projectDir: DIR, runAtMs: Date.now() + 3600_000, request: {}, resumePipelineId: 'abcd1234' });
  await rejects(describeScheduledModels(resume.id), 'RESUME_TICKET', /worca switch-model abcd1234/);
  await rejects(describeScheduledModels(once(REQ(), { ownerPid: 424242 }).id), 'HELD_BY_TERMINAL', /held by a waiting terminal/);
  await rejects(describeScheduledModels(once(REQ({ workflowId: 'wf_auto' })).id), 'AUTO_WORKFLOW', /picks its models when the run starts/);
  await rejects(describeScheduledModels(once(REQ({ workflowId: 'wf_gone' })).id), 'WORKFLOW_GONE', /unknown workflowId "wf_gone"/);
  getDb().prepare("UPDATE schedules SET status = 'ended' WHERE id = ?").run(schedule.id);
  await rejects(describeScheduledModels(schedule.id), 'NOT_SCHEDULABLE', /has ended/);
});
