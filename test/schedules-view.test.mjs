// test/schedules-view.test.mjs — the view's ticket accessors: every model ticket (upcoming() drops
// the ones more than a window out), an optimistic upsert by id, and a forget.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:4317/#schedules' });
for (const k of ['document', 'location', 'DOMParser']) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
const { createSchedulesView } = await import('../ui/public/schedules-view.mjs');

const summary = { target: 'project', workflowId: 'wf_default', prompt: 'p', source: null, sourceBranch: null, mock: false };
const ticketAt = (id, ms, extra = {}) => ({ id, kind: 'once', scheduleId: null, title: id, runAt: new Date(Date.now() + ms).toISOString(),
  scheduledFor: new Date(Date.now() + ms).toISOString(), status: 'scheduled', ifMissed: 'run', graceMin: 360, summary, ...extra });
const SOON = ticketAt('t_soon', 3600_000);
const WEEK = ticketAt('t_week', 3 * 86400_000, { resumePipelineId: 'p_1' });

async function mount(extra = {}) {
  globalThis.fetch = async (url) => {
    const key = String(url).split('?')[0];
    const body = key === '/api/schedules' ? { schedules: [], tickets: [SOON, WEEK], counts: {}, ...extra } : { notifications: [], unread: 0 };
    return { ok: true, status: 200, json: async () => body };
  };
  const host = () => document.createElement('div');
  const hosts = { feedHost: host(), onceHost: host(), repeatingHost: host() };
  document.body.replaceChildren(hosts.feedHost, hosts.onceHost, hosts.repeatingHost);
  const view = createSchedulesView({ ...hosts, msgEl: document.createElement('p'), deps: { confirmModal: async () => true, targetLabel: () => '', workflowLabel: () => '' } });
  await view.load();
  return view;
}

test('tickets() lists every model ticket, including ones upcoming() leaves out', async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.tickets().map((t) => t.id), ['t_soon', 't_week']);
    assert.deepEqual(view.upcoming(86400_000).map((t) => t.id), ['t_soon'], 'upcoming() drops a ticket more than 24h out');
  } finally { view.destroy(); }
});

test('noteTicket() upserts by id; forgetTicket() removes one', async () => {
  const view = await mount();
  try {
    view.noteTicket({ ...WEEK, status: 'firing' });
    assert.equal(view.tickets().length, 2, 'same id: replaced, not appended');
    assert.equal(view.tickets().find((t) => t.id === 't_week').status, 'firing');
    view.noteTicket(ticketAt('t_new', 7200_000, { resumePipelineId: 'p_2' }));
    assert.deepEqual(view.tickets().map((t) => t.id), ['t_soon', 't_week', 't_new']);
    view.forgetTicket('t_week');
    assert.deepEqual(view.tickets().map((t) => t.id), ['t_soon', 't_new']);
    view.forgetTicket('nope');
    assert.equal(view.tickets().length, 2, 'an unknown id is a no-op');
  } finally { view.destroy(); }
});

test('chains() is empty without a server list, and reflects the loaded chains otherwise', async () => {
  const bare = await mount();
  try {
    assert.deepEqual(bare.chains(), []);
  } finally { bare.destroy(); }
  const chains = [{ id: 'c_1', tickets: ['t_soon', 't_week'] }];
  const view = await mount({ chains });
  try {
    assert.deepEqual(view.chains(), chains);
    assert.equal(view.chains(), view.chains(), 'the same array until the next load()');
  } finally { view.destroy(); }
});

test('a row that follows a preset names it; a deleted preset says the next run will fail', async () => {
  const live = ticketAt('t_preset', 3600_000, { presetId: 'rp_aaaaaaaaaaaa', presetName: 'Quick fix' });
  const gone = ticketAt('t_gone', 7200_000, { presetId: 'rp_bbbbbbbbbbbb', presetName: null, presetGoneName: 'Old fix' });
  const view = await mount({ tickets: [live, gone] });
  try {
    const text = document.body.textContent;
    assert.match(text, /preset Quick fix/);
    assert.match(text, /Quick fix \(read when the run starts\)/);
    assert.match(text, /preset deleted/);
    assert.match(text, /Old fix \(deleted: the next run will fail\)/);
  } finally { view.destroy(); }
});

