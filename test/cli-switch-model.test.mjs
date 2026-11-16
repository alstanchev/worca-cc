// test/cli-switch-model.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { graphResumePoint } from './helpers/graph-templates.mjs';
import { addProject } from '../src/core/projects.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';
import { getDb } from '../src/core/db.mjs';
import { parseSwitchArgs, resolveSwitchRef } from '../src/cli/switch-model.mjs';
import { createTicket, createSchedule, getTicket, getSchedule } from '../src/core/scheduler.mjs';

const CLI = fileURLToPath(new URL('../src/cli/worca-cc.mjs', import.meta.url));
const home = useTempHome(after);

function run(args, env = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args],
      { env: { ...process.env, WORCA_HOME: home, HOME: home, USERPROFILE: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}
/** `claude`: the resume point's run options (engine, modelForAll); `cells`: per-node model/effort to store. */
async function seedPaused(name, status = 'paused', { claude, cells = {} } = {}) {
  const dir = gitDir(name);
  await addProject({ name, path: dir });
  const rp = graphResumePoint({ pipelineDir: dir, ...(claude ? { claude } : {}) });
  for (const n of rp.manifest.graph.nodes) Object.assign(n, cells[n.id] || {});
  const steps = [
    { key: 'x:n_clarify:1', executionId: 'x:n_clarify:1', nodeId: 'n_clarify', status: 'done' },
    { key: 'x:n_plan:1', executionId: 'x:n_plan:1', nodeId: 'n_plan', status: 'paused', sessionId: 's' },
  ];
  return (await seedPipeline(dir, { title: name, status, stepper: rp.manifest, resumePoint: rp, steps })).id;
}
async function seedRunning(name, owner) {
  const dir = gitDir(name);
  await addProject({ name, path: dir });
  const rp = graphResumePoint({ pipelineDir: dir });
  const steps = [
    { key: 'x:n_clarify:1', executionId: 'x:n_clarify:1', nodeId: 'n_clarify', status: 'done' },
    { key: 'x:n_plan:1', executionId: 'x:n_plan:1', nodeId: 'n_plan', status: 'start' },
  ];
  const { id } = await seedPipeline(dir, { title: name, status: 'running', stepper: rp.manifest, resumePoint: rp, steps });
  getDb().prepare('UPDATE pipelines SET owner_pid = ?, owner_host = ?, heartbeat_at = ? WHERE id = ?')
    .run(owner.pid, hostname(), owner.beat ?? null, id);
  return id;
}

test('parseSwitchArgs: flags, "default" clears, missing values reported', () => {
  const a = parseSwitchArgs(['abc', '--stage', 'planner', '--model', 'claude-opus-5-5', '--effort', 'default']);
  assert.equal(a.ref, 'abc'); assert.equal(a.stage, 'planner');
  assert.deepEqual(a.change, { model: 'claude-opus-5-5', effort: '' });
  assert.deepEqual(parseSwitchArgs(['abc', '--model']).missing, ['--model']);
});

test('lists stages, then switches one by agent key, and --all switches every remaining stage', async () => {
  const id = await seedPaused('cli-msw');
  const list = await run(['switch-model', id, '--json']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).stages.find((s) => s.nodeId === 'n_clarify').switchable, false);

  const one = await run(['switch-model', id, '--stage', 'planner', '--model', 'claude-opus-5-5', '--effort', 'high']);
  assert.equal(one.code, 0, one.stderr);
  const plan = readPipelineForResume(id).resumePoint.manifest.graph.nodes.find((n) => n.id === 'n_plan');
  assert.deepEqual([plan.model, plan.effort], ['claude-opus-5-5', 'high']);

  const all = await run(['switch-model', id, '--all', '--model', 'claude-sonnet-5-5', '--effort', 'default']);
  assert.equal(all.code, 0, all.stderr);
  const nodes = readPipelineForResume(id).resumePoint.manifest.graph.nodes;
  assert.equal(nodes.find((n) => n.id === 'n_impl').model, 'claude-sonnet-5-5');
  assert.equal(nodes.find((n) => n.id === 'n_clarify').model, '', 'completed stage untouched');
});

