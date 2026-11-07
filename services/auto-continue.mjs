// CanvasTTY service: resumes an agent that stopped at its usage limit, in the same card, when the limit resets.
//
// The stop is seen on the card itself: a working -> idle change whose screen ends in the provider's limit
// banner. The reset time comes from CanvasTTY's own limits (`limits.get`, the snapshot HOME shows). After the
// reset the resume message is typed into that card (`sessions:control-any`), Claude's limit menu dismissed first.
//
// A single file with no dependencies: CanvasTTY runs only the trusted entry file.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  // After the reset time, before typing: the provider's window may lag a little.
  graceMs: 20_000,
  tickMs: 10_000,
  // CanvasTTY caches limits for 60 s: a stop seen just now may not be in the snapshot yet.
  lookupRetryMs: 70_000,
  lookupSlowMs: 5 * 60_000,
  // Lookups without an exhausted window before the stop is taken for a false one (about half an hour).
  maxLookups: 8,
  // How long a sent resume may stay without a new turn before the screen is checked again.
  verifyMs: 90_000,
  retryMs: 5 * 60_000,
  maxAttempts: 5,
  resumeMessage: 'The usage limit has reset. Continue the task from where you stopped and finish it.',
  // Test mode: a card with this title is treated as stopped, with the reset this far ahead.
  testCardTitle: '',
  testResetInMs: 60_000
};

const AGENTS = new Set(['claude', 'codex']);

