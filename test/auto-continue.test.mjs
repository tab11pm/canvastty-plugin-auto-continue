import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, badgeFor, detectLimit, nextAction, pickReset, showsLimitMenu } from '../services/auto-continue.mjs';

const entry = fileURLToPath(new URL('../services/auto-continue.mjs', import.meta.url));
const MENU = "⎿  You've hit your limit · resets 3am (Asia/Novosibirsk)\n What do you want to do?\n ❯ 1. Upgrade your plan\n   2. Stop and wait for limit to reset\n Enter to confirm · Esc to cancel";
const CLAUDE_BANNER = "● Working on the parser…\n⎿  5-hour limit reached ∙ resets 3am\n   /upgrade to increase your usage limit.\n\n❯ ";
const CODEX_BANNER = "■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 9:12 PM.\n\n› ";
const options = { graceMs: 0, verifyMs: 1_000, retryMs: 5_000, maxAttempts: 3 };

test('limit stops are recognised at the end of the screen, for Claude and Codex', () => {
  assert.equal(showsLimitMenu(MENU), true);
  assert.equal(detectLimit(MENU, 'claude'), 'reset');
  assert.equal(detectLimit(CLAUDE_BANNER, 'claude'), 'reset');
  assert.equal(detectLimit(CODEX_BANNER, 'codex'), 'reset');
  assert.equal(detectLimit("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.\n❯ ", 'claude'), 'model');
  assert.equal(detectLimit('API Error: Server is temporarily limiting requests (not your usage limit) · resets 3pm\n❯ ', 'claude'), null);
  assert.equal(detectLimit('If you keep going you could hit your limit; it resets 3pm.\n❯ ', 'claude'), null);
  assert.equal(detectLimit(`${CLAUDE_BANNER}\n${'output line\n'.repeat(30)}❯ `, 'claude'), null, 'an old banner scrolled away');
  assert.equal(detectLimit('❯ ', 'claude'), null);
});

test('the reset time is the exhausted window in CanvasTTY limits, weekly over 5-hour', () => {
  const at = (hours) => Date.UTC(2026, 10, 6, hours);
  const snapshot = (claude) => ({ fetchedAt: 1, providers: [
    { provider: 'codex', state: 'available', windows: [{ usedPercent: 100, resetsAt: at(1) }] },
    { provider: 'claude', state: 'available', windows: claude }
  ] });
  assert.equal(pickReset(snapshot([{ usedPercent: 100, resetsAt: at(3) }, { usedPercent: 40, resetsAt: at(90) }]), 'claude'), at(3));
  assert.equal(pickReset(snapshot([{ usedPercent: 100, resetsAt: at(3) }, { usedPercent: 100, resetsAt: at(90) }]), 'claude'), at(90));
  assert.equal(pickReset(snapshot([{ usedPercent: 97, resetsAt: at(3) }]), 'claude'), null, 'not full yet: maybe a stale cache');
  assert.equal(pickReset(snapshot([{ usedPercent: 97, resetsAt: at(3) }]), 'claude', true), at(3), 'after retries 95 % counts');
  assert.equal(pickReset(snapshot([{ usedPercent: null, resetsAt: at(3) }]), 'claude', true), null);
  assert.equal(pickReset({ providers: [{ provider: 'claude', state: 'unavailable', reason: 'x' }] }, 'claude'), null);
  assert.equal(pickReset(null, 'claude'), null);
});

test('the default resume message is the plugin own English text', () => {
  assert.equal(DEFAULTS.resumeMessage, 'The usage limit has reset. Continue the task from where you stopped and finish it.');
});

test('badges fit 24 characters', () => {
  const now = new Date('2026-11-05T10:00:00Z').getTime();
  for (const locale of ['ru', 'en']) {
    for (const resetAt of [now + 3_600_000, now + 3 * 86_400_000, null]) assert.ok(badgeFor(resetAt, locale, now).text.length <= 24);
  }
  assert.match(badgeFor(now + 3_600_000, 'ru', now).text, /^⏸ до \d\d:\d\d$/u);
});

