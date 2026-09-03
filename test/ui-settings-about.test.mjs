// test/ui-settings-about.test.mjs
// Settings ▸ About card: the worca version and the GitHub repo link, both derived
// from package.json (server-side, via GET /api/settings `app`) and never hardcoded
// in the client. Read-only card: no inputs, no Save, no status line.
// Boot harness copied from test/ui-settings-budget.test.mjs:33-71 — every
// ui-*.test.mjs inlines its own copy; there is no shared UI boot helper, and
// importing another *.test.mjs would re-run its whole suite. The only change is
// the /api/settings fixture, which carries the `app` block.
// `chat: {}` in the fixture is load-bearing: loadSettings calls the async
// paintChatSettings(data.chat) WITHOUT awaiting it (app.js:7676), so a throw in
// there would surface as an unhandled rejection and fail this whole file. `{}` is
// the shape test/ui-settings-ask.test.mjs:31 already proves green.
// Everything is a fetch stub — nothing touches disk, so this suite deliberately
// does NOT sandbox HOME/WORCA_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const cssPath = fileURLToPath(new URL('../ui/public/style.css', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// The browsable form of package.json's npm-style repository.url — the same
// normalisation ui/server.mjs performs, asserted independently here.
const REPO_URL = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
// The pre-paint placeholder: U+2014 EM DASH, i.e. what index.html's `&mdash;`
// parses to. Written as an escape, not a literal, so an en-dash (U+2013) typo in
// either file fails loudly instead of looking identical in the diff.
const EM_DASH = '\u2014';

// The `app` block the boot fixture serves. Deliberately NOT package.json's values:
// index.html ships REPO_URL as the static pre-paint href/text, so a fixture built
// from package.json would make painted and unpainted states byte-identical and the
// paint assertions would hold even with paintAbout deleted. Synthetic values keep
// the two states distinguishable. "the version equals package.json's" is the
// SERVER's contract and is asserted in test/settings-api.test.mjs.
const PAINTED_VERSION = '9.9.9-test';
const PAINTED_REPO_URL = 'https://example.com/acme/widget';
// Spelled out rather than derived with the same regex the client uses — a test
// must not re-implement the code it checks.
const PAINTED_REPO_TEXT = 'example.com/acme/widget';

const DAY = 86400000;
const okBudget = () => ({
  pipelineLimitUsd: null, totalLimitUsd: null, resetPeriod: 'monthly',
  windowStartMs: Date.now() - 3 * DAY, windowEndMs: Date.now() + 4 * DAY,
  msUntilReset: 4 * DAY, windowSpendUsd: 0, allTimeSpendUsd: 0,
  remainingUsd: null, blocked: false,
});

// GET /api/settings exactly as the real route answers it, `app` block included.
const okSettings = () => ({
  root: '', projectsRoot: '', projectsRootDefault: '/home/me', default: '/home/me',
  pipelineCostLimitUsd: null, totalCostLimitUsd: null, costLimitResetPeriod: 'monthly',
  askMaxTurns: 40, askMaxBudgetUsd: 2, chat: {},
  app: { version: PAINTED_VERSION, repoUrl: PAINTED_REPO_URL },
});

const settingsView = () => {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  return dom.window.document.querySelector('.view[data-view="settings"]');
};