// Banner patterns from unsnooze (src/agents/claude.js, src/agents/codex.js, src/patterns.js).
const CLAUDE_LIMIT = [/(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/iu, /\d+-hour limit/iu, /limit reached/iu, /usage limit/iu];
const CLAUDE_RESET = [/resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/iu, /resets?\s+in[:\s]\s*\d/iu, /try again in \d+\s*(?:hours?|minutes?|h|m)/iu,
  /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/iu];
const CODEX_LIMIT = [/You['’]ve hit your usage limit/iu, /Your workspace is out of credits/iu, /hit your spend cap/iu, /Your rate limit resets on/iu];
// A per-model limit has no reset time: waiting does not clear it.
const MODEL_LIMIT = /(?:reached|hit)\s+(?:your|the)\s+[\w.\s-]{0,24}?\blimit\b/iu;
const MODEL_REMEDY = /\/usage-credits\b|switch\s+models?\b|\/model\b/iu;
// "not your usage limit" (a server throttle) and "you could hit your limit" are not stops.
const DISCLAIMED = /\bnot\s+(?:your|a|an|the)\s+(?:[\w-]+\s+){0,2}limit\b/iu;
const HYPOTHETICAL = /\b(?:could|would|might|may|will|can|if you)\b[^.]{0,40}?\b(?:reached|hit)\b/iu;

function tailLines(text, count = 14) {
  return String(text ?? '').split('\n').filter((line) => line.trim()).slice(-count);
}

/** Claude's /rate-limit-options menu (the same test unsnooze uses before answering it). */
export function showsLimitMenu(screen) {
  const tail = tailLines(screen).join('\n');
  return /what do you want to do\?/iu.test(tail) && /stop and wait for limit to reset/iu.test(tail);
}

/**
 * A usage-limit stop at the end of the screen: `reset` (waiting clears it), `model` (a per-model limit,
 * nothing to wait for) or null.
 */
export function detectLimit(screen, provider) {
  const lines = tailLines(screen).filter((line) => !DISCLAIMED.test(line) && !HYPOTHETICAL.test(line));
  if (provider === 'codex') return lines.some((line) => CODEX_LIMIT.some((pattern) => pattern.test(line))) ? 'reset' : null;
  if (showsLimitMenu(screen)) return 'reset';
  for (let index = 0; index < lines.length; index += 1) {
    if (!CLAUDE_LIMIT.some((pattern) => pattern.test(lines[index]))) continue;
    const near = lines.slice(Math.max(0, index - 3), index + 4);
    if (near.some((line) => CLAUDE_RESET.some((pattern) => pattern.test(line)))) return 'reset';
  }
  const joined = lines.join('\n');
  return MODEL_LIMIT.test(joined) && MODEL_REMEDY.test(joined) ? 'model' : null;
}

/**
 * The reset time of the provider's exhausted window in a CanvasTTY `LimitsSnapshot`: the latest `resetsAt` of a
 * window at 100 % (or, with `near`, at 95 %), so a weekly limit wins over the 5-hour one. Null when none is.
 */
export function pickReset(snapshot, provider, near = false) {
  const entry = snapshot?.providers?.find((candidate) => candidate?.provider === provider);
  if (!entry || !Array.isArray(entry.windows)) return null;
  const windows = entry.windows.filter((window) => typeof window?.resetsAt === 'number' && typeof window.usedPercent === 'number');
  for (const threshold of near ? [100, 95] : [100]) {
    const full = windows.filter((window) => window.usedPercent >= threshold);
    if (full.length) return Math.max(...full.map((window) => window.resetsAt));
  }
  return null;
}

/** A badge (at most 24 characters) with the local reset time. */
export function badgeFor(resetAt, locale = 'en', now = Date.now()) {
  const ru = locale === 'ru';
  if (typeof resetAt !== 'number') {
    return { text: ru ? '⏸ лимит' : '⏸ limit', tone: 'warn', tooltip: ru ? 'Время сброса ещё неизвестно' : 'Reset time not known yet' };
  }
  const date = new Date(resetAt);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(ru ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = sameDay ? '' : `${date.toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { day: '2-digit', month: '2-digit' })} `;
  return { text: `${ru ? '⏸ до' : '⏸ until'} ${day}${time}`.slice(0, 24), tone: 'info',
    tooltip: ru ? 'Продолжит в этой карточке после сброса лимита' : 'Resumes in this card when the limit resets' };
}

/**
 * The next step of one job, given its card as the host reports it.
 * Jobs: `{ cardId, agent, phase: 'locating' | 'waiting' | 'sending' | 'sent', due, resetAt, lookups, attempts, sentAt? }`;
 * `sending` covers the host calls of one resume, so the turn it starts is not taken for the person's.
 */
export function nextAction(job, card, screen, now, options = DEFAULTS) {
  if (!card || card.exitCode != null) return { kind: 'drop', reason: 'card closed or agent exited' };
  if (job.phase === 'locating' || job.phase === 'waiting') {
    // A turn started before the reset (the person continued): theirs now.
    if (card.status === 'working') return { kind: 'drop', reason: 'continued before the reset' };
    if (now < job.due) return { kind: 'wait' };
    if (job.phase === 'locating') {
      // No provider window is full: the banner was output that only looked like one.
      return job.lookups >= options.maxLookups ? { kind: 'drop', reason: 'no exhausted limit window found' } : { kind: 'locate' };
    }
    if (job.attempts >= options.maxAttempts) return { kind: 'give-up' };
    if (card.status === 'needs_approval') return { kind: 'retry', reason: 'card waits for an approval' };
    return { kind: showsLimitMenu(screen) ? 'dismiss-and-send' : 'send' };
  }
  if (job.phase === 'sent') {
    if (card.status === 'working') return { kind: 'done' };
    if (now - job.sentAt < options.verifyMs) return { kind: 'wait' };
    if (detectLimit(screen, job.agent) === 'reset') return { kind: 'retry', reason: 'still limited' };
    // Idle again without a limit banner: the turn was short and finished.
    return { kind: 'done' };
  }
  return { kind: 'wait' };
}

// --- service ---------------------------------------------------------------------------------------

function service() {
  const options = { ...DEFAULTS };
  let locale = 'en';
  let ready = false;
  let ticking = false;
  let timer;
  let nextId = 1;
  const pending = new Map();
  /** cardId -> latest summary and screen tail from session events. */
  const cards = new Map();
  /** cardId -> job */
  let jobs = {};
  /** Test mode runs once per card and service start. */
  const tested = new Set();

  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const log = (message, level = 'info') => send({ method: 'log', params: { level, message } });
  const request = (method, params, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params });
  });

  const readJson = async (path) => {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  };
  const save = () => request('storage.set', { key: 'state', value: { jobs } }).catch((error) => log(`saving: ${error.message}`, 'warn'));
  const setBadge = (cardId, badge) => request('cards.setBadge', { sessionId: cardId, badge }).catch((error) => log(`badge: ${error.message}`, 'warn'));


  function startJob(card, why, resetAt = null) {
    const now = Date.now();
    jobs[card.id] = {
      cardId: card.id, agent: card.provider, title: card.title, lookups: 0, attempts: 0, resetAt,
      phase: resetAt === null ? 'locating' : 'waiting', due: resetAt === null ? now : resetAt + options.graceMs
    };
    log(`"${card.title}" (${card.provider}) stopped at its usage limit (${why})`);
    setBadge(card.id, badgeFor(resetAt, locale, now));
    save();
  }

  /** Ends a job and clears its badge (or shows `badge`). */
  function endJob(job, kind, reason, badge = null) {
    delete jobs[job.cardId];
    if (cards.has(job.cardId)) setBadge(job.cardId, badge);
    log(`"${job.title}": ${kind}${reason ? ` (${reason})` : ''}`, kind === 'give-up' ? 'warn' : 'info');
  }

  /** Session events: a working -> idle change that ends in a limit banner is a stop. */
  function observe(type, summary, screen) {
    const previous = cards.get(summary.id);
    if (type === 'closed') { cards.delete(summary.id); return; }
    cards.set(summary.id, { summary, screen: screen ?? previous?.screen ?? '' });
    const job = jobs[summary.id];
    // A turn started before the reset is the person's, however short: ticks alone could miss it.
    if (job && summary.status === 'working' && (job.phase === 'locating' || job.phase === 'waiting')) {
      endJob(job, 'drop', 'continued before the reset');
      save();
      return;
    }
    if (!AGENTS.has(summary.provider) || jobs[summary.id] || summary.status !== 'idle') return;
    if (options.testCardTitle && summary.title === options.testCardTitle && !tested.has(summary.id)) {
      tested.add(summary.id);
      startJob(summary, 'test mode', Date.now() + options.testResetInMs);
      return;
    }
    if (type !== 'status' || previous?.summary.status !== 'working' || !screen) return;
    const limit = detectLimit(screen, summary.provider);
    if (limit === 'reset') startJob(summary, 'banner on screen');
    else if (limit === 'model') {
      log(`"${summary.title}" reached a per-model limit: no reset to wait for`, 'warn');
      setBadge(summary.id, { text: locale === 'ru' ? 'лимит модели' : 'model limit', tone: 'warn',
        tooltip: locale === 'ru' ? 'Переключите модель (/model) или пополните кредиты' : 'Switch models (/model) or add credits' });
    }
  }

  async function refreshCards() {
    const { sessions } = await request('sessions.list', {});
    const open = new Set();
    for (const summary of sessions) {
      open.add(summary.id);
      cards.set(summary.id, { summary, screen: cards.get(summary.id)?.screen ?? '' });
    }
    for (const id of cards.keys()) if (!open.has(id)) cards.delete(id);
  }

  async function locate(job) {
    let resetAt = null;
    try {
      const answer = await request('limits.get', {});
      resetAt = pickReset(answer?.snapshot, job.agent, job.lookups >= 2);
    } catch (error) {
      log(`limits.get: ${error.message}`, 'warn');
    }
    // The person continued while the lookup ran: the job is gone, and so is its badge.
    if (jobs[job.cardId] !== job) return;
    const now = Date.now();
    if (resetAt === null) {
      job.lookups += 1;
      job.due = now + (job.lookups < 3 ? options.lookupRetryMs : options.lookupSlowMs);
      return;
    }
    job.phase = 'waiting';
    job.resetAt = resetAt;
    job.due = Math.max(resetAt, now) + options.graceMs;
    log(`"${job.title}": limit resets ${new Date(resetAt).toISOString()}`);
    await setBadge(job.cardId, badgeFor(resetAt, locale, now));
  }

  async function runJobs() {
    let changed = false;
    for (const job of Object.values(jobs)) {
      const entry = cards.get(job.cardId);
      const card = entry?.summary;
      const action = nextAction(job, card, entry?.screen ?? '', Date.now(), options);
      if (action.kind === 'wait') continue;
      changed = true;
      if (action.kind === 'locate') { await locate(job); continue; }
      if (action.kind === 'drop' || action.kind === 'done' || action.kind === 'give-up') {
        endJob(job, action.kind, action.reason, action.kind === 'give-up'
          ? { text: locale === 'ru' ? 'не продолжилось' : 'resume failed', tone: 'error', tooltip: `${job.attempts} attempts` }
          : null);
        continue;
      }
      if (action.kind === 'retry') {
        // Still limited (or blocked): look the reset up again, it may be another window now.
        job.attempts += 1;
        job.phase = 'locating';
        job.lookups = 0;
        job.due = Date.now() + options.retryMs;
        log(`"${job.title}": retry ${job.attempts}/${options.maxAttempts} (${action.reason})`);
        continue;
      }
      job.phase = 'sending';
      if (action.kind === 'dismiss-and-send') {
        const dismissed = await request('sessions.dismiss', { sessionId: job.cardId }).catch((error) => ({ dismissed: false, reason: error.message }));
        if (!dismissed.dismissed) log(`"${job.title}": limit menu not dismissed: ${dismissed.reason ?? 'unknown'}`, 'warn');
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      // The host waits for an empty composer; give it longer than its own wait.
      const result = await request('sessions.send', { sessionId: job.cardId, text: options.resumeMessage, submit: true }, 120_000)
        .catch((error) => ({ sent: false, error: error.message }));
      if (result.sent) {
        job.phase = 'sent';
        job.sentAt = Date.now();
        log(`"${job.title}": resume typed into its card (${result.delivery?.stage ?? 'sent'})`);
        await setBadge(job.cardId, { text: locale === 'ru' ? '▶ продолжаю' : '▶ resuming', tone: 'info' });
      } else {
        job.phase = 'waiting';
        job.attempts += 1;
        job.due = Date.now() + options.retryMs;
        log(`"${job.title}": resume not delivered (${result.error ?? result.delivery?.reason ?? 'composer not ready'}); attempt ${job.attempts}`, 'warn');
      }
    }
    if (changed) await save();
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await refreshCards();
      await runJobs();
    } catch (error) {
      log(`tick: ${error.message}`, 'warn');
    } finally {
      ticking = false;
      if (ready) timer = setTimeout(tick, options.tickMs);
    }
  }

  async function start(params) {
    locale = params.locale === 'ru' ? 'ru' : 'en';
    // Optional overrides (tests, own continue text): <dataDir>/settings.json.
    const overrides = await readJson(join(params.dataDir, 'settings.json'));
    if (overrides && typeof overrides === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof overrides[key] === typeof DEFAULTS[key] && (typeof overrides[key] !== 'string' || overrides[key].trim() || key === 'testCardTitle')) {
          options[key] = overrides[key];
        }
      }
    }
    try {
      const saved = await request('storage.get', { key: 'state' });
      if (saved?.jobs && typeof saved.jobs === 'object') jobs = saved.jobs;
      // A resume cut short by a restart is tried again.
      for (const job of Object.values(jobs)) if (job.phase === 'sending') job.phase = 'waiting';
    } catch (error) {
      log(`loading state: ${error.message}`, 'warn');
    }
    const { sessions } = await request('sessions.subscribe', {});
    for (const summary of sessions) observe('restored', summary);
    ready = true;
    log('Auto Continue started');
    tick();
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'canvastty.initialize') {
      if (!ready) start(message.params ?? {}).catch((error) => log(`start: ${error.message}`, 'error'));
      return;
    }
    if (message.method === 'canvastty.sessions.event') {
      const { type, session, screen } = message.params ?? {};
      if (session?.id) observe(type, session, screen);
      return;
    }
    if (message.method === 'canvastty.shutdown') {
      ready = false;
      clearTimeout(timer);
      process.exit(0);
    }
    if (message.id !== undefined && message.method) {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }).on('close', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) service();
