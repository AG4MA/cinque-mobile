export type DiagnosticDetails = {
  stage?: string;
  revision?: string;
  platform?: string;
  osVersion?: string;
  appState?: string;
  durationMs?: number;
  entryCount?: number;
  contextCount?: number;
  letterCount?: number;
  maxLetters?: number;
  pageIndex?: number;
  pageCount?: number;
  name?: string;
  message?: string;
  stack?: string;
  fatal?: boolean;
};

export type DiagnosticEvent = {
  session: string;
  sequence: number;
  at: string;
  kind: string;
  details: DiagnosticDetails;
};

// Only development hosts are valid: diagnostics must never follow an Expo
// tunnel or production update URL to an outside service.
export function diagnosticsEndpoint(hostUri?: string | null): string | null {
  if (!hostUri) return null;
  try {
    const url = new URL(hostUri.includes('://') ? hostUri : `http://${hostUri}`);
    const host = url.hostname.toLowerCase();
    const pieces = host.split('.').map(Number);
    const localIPv4 = pieces.length === 4 && pieces.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
      && (pieces[0] === 10 || pieces[0] === 127 || (pieces[0] === 192 && pieces[1] === 168)
        || (pieces[0] === 172 && pieces[1] >= 16 && pieces[1] <= 31));
    if (!localIPv4 && host !== 'localhost' && host !== '[::1]') return null;
    return `http://${host}:8082/events`;
  } catch { return null; }
}

export function scrubTechnicalText(value: string, maxLength = 1200): string {
  return value
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/gi, '$1?[redacted]')
    .replace(/\b(authorization|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .slice(0, maxLength);
}

export function cleanDetails(details: DiagnosticDetails = {}): DiagnosticDetails {
  const clean: DiagnosticDetails = {};
  for (const key of ['stage', 'revision', 'platform', 'osVersion', 'appState', 'name', 'message', 'stack'] as const) {
    if (typeof details[key] === 'string') clean[key] = scrubTechnicalText(details[key], key === 'stack' ? 6000 : 1200);
  }
  for (const key of ['durationMs', 'entryCount', 'contextCount', 'letterCount', 'maxLetters', 'pageIndex', 'pageCount'] as const) {
    if (typeof details[key] === 'number' && Number.isFinite(details[key])) clean[key] = details[key];
  }
  if (typeof details.fatal === 'boolean') clean.fatal = details.fatal;
  return clean;
}

export function errorDetails(error: unknown): DiagnosticDetails {
  try {
    if (error && typeof error === 'object') {
      const value = error as { name?: unknown; message?: unknown; stack?: unknown };
      return cleanDetails({
        name: typeof value.name === 'string' ? value.name : 'Error',
        message: typeof value.message === 'string' ? value.message : 'Non-Error rejection (contents omitted)',
        stack: typeof value.stack === 'string' ? value.stack : undefined,
      });
    }
  } catch { /* hostile or unusual Error getters must not crash diagnostics */ }
  return { name: 'Error', message: 'Non-Error rejection (contents omitted)' };
}

type ReporterOptions = {
  endpoint: string;
  session: string;
  transport: (endpoint: string, events: DiagnosticEvent[]) => Promise<void>;
};

export function createReporter(options: ReporterOptions) {
  let queue: DiagnosticEvent[] = [];
  let sequence = 0;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = async () => {
    if (sending || stopped || queue.length === 0) return;
    sending = true;
    // A UTF-16 code unit uses at most three UTF-8 bytes. Keep even batches
    // of long Unicode stacks under the collector's 64 KiB body limit.
    const batch: DiagnosticEvent[] = [];
    let characters = 32;
    while (queue.length && batch.length < 20) {
      const size = JSON.stringify(queue[0]).length + 1;
      if (batch.length && characters + size > 18000) break;
      batch.push(queue.shift()!);
      characters += size;
    }
    try { await options.transport(options.endpoint, batch); }
    catch { queue = batch.concat(queue).slice(-100); }
    finally { sending = false; }
  };
  return {
    report(kind: string, details?: DiagnosticDetails) {
      if (stopped) return;
      try {
        queue.push({ session: options.session, sequence: ++sequence, at: new Date().toISOString(),
          kind: kind.replace(/[^a-z0-9_]/gi, '').slice(0, 48), details: cleanDetails(details) });
        queue = queue.slice(-100);
        if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 40);
      } catch { /* diagnostics are always best effort */ }
    },
    flush,
    stop() { stopped = true; if (timer) clearTimeout(timer); queue = []; },
  };
}