test('a request that carries a pr shows a Pull request row in Details; one without shows none', async () => {
  const withPr = ticketAt('t_pr', 3600_000, { summary: { ...summary, pr: { open: 'draft', slices: 'one' } } });
  const without = ticketAt('t_nopr', 7200_000);
  const view = await mount({ tickets: [withPr, without] });
  try {
    const rows = (id) => [...document.querySelector(`[data-id="${id}"]`).querySelectorAll('.sched-kv')].map((r) => r.textContent);
    assert.ok(rows('t_pr').includes('Pull requestCreate a draft PR · One PR for the whole feature'), rows('t_pr').join('|'));
    assert.equal(rows('t_nopr').some((t) => t.startsWith('Pull request')), false);
  } finally { view.destroy(); }
});

test('run 4 D22: feed messages read as plain words; the raw detail is kept for the tooltip', async () => {
  const { plainFeedMessage } = await import('../ui/public/schedules-view.mjs');
  assert.deepEqual(plainFeedMessage('paused (drain): Paused while worca was stopping'),
    { text: 'paused · worca was stopping', detail: 'Paused while worca was stopping' });
  assert.deepEqual(plainFeedMessage("paused (usage limit): You've hit your usage limit — resume on Claude, Copilot or Cursor to continue now."),
    { text: 'paused · usage limit reached. Resume on Claude, Copilot or Cursor to continue now.', detail: "You've hit your usage limit" });
  assert.deepEqual(plainFeedMessage('paused (usage limit). resume on Claude to continue now.'),
    { text: 'paused · usage limit reached. Resume on Claude to continue now.', detail: '' });
  assert.deepEqual(plainFeedMessage('ended with an error: spawn ENOENT'), { text: 'ended with an error', detail: 'spawn ENOENT' });
  assert.deepEqual(plainFeedMessage('could not start: project not found.'), { text: 'could not start', detail: 'project not found' });
  assert.deepEqual(plainFeedMessage('finished.'), { text: 'finished.', detail: '' });
  assert.deepEqual(plainFeedMessage('paused (something new): x'), { text: 'paused', detail: 'x' });
});

/** Mount with a fetch stub that answers by "METHOD path" and records every call. */
async function mountWith(routes, deps = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const key = `${method} ${String(url).split('?')[0]}`;
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
    const body = routes[key] ?? (key === 'GET /api/schedules' ? routes.list : { notifications: [], unread: 0 });
    return { ok: true, status: 200, json: async () => body };
  };
  const host = () => document.createElement('div');
  const hosts = { feedHost: host(), onceHost: host(), repeatingHost: host() };
  document.body.replaceChildren(hosts.feedHost, hosts.onceHost, hosts.repeatingHost);
  const view = createSchedulesView({ ...hosts, msgEl: document.createElement('p'),
    deps: { confirmModal: async () => true, targetLabel: () => '', workflowLabel: () => '', ...deps } });
  await view.load();
  return { view, calls };
}
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
}
const seriesOf = (id, extra = {}) => ({ id, kind: 'recurring', title: id, status: 'active', pauseReason: null, sentence: 'Every day at 02:00', tz: 'UTC',
  rule: { freq: 'daily', time: '02:00', tz: 'UTC' }, overlap: 'skip', maxFailures: 3, failureStreak: 0, ifMissed: 'run', graceMin: 360, runsCount: 0,
  nextRunAt: null, lastResult: null, createdBy: null, updatedBy: null, summary, ...extra });

test('Models… shows on a waiting or missed one-off card and a repeating card; never on a resume, Auto, held or firing ticket, or an Auto series', async () => {
  const tickets = [ticketAt('t_plain', 3600_000), ticketAt('t_missed', -3600_000, { status: 'missed' }),
    ticketAt('t_resume', 3600_000, { resumePipelineId: 'p_1' }),
    ticketAt('t_auto', 3600_000, { summary: { ...summary, workflowId: 'wf_auto' } }), ticketAt('t_held', 3600_000, { ownerPid: 4242 }),
    ticketAt('t_firing', 3600_000, { status: 'firing' })];
  const { view } = await mountWith({ list: { schedules: [seriesOf('sch_aaaa1111'), seriesOf('sch_bbbb2222', { summary: { ...summary, workflowId: 'wf_auto' } })], tickets, counts: {} } });
  try {
    const has = (id) => !!document.querySelector(`.sched-item[data-id="${id}"] .sched-models-btn`);
    assert.deepEqual(['t_plain', 't_missed', 't_resume', 't_auto', 't_held', 't_firing', 'sch_aaaa1111', 'sch_bbbb2222'].map(has),
      [true, true, false, false, false, false, true, false]);
  } finally { view.destroy(); }
});

