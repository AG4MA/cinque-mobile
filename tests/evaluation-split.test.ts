import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('development and test samples are deterministic, disjoint and do not disclose target letters', () => {
  const seenDev = new Set<string>();
  const manifest = json('assets/evaluation/sample-manifest.json');
  for (const split of ['dev', 'test']) {
    const raw = read(`assets/evaluation/${split}-samples.json`);
    const data = JSON.parse(raw);
    assert.equal(sha(raw), manifest.files[split].sha256);
    assert.equal(data.samples.length, manifest.files[split].samples);
    assert.equal(data.metadata.sourceSha256, manifest.sourceSha256);
    const ids = new Set<string>();
    const strata = new Map<string, number>();
    for (const sample of data.samples) {
      assert.equal(BigInt('0x' + sample.sequenceSha256.slice(0, 16)) % 20n, split === 'dev' ? 1n : 0n);
      assert.equal(sample.id, sha(`cinque-eval-v1|${sample.sequenceSha256}|${sample.position}|${sample.prefixLength}`));
      assert.ok(!ids.has(sample.id));
      ids.add(sample.id);
      if (split === 'dev') seenDev.add(sample.sequenceSha256);
      else assert.ok(!seenDev.has(sample.sequenceSha256));
      assert.ok(sample.targetWord.length > sample.prefixLength);
      assert.equal(sample.targetLetter, sample.targetWord[sample.prefixLength]);
      assert.ok(sample.text.endsWith(sample.targetWord.slice(0, sample.prefixLength)));
      assert.equal(sample.position === 0, sample.location === 'initial');
      const key = `${sample.location}:${sample.prefixLength}`;
      strata.set(key, (strata.get(key) ?? 0) + 1);
    }
    assert.equal(strata.size, 6);
    for (const count of strata.values()) assert.equal(count, data.metadata.samplesPerStratum);
  }
});

test('shipped calibration and benchmark refer to the exact frozen engine and datasets', () => {
  const calibration = json('src/prediction/calibration.json');
  const report = json('assets/evaluation/benchmark.json');
  const paths = {
    vocabulary: 'assets/lexicon/it.json', model: 'assets/probability/it-model.json',
    engine: 'src/prediction/probabilistic-engine.ts', probabilityIndex: 'src/prediction/probability-index.ts',
  };
  for (const [key, path] of Object.entries(paths)) {
    const actual = sha(read(path));
    assert.equal(calibration.dataHashes[key], actual, `${key} changed after calibration`);
    assert.equal(report.dataHashes[key], actual, `${key} changed after test`);
  }
  assert.equal(report.calibrationSha256, sha(read('src/prediction/calibration.json')));
  assert.equal(report.testSampleSha256, sha(read('assets/evaluation/test-samples.json')));
  assert.equal(report.devSampleSha256, sha(read('assets/evaluation/dev-samples.json')));
  assert.deepEqual(report.options, calibration.options);
  for (const [key, path] of Object.entries({ adaptive: 'src/prediction/adaptive-letters.ts', pages: 'src/prediction/letter-pages.ts', cost: 'src/prediction/keyboard-cost.ts' })) {
    assert.equal(report.policyHashes[key], sha(read(path)), `${key} changed after interaction benchmark`);
  }
});