async function boot({ settings = okSettings } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/settings'))
      return Promise.resolve({ ok: true, status: 200, json: async () => settings() });
    if (u.includes('/api/budget'))
      return Promise.resolve({ ok: true, status: 200, json: async () => okBudget() });
    if (u.includes('/api/projects'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* keep */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const $ = (sel) => window.document.querySelector(sel);
  const openSettings = async () => {
    window.location.hash = 'settings';
    window.dispatchEvent(new window.Event('hashchange'));
    await tick();
  };
  return { window, tick, $, openSettings };
}

test('About is the LAST settings card, read-only, with no version baked into the markup', () => {
  const view = settingsView();
  const cards = [...view.querySelectorAll('section.card.settings-card')];
  const about = cards[cards.length - 1];
  assert.equal(cards.length, 5, 'the four existing cards plus About');
  assert.equal(about.id, 'about-card', 'About sits after the Chat notifications card');
  assert.equal(about.querySelector('.label-row > h2').textContent.trim(), 'About');

  // Read-only: nothing to type, nothing to save, no status line.
  assert.equal(about.querySelector('input, select, textarea, button'), null, 'no controls');
  assert.equal(about.querySelector('.hint'), null, 'no status line (nothing saves)');

  // The version must come from the server, never from the HTML.
  assert.ok(!/\d+\.\d+\.\d+/.test(about.textContent), 'no version string in the markup');
  assert.equal(about.querySelector('#aboutVersion').textContent.trim(), EM_DASH, 'placeholder only');

  // The two existing settings-view invariants stay intact (ui-settings-tooltips).
  assert.equal(view.querySelectorAll('button.info-tip').length, 9, 'About adds no ⓘ icon');
  for (const hint of view.querySelectorAll('.hint')) assert.equal(hint.textContent.trim(), '');
});

test('the repo link opens in a new tab, safely, at the package.json repository', () => {
  const link = settingsView().querySelector('#aboutRepoLink');
  assert.ok(link, 'About card has a repo link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  // The static href is the pre-paint fallback; this assertion is what keeps it
  // from drifting away from package.json.
  assert.equal(link.getAttribute('href'), REPO_URL);
});

test('opening Settings paints the version and repo link from the server payload', async () => {
  const { $, openSettings } = await boot();
  await openSettings();
  // Every value below is the fixture's, and none of them appears in index.html —
  // so each assertion fails if paintAbout (or either half of it) stops running.
  assert.equal($('#aboutVersion').textContent.trim(), PAINTED_VERSION, 'version painted from the payload');
  assert.equal($('#aboutRepoLink').getAttribute('href'), PAINTED_REPO_URL, 'href painted from the payload');
  assert.equal($('#aboutRepoLink').textContent.trim(), PAINTED_REPO_TEXT, 'link text is the URL without its scheme');
  assert.equal($('#aboutRepoLink').getAttribute('target'), '_blank', 'paint never drops target');
  assert.equal($('#aboutRepoLink').getAttribute('rel'), 'noopener noreferrer', 'paint never drops rel');
});

test('a payload with no `app` block leaves the static fallback alone (never blanks the card)', async () => {
  const noApp = () => { const s = okSettings(); delete s.app; return s; };
  const { $, openSettings } = await boot({ settings: noApp });
  await openSettings();
  assert.equal($('#aboutVersion').textContent.trim(), EM_DASH, 'placeholder kept, not emptied');
  assert.equal($('#aboutRepoLink').getAttribute('href'), REPO_URL, 'static href kept');
  // Without paintAbout's `if (!info) return`, the card looks identical (it is
  // never touched) but the missing guard throws and loadSettings' catch turns
  // that into an error line — which also aborts every paint after this one.
  assert.equal($('#settingsMsg').textContent.trim(), '', 'the rest of the settings paint still ran');
});

test('a malformed `repoUrl` cannot abort the rest of the settings paint', async () => {
  const badUrl = () => ({ ...okSettings(), app: { version: PAINTED_VERSION, repoUrl: 42 } });
  const { $, openSettings } = await boot({ settings: badUrl });
  await openSettings();
  assert.equal($('#settingsMsg').textContent.trim(), '', 'no throw reached the loadSettings catch');
  assert.equal($('#aboutRepoLink').getAttribute('href'), REPO_URL, 'static href kept');
  assert.equal($('#aboutVersion').textContent.trim(), PAINTED_VERSION, 'the usable half still painted');
});

test('style.css styles the About rows', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.ok(css.includes('.about-row{'), '.about-row rule');
  assert.ok(css.includes('.about-key{'), '.about-key rule');
  assert.ok(css.includes('.about-val{'), '.about-val rule');
  assert.ok(css.includes('.about-version{'), '.about-version rule');
  assert.ok(css.includes('.about-link{'), '.about-link rule');
  // Equal specificity, both carried by the anchor: .about-link must win on source
  // order or the link loses its green. style.css says so in capitals; pin it.
  assert.ok(css.indexOf('.about-val{') < css.indexOf('.about-link{'),
    '.about-link must stay after .about-val');
});
