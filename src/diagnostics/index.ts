import Constants from 'expo-constants';
import { AppState, NativeModules, Platform } from 'react-native';
import { createReporter, diagnosticsEndpoint, errorDetails, type DiagnosticDetails } from './core';

type ErrorHandler = (error: unknown, fatal?: boolean) => void;
type DiagnosticsRuntime = typeof globalThis & {
  ErrorUtils?: { getGlobalHandler: () => ErrorHandler; setGlobalHandler: (handler: ErrorHandler) => void };
  __cinqueDiagnostics?: { report: (kind: string, details?: DiagnosticDetails) => void };
};
const runtime = globalThis as DiagnosticsRuntime;

/** This module is installed before App is imported, so initialization errors reach the computer. */
export function installDiagnostics(): void {
  if (!__DEV__ || runtime.__cinqueDiagnostics) return;
  try {
    const sourceUrl = NativeModules.SourceCode?.scriptURL as string | undefined;
    const endpoint = diagnosticsEndpoint(Constants.expoConfig?.hostUri)
      ?? diagnosticsEndpoint(sourceUrl)
      ?? (Platform.OS === 'web' ? diagnosticsEndpoint(globalThis.location?.href) : null);
    if (!endpoint) return;
    const reporter = createReporter({
      endpoint,
      session: `${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      async transport(url, events) {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 4000);
        try {
          const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events }), signal: abort.signal });
          if (!response.ok) throw new Error('diagnostics transport');
        } finally { clearTimeout(timeout); }
      },
    });
    runtime.__cinqueDiagnostics = reporter;
    let latestStage = 'boot';
    const report = reporter.report.bind(reporter);
    reporter.report = (kind, details) => {
      if (kind === 'app_ready' || kind.startsWith('app_import') || details?.stage) latestStage = details?.stage ?? kind;
      report(kind, details);
    };

    const previous = runtime.ErrorUtils?.getGlobalHandler();
    if (previous) runtime.ErrorUtils?.setGlobalHandler((error, fatal) => {
      reportDiagnosticError(error, 'uncaught', fatal);
      void reporter.flush();
      previous(error, fatal);
    });

    // RN's native promise rejection tracker feeds ExceptionsManager, which
    // forwards the Error through console.error. Keep that tracker and its UI.
    for (const level of ['error', 'warn'] as const) {
      const original = console[level];
      let forwarding = false;
      console[level] = (...args: unknown[]) => {
        if (!forwarding) {
          forwarding = true;
          try {
            const error = args.find(value => value instanceof Error);
            if (error) reportDiagnosticError(error, `console_${level}`);
            // Plain console strings/objects may contain what the user typed.
            // Report their occurrence only, without copying their contents.
            else reporter.report(`console_${level}`, { message: 'Console event (non-Error arguments omitted)' });
            original.apply(console, args);
          } finally { forwarding = false; }
        } else original.apply(console, args);
      };
    }
    if (Platform.OS === 'web') {
      globalThis.addEventListener('error', event => reportDiagnosticError(event.error, 'browser_error'));
      globalThis.addEventListener('unhandledrejection', event => reportDiagnosticError(event.reason, 'unhandled_rejection'));
    }
    AppState.addEventListener('change', appState => {
      reporter.report('app_state', { appState });
      void reporter.flush();
    });
    setInterval(() => {
      reporter.report('heartbeat', { stage: latestStage, appState: AppState.currentState,
        platform: Platform.OS, osVersion: String(Platform.Version) });
      void reporter.flush();
    }, 10000);
    reporter.report('boot', { stage: latestStage, revision: 'probability-cost-4', platform: Platform.OS, osVersion: String(Platform.Version) });
    void reporter.flush();
  } catch { /* a logger must never prevent this keyboard from starting */ }
}

export function reportDiagnostic(kind: string, details?: DiagnosticDetails): void {
  if (!__DEV__) return;
  try { runtime.__cinqueDiagnostics?.report(kind, details); } catch { /* best effort */ }
}

export function reportDiagnosticError(error: unknown, stage = 'app', fatal = false): void {
  reportDiagnostic('error', { ...errorDetails(error), stage, fatal });
}
