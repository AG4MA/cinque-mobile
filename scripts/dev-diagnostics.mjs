import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const STALE_AFTER_MS = 30000;

function isLocal(address = '') {
  const host = address.replace(/^::ffff:/, '');
  if (host === '::1' || host === '[::1]' || host === 'localhost') return true;
  if (isIP(host) !== 4) return false;
  return /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function scrub(value, limit = 1200) {
  return value.replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/gi, '$1?[redacted]')
    .replace(/\b(authorization|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').slice(0, limit);
}

function sanitizeEvent(input, receivedAt) {
  if (!input || typeof input !== 'object' || typeof input.session !== 'string'
    || !/^[a-z0-9_-]{1,80}$/i.test(input.session) || typeof input.kind !== 'string'
    || !/^[a-z0-9_]{1,48}$/i.test(input.kind) || !Number.isSafeInteger(input.sequence)
    || input.sequence < 1 || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at))) return null;
  const details = {};
  const source = input.details;
  if (source && typeof source === 'object') {
    for (const field of ['stage', 'revision', 'platform', 'osVersion', 'appState', 'name', 'message', 'stack']) {
      if (typeof source[field] === 'string') details[field] = scrub(source[field], field === 'stack' ? 6000 : 1200);
    }
    for (const field of ['durationMs', 'entryCount', 'contextCount', 'letterCount', 'maxLetters', 'pageIndex', 'pageCount']) {
      if (typeof source[field] === 'number' && Number.isFinite(source[field])) details[field] = source[field];
    }
    if (typeof source.fatal === 'boolean') details.fatal = source.fatal;
  }
  return { session: input.session, sequence: input.sequence, at: new Date(input.at).toISOString(),
    receivedAt, kind: input.kind, details };
}