test('refuses a completed stage and a non-paused run with exit 1', async () => {
  const id = await seedPaused('cli-msw-ref');
  const r = await run(['switch-model', id, '--stage', 'n_clarify', '--model', 'claude-opus-5-5']);
  assert.equal(r.code, 1); assert.match(r.stderr, /already completed/);
  const done = await seedPaused('cli-msw-done', 'done');
  const d = await run(['switch-model', done]);
  assert.equal(d.code, 1); assert.match(d.stderr, /models can be switched while it is running or paused/);
});

test('a running run: lists with its live states; dead owner refuses; no answer reads "Switch sent"', async () => {
  const dead = await seedRunning('cli-msw-dead', { pid: 2147483646 });
  const list = await run(['switch-model', dead]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /— running/);
  const json = JSON.parse((await run(['switch-model', dead, '--json'])).stdout);
  assert.equal(json.status, 'running');
  assert.deepEqual([json.stages.find((s) => s.nodeId === 'n_plan').state, json.stages.find((s) => s.nodeId === 'n_plan').switchable], ['running', false]);
  const r = await run(['switch-model', dead, '--stage', 'implementer', '--model', 'claude-opus-5-5']);
  assert.equal(r.code, 1); assert.match(r.stderr, /no live owner process/);
  const idle = await seedRunning('cli-msw-idle', { pid: process.pid, beat: new Date().toISOString() });
  const t = await run(['switch-model', idle, '--stage', 'implementer', '--model', 'claude-opus-5-5'], { WORCA_CONTROL_CONFIRM_MS: '700' });
  assert.equal(t.code, 0, t.stderr); assert.match(t.stdout, /Switch sent/);
});

test('the listing names the run engine and a one-model-for-all resume (m3)', async () => {
  const id = await seedPaused('cli-msw-head');
  const list = await run(['switch-model', id]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /Engine: Claude Code\n/);
  assert.doesNotMatch(list.stdout, /for every remaining stage/);
  const codex = await seedPaused('cli-msw-codex', 'paused', { claude: { engine: 'codex' } });
  assert.match((await run(['switch-model', codex])).stdout, /Engine: OpenAI Codex\n/);
  const forAll = await seedPaused('cli-msw-forall', 'paused', { claude: { model: 'claude-sonnet-5-5', modelForAll: true } });
  assert.match((await run(['switch-model', forAll])).stdout,
    /Resumed with claude-sonnet-5-5 for every remaining stage — per-stage models and efforts do not apply\./);
});

test('--model without --effort clears a stored effort the new model does not offer, as the panel does (m4)', async () => {
  const OPUS = 'claude-opus-5-5';
  const cells = { n_plan: { model: OPUS, effort: 'xhigh' }, n_refine: { model: OPUS, effort: 'xhigh' },
    n_impl: { model: OPUS, effort: 'high' }, n_review: { model: OPUS, effort: 'xhigh' } };
  const id = await seedPaused('cli-msw-recon', 'paused', { cells });
  const r = await run(['switch-model', id, '--all', '--model', 'claude-haiku-4-5']);   // Haiku 4.5: medium, high
  assert.equal(r.code, 0, r.stderr);
  const nodes = readPipelineForResume(id).resumePoint.manifest.graph.nodes;
  const pair = (n) => { const x = nodes.find((y) => y.id === n); return [x.model, x.effort]; };
  assert.deepEqual(['n_plan', 'n_refine', 'n_impl', 'n_review'].map(pair), [
    ['claude-haiku-4-5', ''], ['claude-haiku-4-5', ''], ['claude-haiku-4-5', 'high'], ['claude-haiku-4-5', '']]);
});

async function seedTicket(name, extra = {}) {
  const dir = gitDir(name);
  await addProject({ name, path: dir });
  return createTicket({ title: name, projectDir: dir, runAtMs: Date.now() + 86400_000,
    request: { projectDir: dir, prompt: name, workflowId: 'wf_default' }, ...extra });
}

