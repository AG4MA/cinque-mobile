/** Run build_openings.py first, then: npx tsx scripts/evaluate_openings.ts
 * Tests only sentence-initial positions, excluded by the original evaluator.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LexicalEngine } from '../src/prediction/lexical-engine';
import { StatisticalEngine } from '../src/prediction/statistical-engine';
import { OpeningPolicy } from '../src/prediction/opening-policy';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const vocabulary = JSON.parse(read('assets/lexicon/it.json'));
const dataset = JSON.parse(read('assets/context/it-openings.json'));
const heldout = JSON.parse(read('work/opening-holdout.json')) as { sourceSha256: string; holdoutSequences: number; entries: Array<[string, number]> };
if (heldout.sourceSha256 !== dataset.metadata.sourceSha256) throw new Error('Holdout source mismatch');
const original = new StatisticalEngine(new LexicalEngine(vocabulary.entries), JSON.parse(read('assets/context/it-context.json')));
const updated = new OpeningPolicy(new LexicalEngine(vocabulary.entries), dataset);
const metrics = [];
for (const prefixLength of [0, 1, 2]) {
  const cache = new Map<string, { old: ReturnType<typeof original.predict>; next: ReturnType<typeof updated.predict> }>();
  const counts = { prefixLength, positions: 0, originalWordTop3: 0, updatedWordTop3: 0, originalWordTop5: 0, updatedWordTop5: 0,
    originalLetterTop4: 0, updatedLetterTop4: 0, originalLetterTop8: 0, updatedLetterTop8: 0, gainsWordTop3: 0, lossesWordTop3: 0 };
  for (const [word, count] of heldout.entries) {
    if (word.length <= prefixLength) continue;
    const prefix = word.slice(0, prefixLength);
    let predictions = cache.get(prefix);
    if (!predictions) {
      predictions = { old: original.predict(prefix), next: updated.predict(prefix) };
      cache.set(prefix, predictions);
    }
    const { old, next } = predictions;
    const old3 = old.words.slice(0, 3).some(candidate => candidate.word === word);
    const next3 = next.words.slice(0, 3).some(candidate => candidate.word === word);
    counts.positions += count;
    counts.originalWordTop3 += Number(old3) * count;
    counts.updatedWordTop3 += Number(next3) * count;
    counts.originalWordTop5 += Number(old.words.some(candidate => candidate.word === word)) * count;
    counts.updatedWordTop5 += Number(next.words.some(candidate => candidate.word === word)) * count;
    counts.originalLetterTop4 += Number(old.letters.slice(0, 4).some(candidate => candidate.letter === word[prefixLength])) * count;
    counts.updatedLetterTop4 += Number(next.letters.slice(0, 4).some(candidate => candidate.letter === word[prefixLength])) * count;
    counts.originalLetterTop8 += Number(old.letters.slice(0, 8).some(candidate => candidate.letter === word[prefixLength])) * count;
    counts.updatedLetterTop8 += Number(next.letters.slice(0, 8).some(candidate => candidate.letter === word[prefixLength])) * count;
    counts.gainsWordTop3 += Number(!old3 && next3) * count;
    counts.lossesWordTop3 += Number(old3 && !next3) * count;
  }
  metrics.push({ ...counts, rates: Object.fromEntries(Object.entries(counts).filter(([key]) => key !== 'prefixLength' && key !== 'positions')
    .map(([key, value]) => [key, Number((value / counts.positions).toFixed(6))])) });
}
const report = {
  sourceSha256: heldout.sourceSha256, datasetSha256: sha(read('assets/context/it-openings.json')),
  policySha256: sha(read('src/prediction/opening-policy.ts')), holdoutSequences: heldout.holdoutSequences,
  method: 'All held-out normalized sequence opening words, counted once per unique sequence. Same SHA-256 modulo20 split as build_context.py. Evaluate only the first word, which original app-evaluation.json excluded. For prefix length N, exclude target words of length <=N. Both policies receive exactly the same prefix and no prior text.',
  policy: 'Use all observed training opening words. Rank with count^0.8 times wordfreq frequency^0.25; mix complete opening letter marginals 50/50 with lexical marginals, opening word scores 85/15 with lexical scores. These are heuristic ranking weights, not calibrated probabilities. Body-of-sentence predictions are unchanged.',
  metrics,
  limitations: [
    'Tatoeba openings are translated examples and overrepresent names such as Tom and Mary; this is not a private chat benchmark.',
    'Smoothing intentionally reduces repeated corpus names, so zero-prefix same-corpus hit rates may decrease; all gains and losses are reported.',
    'Parameters were selected to reduce corpus concentration and improve direct access to broad initials and observed conversational prefixes; no claim of optimality.',
    'Near-duplicate paraphrases can occur across the exact-deduplicated split; wordfreq may overlap Tatoeba.',
  ],
};
const output = new URL('assets/context/opening-evaluation.json', root);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: fileURLToPath(output), metrics }, null, 2));
