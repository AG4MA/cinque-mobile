/** Reproduce: npx tsx scripts/evaluate.ts --source ../context-build/ita_sentences_detailed.tsv.bz2
 * Requires Python 3 (stdlib only) for streaming bzip2 and the exact corpus snapshot.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LexicalEngine, type Entry } from '../src/prediction/lexical-engine';
import { StatisticalEngine, type ContextDataset, tokenize } from '../src/prediction/statistical-engine';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceAt = process.argv.indexOf('--source');
if (sourceAt < 0 || !process.argv[sourceAt + 1]) throw new Error('Pass --source PATH to the original Tatoeba detailed .bz2 export.');
const source = path.resolve(process.argv[sourceAt + 1]);
const sampleCount = 4000;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const datasetPath = path.join(root, 'assets/context/it-context.json');
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as ContextDataset;
const lexical = JSON.parse(readFileSync(path.join(root, 'assets/lexicon/it.json'), 'utf8')) as { entries: Entry[] };

// Import the builder's exact tokenizer and split rule to keep training/test disjoint.
// Select bounded deterministic hash samples across all held-out sentences, not the first block.
const extract = String.raw`
import bz2, hashlib, heapq, importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('builder', pathlib.Path(sys.argv[1]) / 'scripts/build_context.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
source = pathlib.Path(sys.argv[2])
if hashlib.sha256(source.read_bytes()).hexdigest() != builder.EXPECTED_SHA256:
    raise RuntimeError('The input corpus snapshot does not match the training source.')
limit = int(sys.argv[3])
seen, selected = set(), []
holdout_sequences, eligible_positions = 0, 0
with bz2.open(source, 'rt', encoding='utf-8') as stream:
    for line in stream:
        fields = line.rstrip('\n').split('\t')
        if len(fields) != 6 or fields[1] != 'ita':
            continue
        for tokens in builder.token_sequences(fields[2]):
            digest = hashlib.sha256(' '.join(tokens).encode('utf-8')).digest()
            if digest in seen:
                continue
            seen.add(digest)
            if int.from_bytes(digest[:8], 'big') % builder.HOLDOUT_MODULUS != 0:
                continue
            holdout_sequences += 1
            for position in range(1, len(tokens)):
                actual = tokens[position]
                if len(actual) < 3:
                    continue
                eligible_positions += 1
                key = int.from_bytes(hashlib.sha256(digest + position.to_bytes(2, 'big')).digest(), 'big')
                row = (-key, ' '.join(tokens[:position]) + ' ', actual)
                if len(selected) < limit:
                    heapq.heappush(selected, row)
                elif row > selected[0]:
                    heapq.heapreplace(selected, row)
samples = [{'before':before, 'actual':actual} for _,before,actual in sorted(selected, reverse=True)]
print(json.dumps({'holdoutSequences':holdout_sequences, 'eligiblePositions':eligible_positions, 'samples':samples}, ensure_ascii=False))
`;
const extracted = JSON.parse(execFileSync(process.env.PYTHON ?? 'python', ['-c', extract, root, source, String(sampleCount)], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
})) as { holdoutSequences: number; eligiblePositions: number; samples: Array<{ before: string; actual: string }> };
if (extracted.samples.length !== sampleCount) throw new Error(`Expected ${sampleCount} samples, received ${extracted.samples.length}.`);

const baseline = new LexicalEngine(lexical.entries);
const app = new StatisticalEngine(new LexicalEngine(lexical.entries), dataset);
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * fraction)].toFixed(3));
};
type Counts = {
  positions: number; lexicalTop1: number; lexicalTop5: number; appTop1: number; appTop5: number;
  lexicalNextLetterTop4: number; appNextLetterTop4: number; gainsTop5: number; regressionsTop5: number;
  positionsUsingContext: number;
};
const metrics: Record<string, Counts & { desktopLatencyMs?: unknown; rates?: unknown }> = {};
const overallStarted = performance.now();
for (const prefixLength of [0, 2]) {
  const counts: Counts = {
    positions: 0, lexicalTop1: 0, lexicalTop5: 0, appTop1: 0, appTop5: 0,
    lexicalNextLetterTop4: 0, appNextLetterTop4: 0, gainsTop5: 0, regressionsTop5: 0,
    positionsUsingContext: 0,
  };
  const baselineTimes: number[] = [];
  const appTimes: number[] = [];
  for (const { before, actual } of extracted.samples) {
    const prefix = actual.slice(0, prefixLength);
    const text = before + prefix;
    const startedBase = performance.now();
    baseline.setPersonalWords(tokenize(before));
    const base = baseline.predict(text);
    baselineTimes.push(performance.now() - startedBase);
    const startedApp = performance.now();
    const result = app.predict(text);
    appTimes.push(performance.now() - startedApp);
    const baseHit = base.words.some(candidate => candidate.word === actual);
    const appHit = result.words.some(candidate => candidate.word === actual);
    counts.positions++;
    counts.lexicalTop1 += Number(base.words[0]?.word === actual);
    counts.appTop1 += Number(result.words[0]?.word === actual);
    counts.lexicalTop5 += Number(baseHit);
    counts.appTop5 += Number(appHit);
    counts.gainsTop5 += Number(!baseHit && appHit);
    counts.regressionsTop5 += Number(baseHit && !appHit);
    counts.lexicalNextLetterTop4 += Number(base.letters.slice(0, 4).some(candidate => candidate.letter === actual[prefixLength]));
    counts.appNextLetterTop4 += Number(result.letters.slice(0, 4).some(candidate => candidate.letter === actual[prefixLength]));
    counts.positionsUsingContext += Number(result.source === 'context');
  }
  const rates = Object.fromEntries(Object.entries(counts).filter(([key]) => key !== 'positions').map(([key, count]) => [key, Number((count / counts.positions).toFixed(6))]));
  metrics[prefixLength ? 'twoLetters' : 'emptyPrefix'] = {
    ...counts, rates,
    desktopLatencyMs: {
      lexicalMedian: percentile(baselineTimes, 0.5), lexicalP95: percentile(baselineTimes, 0.95),
      appMedian: percentile(appTimes, 0.5), appP95: percentile(appTimes, 0.95),
      appMax: Number(Math.max(...appTimes).toFixed(3)),
    },
  };
}

const report = {
  date: '2026-10-12',
  implementation: 'Production StatisticalEngine.predict compared against production LexicalEngine.predict.',
  sourceSha256: dataset.metadata.sourceSha256,
  contextDatasetSha256: sha(readFileSync(datasetPath)),
  implementationSha256: {
    statisticalEngine: sha(readFileSync(path.join(root, 'src/prediction/statistical-engine.ts'))),
    lexicalEngine: sha(readFileSync(path.join(root, 'src/prediction/lexical-engine.ts'))),
  },
  method: 'Select 4000 next-word positions deterministically by lowest SHA-256(sequenceDigest+position) across all held-out normalized token sequences. Use the builder tokenizer and split: sequence SHA256 first8 bytes modulo20=0. Exact duplicate sequences deduplicated before sampling; none used to train n-grams. Only target words of at least3 letters. Same samples evaluated with no prefix and with2 prefix letters. Both lexical memories replaced by preceding words of the current sample, so no cross-sentence learning leaks into the comparison.',
  sampleCount, availableHoldoutSequences: extracted.holdoutSequences, availableEligiblePositions: extracted.eligiblePositions,
  sampleDigest: sha(JSON.stringify(extracted.samples)),
  hardware: `${os.cpus()[0]?.model}; ${os.platform()} ${os.arch()}; Node ${process.version}`,
  wallSeconds: Number(((performance.now() - overallStarted) / 1000).toFixed(3)),
  metrics,
  limitations: [
    'Same-corpus test of Tatoeba translated/example sentences, not a representative sample of private messages.',
    'Near-duplicate paraphrases and recurring names can occur across the exact-deduplicated split.',
    'The external wordfreq unigram corpus can overlap Tatoeba; it is shared by both compared engines.',
    'Desktop Node CPU timings with naturally warmed caches. They exclude JSON loading/rendering and do not measure phone performance or user typing speed.',
    'Top5 word hit tests one observed next word; other suggestions may still be reasonable. Gains and regressions are reported separately.',
  ],
};
writeFileSync(path.join(root, 'assets/context/app-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ hardware: report.hardware, wallSeconds: report.wallSeconds, metrics }, null, 2));