test('a scheduled ticket: lists its stages as "scheduled", changes one by agent key; --json shape; --subagent-effort refused (design §5)', async () => {
  const t = await seedTicket('cli-msw-ticket');
  const list = await run(['switch-model', t.id]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /— scheduled, starts /);
  assert.match(list.stdout, /n_plan\s+scheduled/);
  const one = await run(['switch-model', t.id.slice(0, 8), '--stage', 'planner', '--model', 'claude-opus-5-5', '--effort', 'high', '--json']);
  assert.equal(one.code, 0, one.stderr);
  const j = JSON.parse(one.stdout);
  assert.deepEqual(Object.keys(j).sort(), ['changed', 'id', 'kind', 'pendingTickets', 'warnings']);
  assert.deepEqual([j.id, j.kind, j.pendingTickets, j.changed.map((c) => c.nodeId)], [t.id, 'once', 0, ['n_plan']]);
  assert.deepEqual(getTicket(t.id, { withRequest: true }).request.overlay, { nodes: { n_plan: { model: 'claude-opus-5-5', effort: 'high' } } });
  const human = await run(['switch-model', t.id, '--stage', 'planner', '--model', 'default']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Changed Planner \(n_plan\): .*· high → project default/);
  const sub = await run(['switch-model', t.id, '--stage', 'planner', '--subagent-effort', 'high']);
  assert.equal(sub.code, 2);
  assert.match(sub.stderr, /a scheduled run stores no sub-agent effort/);
});

test('a sch_ id: --all changes every stage of the series and its waiting run, in place', async () => {
  const dir = gitDir('cli-msw-series');
  await addProject({ name: 'cli-msw-series', path: dir });
  const { schedule, ticket } = createSchedule({ title: 'Nightly', projectDir: dir, request: { projectDir: dir, prompt: 'n', workflowId: 'wf_default' },
    rule: { freq: 'daily', time: '02:00', tz: 'UTC', anchor: '2026-10-01' } });   // createSchedule needs the anchor POST /api/run adds
  const list = await run(['switch-model', schedule.id]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /— repeating schedule, /);
  const r = await run(['switch-model', schedule.id, '--all', '--model', 'claude-sonnet-5-5']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Changed Planner \(n_plan\)/);
  assert.match(r.stdout, /Also updated 1 waiting run\./);
  assert.equal(getSchedule(schedule.id, { withRequest: true }).request.overlay.nodes.n_impl.model, 'claude-sonnet-5-5');
  assert.equal(getTicket(ticket.id, { withRequest: true }).request.overlay.nodes.n_impl.model, 'claude-sonnet-5-5', 'same ticket id: updated in place');
  const occ = await run(['switch-model', ticket.id]);
  assert.equal(occ.code, 1);
  assert.match(occ.stderr, new RegExp(`worca switch-model ${schedule.id}`));
});

test('resolveSwitchRef: two series under one prefix read "schedules"; an id with no hit names the sch_ form', () => {
  const dir = gitDir('cli-msw-ref');
  for (const id of ['sch_d0d0aa01', 'sch_d0d0aa02']) {
    createSchedule({ id, title: id, projectDir: dir, request: { projectDir: dir, prompt: 'r', workflowId: 'wf_default' },
      rule: { freq: 'daily', time: '02:00', tz: 'UTC', anchor: '2026-10-01' } });
  }
  const fail = (msg) => { throw new Error(msg); };
  assert.throws(() => resolveSwitchRef('sch_d0d0aa0', fail), /^Error: "sch_d0d0aa0" matches 2 schedules — use a longer id$/);
  assert.deepEqual(resolveSwitchRef('sch_d0d0aa01', fail), { kind: 'recurring', id: 'sch_d0d0aa01' });
  assert.throws(() => resolveSwitchRef('d0d0aa01', fail), /no run matches "d0d0aa01" .*a repeating schedule is named by its sch_ id/);
});

test('a prefix that matches a run and a scheduled run is refused; the full pipeline id still lists the run', async () => {
  const pid = await seedPaused('cli-msw-amb');
  const dir = gitDir('cli-msw-amb-t');
  createTicket({ id: `${pid.slice(0, 6)}zz-0000-4000-8000-000000000000`, title: 'amb', projectDir: dir, runAtMs: Date.now() + 86400_000,
    request: { projectDir: dir, prompt: 'amb' } });
  const r = await run(['switch-model', pid.slice(0, 6)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /matches a run and a scheduled run — use a longer id/);
  const ok = await run(['switch-model', pid]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /— paused/);
});