test('Models…: the click fetches the payload into a panel under the card; Save posts the diff, toasts and reloads', async () => {
  const PAYLOAD = { kind: 'once', id: 't_plain', title: 't_plain', status: 'scheduled', fields: ['model', 'effort', 'subagentModel'],
    models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['medium', 'high'] }], efforts: ['medium', 'high'], subagents: true,
    subagentModels: ['sonnet', 'opus'], subagentEfforts: [], preset: null, pendingTickets: 0,
    stages: [{ nodeId: 'n_plan', key: 'planner', label: 'Planner', fanOut: true, model: '', effort: '', subagentModel: '', picked: false,
      projectDefault: null, state: 'scheduled', switchable: true }] };
  const notes = [];
  const { view, calls } = await mountWith({
    list: { schedules: [], tickets: [ticketAt('t_plain', 3600_000)], counts: {} },
    'GET /api/schedules/t_plain/models': PAYLOAD,
    'POST /api/schedules/t_plain/models': { ok: true, kind: 'once', id: 't_plain', changed: [{ nodeId: 'n_plan' }], warnings: [], pendingTickets: 0 },
  }, { notify: (o) => notes.push(o) });
  try {
    document.querySelector('.sched-item[data-id="t_plain"] .sched-models-btn').click();
    await until(() => document.querySelector('.sched-item[data-id="t_plain"] .sched-models .msw'));
    const sel = document.querySelector('.sched-models tr[data-node="n_plan"] select[data-field="model"]');
    sel.value = 'claude-opus-5-5'; sel.dispatchEvent(new window.Event('change'));
    document.querySelector('.sched-models .msw-save').click();
    const post = await until(() => calls.find((c) => c.key === 'POST /api/schedules/t_plain/models'));
    assert.deepEqual(post.body, { changes: { n_plan: { model: 'claude-opus-5-5', effort: '' } } });
    await until(() => notes.length);
    assert.equal(notes[0].title, 'Switched 1 stage');
    await until(() => !document.querySelector('.sched-models'));
    assert.ok(calls.filter((c) => c.key === 'GET /api/schedules').length >= 2, 'reloaded after the save');
  } finally { view.destroy(); }
});

test('a card with picks says "Agents: N picked" in its details; a "changed" feed entry renders as a blue Changed badge', async () => {
  const picked = ticketAt('t_picked', 3600_000, { summary: { ...summary, agentPicks: 2 } });
  const { view } = await mountWith({
    list: { schedules: [], tickets: [picked], counts: {} },
    'GET /api/notifications': { notifications: [{ id: 1, kind: 'changed', severity: 'info', title: 'Nightly', ticketId: 't_picked', scheduleId: null,
      message: 'agent models changed: Planner → Opus 5.5 · high.', createdAt: new Date().toISOString(), unread: false, resolvedAt: null }], unread: 0 },
  });
  try {
    assert.match(document.querySelector('.sched-item[data-id="t_picked"] .sched-details-body').textContent, /Agents2 picked/);   // label + value, no separator
    const badge = document.querySelector('.sched-feed-kind .badge');
    assert.equal(badge.textContent, 'Changed');
    assert.ok(badge.classList.contains('blue'));
  } finally { view.destroy(); }
});

