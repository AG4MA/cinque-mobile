import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './prepare-runtime-data.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const collector = spawn(process.execPath, [join(root, 'scripts/dev-diagnostics.mjs')], { cwd: root, stdio: 'inherit' });
let metro;
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  metro?.kill();
  collector.kill();
  process.exitCode = code;
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
collector.on('error', error => { console.error(error.message); stop(1); });
collector.on('exit', code => { if (!stopping) stop(code || 1); });

let ready = false;
for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
  try { ready = (await fetch('http://127.0.0.1:8082/health')).ok; } catch { /* starting */ }
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready || stopping) {
  console.error('Cannot start the local diagnostics collector on port 8082.');
  stop(1);
} else {
  const cli = join(dirname(require.resolve('expo/package.json')), 'bin', 'cli');
  metro = spawn(process.execPath, [cli, 'start', '--go', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  metro.on('error', error => { console.error(error.message); stop(1); });
  metro.on('exit', code => stop(code || 0));
}