/** @param {{ outputDir?: string, now?: () => number, log?: (message: string) => void }} [options] */
export function createDiagnosticsServer({ outputDir, now = Date.now, log = console.log } = {}) {
  const destination = resolve(outputDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../work/diagnostics'));
  mkdirSync(destination, { recursive: true });
  const startedAt = new Date(now()).toISOString();
  let events = [];
  let accepted = 0;
  let dropped = 0;
  const sessions = new Map();
  const dedupe = new Set();

  const recordSession = event => {
    const previous = sessions.get(event.session) ?? {};
    const details = event.details;
    sessions.set(event.session, { ...previous, session: event.session, lastSeen: event.receivedAt,
      lastEvent: event.kind,
      stage: details.stage ?? (event.kind === 'app_ready' || event.kind.startsWith('app_import') ? event.kind : previous.stage),
      platform: details.platform ?? previous.platform, osVersion: details.osVersion ?? previous.osVersion,
      revision: details.revision ?? previous.revision,
      appState: details.appState ?? previous.appState,
      errors: (previous.errors ?? 0) + (event.kind === 'error' ? 1 : 0),
      lastError: event.kind === 'error' ? { at: event.at, message: details.message, stage: details.stage } : previous.lastError,
    });
    while (sessions.size > 30) sessions.delete(sessions.keys().next().value);
  };
  // Preserve history across restarts without making old sessions appear live.
  try {
    const saved = readFileSync(resolve(destination, 'events.jsonl'), 'utf8');
    if (Buffer.byteLength(saved) <= MAX_FILE_BYTES + MAX_BODY) {
      for (const line of saved.trim().split('\n').slice(-MAX_EVENTS)) {
        try {
          const input = JSON.parse(line);
          if (!Number.isFinite(Date.parse(input.receivedAt))) continue;
          const event = sanitizeEvent(input, new Date(input.receivedAt).toISOString());
          if (!event) continue;
          const key = `${event.session}:${event.sequence}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          events.push(event);
          recordSession(event);
        } catch { /* an incomplete final line must not discard earlier events */ }
      }
      accepted = events.length;
    }
  } catch { /* first launch or no readable history */ }

  const status = () => ({ startedAt, received: accepted, retained: events.length, dropped,
    staleAfterMs: STALE_AFTER_MS,
    sessions: Array.from(sessions.values()).map(session => ({ ...session,
      live: now() - Date.parse(session.lastSeen) < STALE_AFTER_MS && session.appState !== 'background',
      ageMs: now() - Date.parse(session.lastSeen),
    })),
  });
  const persist = () => {
    writeFileSync(resolve(destination, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
    writeFileSync(resolve(destination, 'status.json'), JSON.stringify(status(), null, 2));
  };
  persist();
  // Update staleness even when a crashed/disconnected phone stops sending.
  const interval = setInterval(() => {
    try { writeFileSync(resolve(destination, 'status.json'), JSON.stringify(status(), null, 2)); }
    catch (error) { log(`Diagnostics status write failed: ${error.code ?? 'filesystem error'}`); }
  }, 5000);
  interval.unref();

  const server = createServer((request, response) => {
    const reply = (code, body) => {
      response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    if (!isLocal(request.socket.remoteAddress)) return reply(403, { error: 'Local development only' });
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || !isLocal(parsed.hostname) || !/^808[0-9]$/.test(parsed.port)) {
          return reply(403, { error: 'Origin not allowed' });
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      } catch { return reply(403, { error: 'Origin not allowed' }); }
    }
    if (request.method === 'OPTIONS') return reply(204, {});
    const pathname = request.url?.split('?')[0];
    if (request.method === 'GET' && pathname === '/health') return reply(200, { ok: true, ...status() });
    if (request.method === 'GET' && pathname === '/events') {
      // Error stacks are readable only from this computer.
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (address !== '::1' && !address?.startsWith('127.')) return reply(403, { error: 'Loopback reads only' });
      return reply(200, { ...status(), events });
    }
    if (request.method !== 'POST' || pathname !== '/events') return reply(404, { error: 'Not found' });
    if (!request.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
    let bytes = 0;
    const chunks = [];
    let oversized = false;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        if (!oversized) { oversized = true; reply(413, { error: 'Body too large' }); }
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => { if (!response.headersSent) reply(400, { error: 'Request interrupted' }); });
    request.on('end', () => {
      if (oversized) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(400, { error: 'Invalid JSON' }); }
      if (!Array.isArray(payload?.events) || payload.events.length < 1 || payload.events.length > 25) {
        return reply(400, { error: 'Expected 1 to 25 events' });
      }
      const receivedAt = new Date(now()).toISOString();
      const batch = payload.events.map(event => sanitizeEvent(event, receivedAt));
      if (batch.some(event => !event)) return reply(400, { error: 'Invalid event' });
      for (const event of batch) {
        const key = `${event.session}:${event.sequence}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        accepted += 1;
        events.push(event);
        const details = event.details;
        recordSession(event);
        if (event.kind !== 'heartbeat') log(`[${receivedAt}] ${event.session} ${event.kind}${details.stage ? ` (${details.stage})` : ''}${details.message ? `: ${details.message}` : ''}`);
      }
      while (events.length > MAX_EVENTS || Buffer.byteLength(events.map(event => JSON.stringify(event)).join('\n')) > MAX_FILE_BYTES) {
        const removed = events.shift();
        dedupe.delete(`${removed.session}:${removed.sequence}`);
        dropped += 1;
      }
      while (sessions.size > 30) sessions.delete(sessions.keys().next().value);
      try { persist(); } catch { return reply(503, { error: 'Cannot persist diagnostics' }); }
      reply(202, { accepted: batch.length });
    });
  });
  server.on('close', () => clearInterval(interval));
  return { server, status, outputDir: destination };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex < 0 ? 8082 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid diagnostics port');
  const { server, outputDir } = createDiagnosticsServer();
  server.on('error', error => { console.error(`Diagnostics unavailable: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Cinque local diagnostics: http://127.0.0.1:${port}/health`);
    console.log(`Bounded log files: ${outputDir}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
}