test('job steps: locate, wait, send through the menu, confirm, retry, drop', () => {
  const job = { cardId: 'c', agent: 'claude', resetAt: 100, attempts: 0, lookups: 0, phase: 'waiting', due: 100 };
  const idle = { id: 'c', status: 'idle', exitCode: null };
  assert.equal(nextAction({ ...job, phase: 'locating', due: 0 }, idle, '', 50, options).kind, 'locate');
  assert.equal(nextAction(job, idle, MENU, 50, options).kind, 'wait');
  assert.equal(nextAction(job, idle, MENU, 100, options).kind, 'dismiss-and-send');
  assert.equal(nextAction(job, idle, '❯ ', 100, options).kind, 'send');
  assert.equal(nextAction(job, { ...idle, status: 'needs_approval' }, '', 100, options).kind, 'retry');
  assert.equal(nextAction(job, { ...idle, status: 'working' }, '', 50, options).kind, 'drop', 'the person continued');
  assert.equal(nextAction(job, null, '', 100, options).kind, 'drop');
  assert.equal(nextAction({ ...job, attempts: 3 }, idle, '', 100, options).kind, 'give-up');
  const sent = { ...job, phase: 'sent', sentAt: 1_000 };
  assert.equal(nextAction(sent, { ...idle, status: 'working' }, '', 1_100, options).kind, 'done');
  assert.equal(nextAction(sent, idle, MENU, 1_500, options).kind, 'wait');
  assert.equal(nextAction(sent, idle, MENU, 2_500, options).kind, 'retry');
  assert.equal(nextAction(sent, idle, '❯ ', 2_500, options).kind, 'done');
});

test('manifest passes the CanvasTTY validator', async (t) => {
  let validatePluginManifest;
  try {
    ({ validatePluginManifest } = await import(new URL('../../CanvasTTY/src/main/services/PluginManager.ts', import.meta.url)));
  } catch {
    t.skip('CanvasTTY checkout not found next to this plugin');
    return;
  }
  const manifest = JSON.parse(await readFile(new URL('../canvastty.plugin.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validatePluginManifest(manifest));
});

/** Runs the real service against a scripted host: one Claude card the person opened runs into its limit. */
test('the service sees the stop, takes the reset from CanvasTTY limits and resumes in the same card', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-continue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = dir;
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ graceMs: 0, tickMs: 100, verifyMs: 60_000, resumeMessage: 'continue please' }));

  const resetAt = Date.now() + 700;
  const card = { id: 'card-1', provider: 'claude', role: 'agent', title: 'Mine', status: 'working', exitCode: null };
  const calls = [];
  const logs = [];
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const event = (screen) => send({ method: 'canvastty.sessions.event', params: { type: 'status', session: { ...card }, owned: false, screen } });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'log') { logs.push(message.params.message); return; }
    calls.push(message);
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
      case 'storage.get': case 'storage.set': case 'cards.setBadge': return reply(null);
      case 'sessions.subscribe':
        reply({ sessions: [{ ...card }] });
        // The turn ends at the limit: Claude shows its usage-limit options.
        card.status = 'idle';
        return event(MENU);
      case 'sessions.list': return reply({ sessions: [{ ...card }] });
      case 'limits.get': return reply({ state: 'ready', snapshot: { fetchedAt: Date.now(), providers: [
        { provider: 'claude', state: 'available', windows: [{ usedPercent: 100, resetsAt: resetAt }, { usedPercent: 60, resetsAt: resetAt + 86_400_000 }] }
      ] } });
      case 'sessions.dismiss': return reply({ sessionId: card.id, dismissed: true });
      case 'sessions.send':
        reply({ sessionId: card.id, sent: true, delivery: { stage: 'submitted', acceptance: 'confirmed' } });
        card.status = 'working';
        return event('❯ continue please');
      default:
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'no' } });
    }
  });
  let check;
  const finished = new Promise((resolve) => {
    check = setInterval(() => {
      if (calls.some((call) => call.method === 'cards.setBadge' && call.params.badge === null)) resolve();
    }, 20);
  });
  t.after(() => clearInterval(check));
  send({ method: 'canvastty.initialize', params: { apiVersion: 2, pluginId: 'dev.tab11pm.auto-continue', serviceId: 'continue', dataDir, locale: 'ru' } });
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() =>
    reject(new Error(`scenario timed out: ${JSON.stringify({ logs, calls: calls.map((call) => call.method) })}`)), 8_000).unref())]);

  const methods = calls.map((call) => call.method).filter((method) => !method.startsWith('storage.') && method !== 'sessions.list');
  assert.deepEqual(methods, ['sessions.subscribe', 'cards.setBadge', 'limits.get', 'cards.setBadge', 'sessions.dismiss', 'sessions.send', 'cards.setBadge', 'cards.setBadge']);
  const badges = calls.filter((call) => call.method === 'cards.setBadge').map((call) => call.params.badge);
  assert.equal(badges[0].text, '⏸ лимит', 'reset not known before limits answer');
  assert.match(badges[1].text, /^⏸ до \d\d:\d\d$/u);
  assert.equal(badges.at(-1), null);
  assert.deepEqual(calls.find((call) => call.method === 'sessions.send').params, { sessionId: 'card-1', text: 'continue please', submit: true });
});
