import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { cleanDetails, createReporter, diagnosticsEndpoint, errorDetails } from '../src/diagnostics/core';
import { createDiagnosticsServer } from '../scripts/dev-diagnostics.mjs';

test('diagnostics only target the same local development computer', () => {
  assert.equal(diagnosticsEndpoint('192.168.1.212:8081'), 'http://192.168.1.212:8082/events');
  assert.equal(diagnosticsEndpoint('http://10.0.0.2:8081/index.bundle?token=secret'), 'http://10.0.0.2:8082/events');
  for (const host of ['https://expo.dev', 'http://192.168.1.212.evil.example:8081', '999.0.0.1:8081', '172.32.1.2:8081']) {
    assert.equal(diagnosticsEndpoint(host), null);
  }
});

test('diagnostics discard arbitrary state and redact credentials from technical errors', () => {
  const details = cleanDetails({ stage: 'engine', text: 'private sentence', prediction: 'private word', token: 'secret' } as never);
  assert.deepEqual(details, { stage: 'engine' });
  const error = new Error('request https://localhost/a?token=123 password=abc Bearer secret.token me@example.com');
  const captured = errorDetails(error);
  assert.doesNotMatch(captured.message ?? '', /token=123|password=abc|secret\.token|me@example/);
  assert.doesNotMatch(captured.stack ?? '', /token=123|password=abc|secret\.token|me@example/);
  assert.doesNotMatch(JSON.stringify(errorDetails({ reason: 'private message' })), /private message/);
});

test('failed diagnostics are bounded, do not reject into the app, and retry when transport returns', async () => {
  let online = false;
  const received: unknown[] = [];
  const reporter = createReporter({ endpoint: 'http://localhost:8082/events', session: 'test', async transport(_url, events) {
    if (!online) throw new Error('offline');
    received.push(...events);
  } });
  for (let i = 0; i < 150; i++) reporter.report('heartbeat', { durationMs: i });
  await reporter.flush();
  online = true;
  for (let i = 0; i < 6; i++) await reporter.flush();
  assert.equal(received.length, 100);
  assert.equal((received[0] as { sequence: number }).sequence, 51);
  reporter.stop();
});

test('a burst of long native stacks stays below the collector request size limit', async () => {
  const batches: unknown[][] = [];
  const reporter = createReporter({ endpoint: 'http://localhost:8082/events', session: 'test', async transport(_url, events) {
    assert.ok(Buffer.byteLength(JSON.stringify({ events })) < 65536);
    batches.push(events);
  } });
  for (let i = 0; i < 20; i++) reporter.report('error', { stack: '漢'.repeat(6000), message: '漢'.repeat(1200) });
  for (let i = 0; i < 20; i++) await reporter.flush();
  assert.equal(batches.flat().length, 20);
  reporter.stop();
});

test('collector validates, deduplicates, persists technical errors, and marks missing heartbeats stale', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'cinque-diagnostics-'));
  let clock = Date.now();
  const { server } = createDiagnosticsServer({ outputDir, now: () => clock, log: () => {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (body: unknown, origin?: string) => fetch(`${url}/events`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    const event = { session: 'android-test', sequence: 1, at: new Date(clock).toISOString(), kind: 'error',
      details: { stage: 'app_import', message: 'iterator must be an object', platform: 'android', text: 'PRIVATE TEXT', password: 'private' } };
    assert.equal((await send({ events: [event] })).status, 202);
    assert.equal((await send({ events: [event] })).status, 202);
    const data = await (await fetch(`${url}/events`)).json();
    assert.equal(data.events.length, 1);
    assert.equal(data.sessions[0].live, true);
    assert.equal(data.sessions[0].lastError.message, 'iterator must be an object');
    assert.doesNotMatch(readFileSync(join(outputDir, 'events.jsonl'), 'utf8'), /PRIVATE TEXT|password/);
    assert.equal((await send({ events: [null] })).status, 400);
    assert.equal((await send({ events: Array(26).fill(event) })).status, 400);
    assert.equal((await send({ events: [event] }, 'https://external.example')).status, 403);
    assert.equal((await send({ events: [event] }, 'http://192.168.1.2.evil.example:8081')).status, 403);
    assert.equal((await send({ junk: 'x'.repeat(65536) })).status, 413);
    clock += 31000;
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.sessions[0].live, false);
    assert.equal(health.sessions[0].ageMs, 31000);
    const restored = createDiagnosticsServer({ outputDir, now: () => clock, log: () => {} });
    await new Promise<void>(resolve => restored.server.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(restored.status().retained, 1);
      assert.equal(restored.status().sessions[0].live, false);
      assert.equal(restored.status().sessions[0].lastError.message, 'iterator must be an object');
    } finally {
      await new Promise<void>((resolve, reject) => restored.server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
});