test('a resolved problem in the feed reads as resolved, says what happened next, opens its run, and counts nowhere', async () => {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const row = (extra) => ({ scope: 'schedule', scheduleId: null, projectDir: '/p', createdAt: at, readAt: null, resolvedAt: null, ...extra });
  const feed = [
    row({ id: 3, kind: 'started', severity: 'info', ticketId: 't_res', pipelineId: 'p_run2', title: 'Run 2', message: 'started after all, when ‘Chat MCP’ finished.', unread: false }),
    row({ id: 2, kind: 'missed', severity: 'problem', ticketId: 't_open', pipelineId: null, title: 'Still missed', message: 'was waiting for ‘A’, which was stopped.', unread: true }),
    // `unread: true` on a resolved row: an older server, or a row marked unread again — the view still never counts it.
    row({ id: 1, kind: 'missed', severity: 'problem', ticketId: 't_res', pipelineId: 'p_run2', title: 'Run 2', message: 'was waiting for ‘Chat MCP’, which was interrupted.', unread: true, resolvedAt: at }),
  ];
  globalThis.fetch = async (url) => {
    const key = String(url).split('?')[0];
    const body = key === '/api/schedules' ? { schedules: [], tickets: [ticketAt('t_open', -3600_000, { status: 'missed' })], counts: {} } : { notifications: feed, unread: 1 };
    return { ok: true, status: 200, json: async () => body };
  };
  const opened = [];
  const tabsHost = document.createElement('div');
  for (const t of ['activity', 'once', 'repeating']) { const b = document.createElement('button'); b.dataset.tab = t; tabsHost.append(b); }
  const hosts = { feedHost: document.createElement('div'), onceHost: document.createElement('div'), repeatingHost: document.createElement('div') };
  document.body.replaceChildren(tabsHost, hosts.feedHost, hosts.onceHost, hosts.repeatingHost);
  const view = createSchedulesView({ tabsHost, ...hosts, msgEl: document.createElement('p'),
    deps: { confirmModal: async () => true, targetLabel: () => '', workflowLabel: () => '', openRun: (x) => opened.push(x) } });
  try {
    await view.load();
    const item = (id) => hosts.feedHost.querySelector(`.sched-feed-item[data-id="${id}"]`);
    const buttons = (id) => [...item(id).querySelectorAll('button')].map((b) => b.textContent);
    const res = item(1);
    assert.ok(res.classList.contains('resolved'));
    assert.ok(!res.classList.contains('unread'), 'never painted as unread');
    assert.equal(res.querySelector('.badge').className, 'badge grey', 'neutral, not amber');
    assert.equal(res.querySelector('.sched-feed-resolved').textContent, 'Resolved · started after all, when ‘Chat MCP’ finished.');
    assert.deepEqual(buttons(1), ['Open run']);
    res.querySelector('.sched-feed-open').click();
    assert.deepEqual(opened, [{ pipelineId: 'p_run2', projectDir: '/p' }]);
    assert.equal(item(3).querySelector('.badge').textContent, 'Started');
    // The open miss is still a problem: amber, unread, Run now + Mark read.
    const open = item(2);
    assert.ok(open.classList.contains('unread')); assert.ok(!open.classList.contains('resolved'));
    assert.equal(open.querySelector('.badge').className, 'badge amber');
    assert.equal(open.querySelector('.sched-feed-resolved'), null);
    assert.deepEqual(buttons(2), ['Run now', 'Mark read']);
    // Counts: only the open problem.
    assert.equal(tabsHost.querySelector('[data-tab="activity"]').textContent, 'Activity · 1');
    const seg = (label) => [...hosts.feedHost.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith(label));
    assert.equal(seg('Unread').textContent, 'Unread · 1');
    seg('Problems').click();
    assert.deepEqual([...hosts.feedHost.querySelectorAll('.sched-feed-item')].map((r) => r.dataset.id), ['2']);
    seg('Unread').click();
    assert.deepEqual([...hosts.feedHost.querySelectorAll('.sched-feed-item')].map((r) => r.dataset.id), ['2']);
  } finally { view.destroy(); }
});

test('a resolved miss with no run says only Resolved; one whose run is known but has no started entry says it started', async () => {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const feed = [
    { id: 5, scope: 'schedule', kind: 'missed', severity: 'problem', ticketId: 't_a', scheduleId: null, pipelineId: null, projectDir: '/p', title: 'A', message: 'was due.', createdAt: at, unread: false, resolvedAt: at },
    { id: 4, scope: 'schedule', kind: 'failed', severity: 'problem', ticketId: 't_b', scheduleId: null, pipelineId: 'p_b', projectDir: '/p', title: 'B', message: 'could not start: x.', createdAt: at, unread: false, resolvedAt: at },
  ];
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).startsWith('/api/schedules') ? { schedules: [], tickets: [], counts: {} } : { notifications: feed, unread: 0 }) });
  const hosts = { feedHost: document.createElement('div'), onceHost: document.createElement('div'), repeatingHost: document.createElement('div') };
  document.body.replaceChildren(hosts.feedHost, hosts.onceHost, hosts.repeatingHost);
  const view = createSchedulesView({ ...hosts, msgEl: document.createElement('p'), deps: { confirmModal: async () => true, targetLabel: () => '', workflowLabel: () => '', openRun: () => {} } });
  try {
    await view.load();
    const note = (id) => hosts.feedHost.querySelector(`.sched-feed-item[data-id="${id}"] .sched-feed-resolved`).textContent;
    assert.equal(note(5), 'Resolved.');
    assert.equal(note(4), 'Resolved · the run started after all.');
    assert.equal(hosts.feedHost.querySelector('.sched-feed-item[data-id="5"] .sched-feed-open'), null, 'no run: no Open run');
  } finally { view.destroy(); }
});
