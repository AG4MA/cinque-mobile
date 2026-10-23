/** Reproduce: npx tsx scripts/evaluate_probability.ts --calibrate, then --test.
 * Calibration reads only DEV. TEST consumes the frozen, hashed calibration artifact.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LexicalEngine, type Prediction, type LetterCandidate } from '../src/prediction/lexical-engine';
import { StatisticalEngine } from '../src/prediction/statistical-engine';
import { ProbabilisticEngine, type ProbabilityDataset } from '../src/prediction/probabilistic-engine';
import { rankLetterCandidates } from '../src/prediction/adaptive-letters';
import { buildLetterPages } from '../src/prediction/letter-pages';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (path: string) => JSON.parse(read(path));
const save = (path: string, value: unknown) => writeFileSync(new URL(path, root), JSON.stringify(value, null, 2) + '\n');
const rounded = (value: number) => Number(value.toFixed(7));
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
type Sample = { id: string; sequenceSha256: string; sentenceId: string; position: number; location: 'initial' | 'body'; prefixLength: number; text: string; targetWord: string; targetLetter: string };
type Examples = { metadata: Record<string, any>; samples: Sample[] };
type Options = NonNullable<ConstructorParameters<typeof ProbabilisticEngine>[2]>;
type Observation = { sample: Sample; prediction: Prediction; latencyMs: number };

/** Explicit frozen baseline policy from the previously shipped UI. */
function legacyPages(candidates: LetterCandidate[], cap = 8) {
  const ranked = rankLetterCandidates(candidates);
  if (!ranked.length) for (const letter of ['e', 'a', 'i', 'o', 'n', 'r', 't', 'l', 's', 'c']) ranked.push({ letter, score: 0.1 });
  for (const letter of ['e', 'a', 'i', 'o', 'n', 'r', 't', 'l', 's', 'c']) {
    if (ranked.length >= 4) break;
    if (!ranked.some(item => item.letter === letter)) ranked.push({ letter, score: 0 });
  }
  let count = 0, mass = 0;
  while (count < Math.min(cap, ranked.length) && (count < 4 || mass < 0.9)) mass += ranked[count++].score;
  const pages = [ranked.slice(0, count)];
  for (let offset = count; offset < ranked.length; offset += count) pages.push(ranked.slice(Math.min(offset, ranked.length - 4), offset + count));
  return pages;
}

function temperatureScale(prediction: Prediction, temperature: number): Prediction {
  const letters = rankLetterCandidates(prediction.letters).map(({ letter, score }) => ({ letter, score: score ** (1 / temperature) }));
  const sum = letters.reduce((total, item) => total + item.score, 0);
  return { ...prediction, letters: letters.map(item => ({ ...item, score: item.score / sum })) };
}

function collect(engine: { predict(text: string): Prediction }, samples: Sample[]): Observation[] {
  return samples.map(sample => {
    const started = performance.now();
    const prediction = engine.predict(sample.text);
    return { sample, prediction, latencyMs: performance.now() - started };
  });
}

const interactionCache = new WeakMap<Prediction, Map<boolean, { page: number; count: number; coverage: number }>>();
function measure(observations: Observation[], updated: boolean, interactions = true) {
  let nll = 0, brier = 0, letterTop4 = 0, letterTop8 = 0, wordTop3 = 0, firstPage = 0, taps = 0, unknown = 0, shown = 0, coverage = 0, rankedTaps = 0;
  const bins = Array.from({ length: 10 }, () => ({ samples: 0, confidenceSum: 0, correct: 0 }));
  for (const { sample, prediction } of observations) {
    const letters = rankLetterCandidates(prediction.letters);
    const target = letters.find(item => item.letter === sample.targetLetter)?.score ?? 0;
    nll -= Math.log(Math.max(1e-12, target));
    brier += letters.reduce((sum, item) => sum + item.score ** 2, 0) - 2 * target + 1;
    letterTop4 += Number(letters.slice(0, 4).some(item => item.letter === sample.targetLetter));
    letterTop8 += Number(letters.slice(0, 8).some(item => item.letter === sample.targetLetter));
    wordTop3 += Number(prediction.words.slice(0, 3).some(item => item.word === sample.targetWord));
    const confidence = letters[0]?.score ?? 0;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))];
    bin.samples++;
    bin.confidenceSum += confidence;
    bin.correct += Number(letters[0]?.letter === sample.targetLetter);
    if (!interactions) continue;
    let cache = interactionCache.get(prediction);
    if (!cache) { cache = new Map(); interactionCache.set(prediction, cache); }
    let interaction = cache.get(updated);
    if (!interaction) {
      const pages = updated ? buildLetterPages(prediction.letters, 8) : legacyPages(prediction.letters);
      interaction = { page: pages.findIndex(items => items.some(item => item.letter === sample.targetLetter)), count: pages[0].length,
        coverage: pages[0].reduce((sum, item) => sum + item.score, 0) };
      cache.set(updated, interaction);
    }
    const { page } = interaction;
    // ABC is directly reachable. At most two taps: ABC then target. For ranked
    // pages the idealized user uses whichever route requires fewer taps.
    taps += page < 0 ? 2 : Math.min(page + 1, 2);
    rankedTaps += page < 0 ? 2 : page + 1;
    unknown += Number(page < 0);
    firstPage += Number(page === 0);
    shown += interaction.count;
    coverage += interaction.coverage;
  }
  const n = observations.length;
  return {
    positions: n,
    letterNllNats: rounded(nll / n), letterBrier: rounded(brier / n),
    letterTop1Ece10Bins: rounded(bins.reduce((sum, bin) => sum + Math.abs(bin.correct - bin.confidenceSum), 0) / n),
    letterTop4: rounded(letterTop4 / n), letterTop8: rounded(letterTop8 / n), wordTop3: rounded(wordTop3 / n),
    actualFirstPageHitRate: interactions ? rounded(firstPage / n) : undefined, meanFirstPageLetters: interactions ? rounded(shown / n) : undefined,
    predictedFirstPageCoverage: interactions ? rounded(coverage / n) : undefined,
    idealizedLetterTapsWithAbc: interactions ? rounded(taps / n) : undefined, meanLetterTapsFollowingRankedPages: interactions ? rounded(rankedTaps / n) : undefined,
    unreachableFromRankedPagesRate: interactions ? rounded(unknown / n) : undefined,
    desktopPredictionMedianMs: rounded(percentile(observations.map(item => item.latencyMs), 0.5)),
    desktopPredictionP95Ms: rounded(percentile(observations.map(item => item.latencyMs), 0.95)),
    calibrationBins: bins.map((bin, index) => ({ from: index / 10, to: (index + 1) / 10, samples: bin.samples,
      meanConfidence: bin.samples ? rounded(bin.confidenceSum / bin.samples) : null,
      accuracy: bin.samples ? rounded(bin.correct / bin.samples) : null })),
  };
}

function grouped(observations: Observation[], updated: boolean) {
  const result: Record<string, ReturnType<typeof measure>> = { all: measure(observations, updated) };
  for (const location of ['initial', 'body']) {
    result[location] = measure(observations.filter(item => item.sample.location === location), updated);
    for (const prefix of [0, 1, 2]) result[`${location}Prefix${prefix}`] = measure(observations.filter(item => item.sample.location === location && item.sample.prefixLength === prefix), updated);
  }
  return result;
}

function verifySamples(examples: Examples, split: 'dev' | 'test') {
  if (examples.metadata.split !== split) throw new Error('Incorrect evaluation split');
  const expected = split === 'test' ? 0n : 1n;
  for (const sample of examples.samples) {
    if (BigInt('0x' + sample.sequenceSha256.slice(0, 16)) % 20n !== expected) throw new Error('Sample split leakage');
    if (sample.targetWord.length <= sample.prefixLength || sample.targetWord[sample.prefixLength] !== sample.targetLetter) throw new Error('Disclosed or inconsistent target');
  }
}

function pairedIntervals(before: Observation[], after: Observation[]) {
  const keys = ['letterNllNats', 'letterTop4', 'letterTop8', 'wordTop3', 'actualFirstPageHitRate', 'idealizedLetterTapsWithAbc'];
  const ids = [...new Set(before.map(item => item.sample.sequenceSha256))];
  const clusterIndices = new Map(ids.map((id, index) => [id, index]));
  const rows = before.map((old, index) => {
    const next = after[index];
    if (old.sample.id !== next.sample.id) throw new Error('Unpaired benchmark rows');
    const scores = (item: Observation, updated: boolean) => {
      const letters = rankLetterCandidates(item.prediction.letters);
      const target = letters.find(candidate => candidate.letter === item.sample.targetLetter)?.score ?? 0;
      const page = interactionCache.get(item.prediction)!.get(updated)!.page;
      return [
        -Math.log(Math.max(1e-12, target)),
        Number(letters.slice(0, 4).some(candidate => candidate.letter === item.sample.targetLetter)),
        Number(letters.slice(0, 8).some(candidate => candidate.letter === item.sample.targetLetter)),
        Number(item.prediction.words.slice(0, 3).some(candidate => candidate.word === item.sample.targetWord)),
        Number(page === 0), page < 0 ? 2 : Math.min(page + 1, 2),
      ];
    };
    const a = scores(old, false), b = scores(next, true);
    return { cluster: clusterIndices.get(old.sample.sequenceSha256)!, group: (old.sample.location === 'initial' ? 0 : 3) + old.sample.prefixLength,
      difference: b.map((value, metric) => value - a[metric]) };
  });
  // Poisson(1) bootstrap weights shared by every sample from the same sentence.
  // Re-normalize within each of the six strata, then macro-average them.
  let state = 0xC105E;
  const random = () => { state = (state + 0x6D2B79F5) | 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const estimates = keys.map(() => [] as number[]);
  for (let iteration = 0; iteration < 1000; iteration++) {
    const weights = ids.map(() => { let count = -1, product = 1; do { count++; product *= random(); } while (product > Math.exp(-1)); return count; });
    const totals = Array.from({ length: 6 }, () => ({ weight: 0, values: keys.map(() => 0) }));
    for (const row of rows) {
      const weight = weights[row.cluster], total = totals[row.group];
      total.weight += weight;
      row.difference.forEach((difference, index) => { total.values[index] += difference * weight; });
    }
    keys.forEach((_, metric) => estimates[metric].push(totals.reduce((sum, total) => sum + total.values[metric] / total.weight, 0) / 6));
  }
  return {
    method: 'Deterministic Poisson cluster bootstrap, 1000 replicates, sequence SHA256 as cluster, shared weights across prefixes, re-normalized within six strata and macro-averaged. Percentile 95% intervals for updated minus baseline. Does not capture corpus-domain bias or near-duplicate templates.',
    uniqueSequenceClusters: ids.length,
    updatedMinusBaseline: Object.fromEntries(keys.map((key, index) => [key, { low95: rounded(percentile(estimates[index], 0.025)), high95: rounded(percentile(estimates[index], 0.975)) }])),
  };
}

const mode = process.argv.includes('--calibrate') ? 'calibrate' : process.argv.includes('--test') ? 'test' : '';
if (!mode) throw new Error('Pass --calibrate or --test explicitly. Calibration never reads TEST.');
mkdirSync(new URL('assets/evaluation/', root), { recursive: true });
const vocabularyText = read('assets/lexicon/it.json');
const modelText = read('assets/probability/it-model.json');
const vocabulary = JSON.parse(vocabularyText);
const dataset = JSON.parse(modelText) as ProbabilityDataset;
const dataHashes = { vocabulary: sha(vocabularyText), model: sha(modelText), engine: sha(read('src/prediction/probabilistic-engine.ts')), probabilityIndex: sha(read('src/prediction/probability-index.ts')) };
const devText = read('assets/evaluation/dev-samples.json');
const dev = JSON.parse(devText) as Examples;
verifySamples(dev, 'dev');
if (dev.metadata.sourceSha256 !== dataset.metadata.sourceSha256) throw new Error('DEV and training source snapshots differ');

if (mode === 'calibrate') {
  const candidates: Options[] = [];
  for (const lexicalMix of [0.5, 0.75, 0.9]) for (const openingMix of [0.65, 0.85, 0.95]) for (const contextStrength of [0.8, 0.9, 1]) candidates.push({ lexicalMix, openingMix, contextStrength });
  const temperatures = [0.65, 0.8, 1, 1.1, 1.2, 1.35, 1.6, 2];
  const trials: Array<{ options: Options; metrics: ReturnType<typeof measure>; raw: ReturnType<typeof measure> }> = [];
  for (const candidate of candidates) {
    const engine = new ProbabilisticEngine(vocabulary.entries, dataset, { ...candidate, temperature: 1 });
    const observations = collect(engine, dev.samples);
    const raw = measure(observations, true, false);
    for (const temperature of temperatures) {
      const transformed = observations.map(item => ({ ...item, prediction: temperatureScale(item.prediction, temperature) }));
      trials.push({ options: { ...candidate, temperature }, metrics: measure(transformed, true, false), raw });
    }
    console.log(JSON.stringify({ stage: 'DEV', candidate, raw }));
  }
  trials.sort((a, b) => a.metrics.letterNllNats - b.metrics.letterNllNats);
  const best = trials[0];
  const fitted = new ProbabilisticEngine(vocabulary.entries, dataset, best.options);
  const observations = collect(fitted, dev.samples);
  const measured = measure(observations, true);
  if (Math.abs(measured.letterNllNats - best.metrics.letterNllNats) > 0.00001) throw new Error('Engine temperature differs from evaluator transformation');
  const artifact = {
    schemaVersion: 1, options: best.options,
    fittedOn: 'DEV only, exact-normalized sequence SHA256 modulo20=1; TEST modulo20=0 was not read by calibration.',
    objective: 'Minimum mean conditional-next-letter negative log likelihood in nats across equal-size initial/body x prefix0/1/2 strata.',
    devSampleSha256: sha(devText), dataHashes, devPositions: dev.samples.length,
    devSelectedMetrics: measured,
    temperatureGrid: temperatures, candidateConfigurations: candidates,
    limitations: 'Same-corpus calibration; external wordfreq training may overlap. Temperature only calibrates letters conditional on continuing the current token, not end-of-word or word suggestions.',
  };
  save('src/prediction/calibration.json', artifact);
  // Descriptive only. The baseline saw DEV during its historical training and
  // therefore cannot be used to claim unbiased development-set improvement.
  const baseline = new StatisticalEngine(new LexicalEngine(vocabulary.entries), json('assets/context/it-context.json'), json('assets/context/it-openings.json'));
  const baselineObservations = collect(baseline, dev.samples);
  save('assets/evaluation/dev-report.json', { artifact, trials, selectedByStratum: grouped(observations, true),
    historicalBaselineByStratum: grouped(baselineObservations, false),
    baselineCaveat: 'Historical baseline trained on DEV. This comparison is optimistic for the baseline and descriptive only; it did not affect the grid-search objective.' });
  console.log(JSON.stringify({ selected: best.options, metrics: measured, artifactSha256: sha(read('src/prediction/calibration.json')) }, null, 2));
} else {
  const calibrationText = read('src/prediction/calibration.json');
  const calibration = JSON.parse(calibrationText);
  for (const [key, value] of Object.entries(dataHashes)) if (calibration.dataHashes[key] !== value) throw new Error(`Frozen calibration ${key} differs; recalibrate DEV explicitly before TEST`);
  if (calibration.devSampleSha256 !== sha(devText)) throw new Error('Frozen DEV sample differs');
  const testText = read('assets/evaluation/test-samples.json');
  const examples = JSON.parse(testText) as Examples;
  verifySamples(examples, 'test');
  if (examples.metadata.sourceSha256 !== dataset.metadata.sourceSha256) throw new Error('TEST and training source snapshots differ');
  const oldContext = json('assets/context/it-context.json'), oldOpenings = json('assets/context/it-openings.json');
  const baselineStarted = performance.now();
  const baseline = new StatisticalEngine(new LexicalEngine(vocabulary.entries), oldContext, oldOpenings);
  const baselineConstructorMs = performance.now() - baselineStarted;
  const updatedStarted = performance.now();
  const updated = new ProbabilisticEngine(vocabulary.entries, dataset, calibration.options);
  const updatedConstructorMs = performance.now() - updatedStarted;
  // Identical DEV warmup. TEST observations are collected once per policy.
  for (let i = 0; i < 300; i++) { const sample = dev.samples[Math.floor(i * dev.samples.length / 300)]; baseline.predict(sample.text); updated.predict(sample.text); }
  const oldObservations = collect(baseline, examples.samples);
  const newObservations = collect(updated, examples.samples);
  const oldMetrics = grouped(oldObservations, false), newMetrics = grouped(newObservations, true);
  const differences: Record<string, Record<string, number>> = {};
  for (const group of Object.keys(oldMetrics)) {
    differences[group] = {};
    for (const key of Object.keys(oldMetrics[group])) {
      const before = oldMetrics[group][key as keyof ReturnType<typeof measure>], after = newMetrics[group][key as keyof ReturnType<typeof measure>];
      if (typeof before === 'number' && typeof after === 'number' && key !== 'positions') differences[group][key] = rounded(after - before);
    }
  }
  const report = {
    version: 1, testSampleSha256: sha(testText), devSampleSha256: sha(devText), calibrationSha256: sha(calibrationText), dataHashes,
    baselineHashes: { engine: sha(read('src/prediction/statistical-engine.ts')), lexical: sha(read('src/prediction/lexical-engine.ts')), opening: sha(read('src/prediction/opening-policy.ts')), contextData: sha(read('assets/context/it-context.json')), openingData: sha(read('assets/context/it-openings.json')) },
    policyHashes: { adaptive: sha(read('src/prediction/adaptive-letters.ts')), pages: sha(read('src/prediction/letter-pages.ts')), cost: sha(read('src/prediction/keyboard-cost.ts')) },
    options: calibration.options, sampling: examples.metadata,
    method: 'Frozen TEST, same exact text and targets for current StatisticalEngine+OpeningPolicy baseline and ProbabilisticEngine. Prefix0/1/2, excluding targets already entirely revealed. Letter scores normalized over continuing letters. NLL uses natural log and a 1e-12 floor for unseen letters; multiclass Brier sums over the alphabet. Top1 ECE uses 10 equal-width bins. Macro-average six equal-sized strata; report each separately.',
    interactionEstimate: 'Actual shipped buildLetterPages with new cost policy versus frozen old 90% score-coverage policy, cap8. Idealized letter taps choose shortest route: page index+1, or ABC+letter (2 taps). Excludes word completion, visual search, motion, correction and learning; not measured human typing speed. Repeated targets in tail pages use earliest occurrence.',
    startup: { desktopBaselineConstructionMs: rounded(baselineConstructorMs), desktopUpdatedConstructionMs: rounded(updatedConstructorMs), scope: 'Single desktop Node process, all JSON already parsed for both models. Constructors include index construction. Not an end-to-end launch benchmark or phone measurement.' },
    baseline: oldMetrics, updated: newMetrics, updatedMinusBaseline: differences,
    pairedUncertainty: pairedIntervals(oldObservations, newObservations),
    limitations: [
      'Tatoeba translated/example sentences overrepresent names and repeated templates; not private chat or real users.',
      'Exact duplicates removed before splitting; near-duplicate paraphrases can remain across train/dev/test. External wordfreq data may overlap the corpus.',
      'New model trains on folds2..19; baseline was already trained on folds1..19. Both exclude TESTfold0. Baseline DEV performance would be optimistic, so baseline was not used for parameter selection.',
      'End-of-word probability and complete-word probabilities are not calibrated by the fitted letter temperature. Test excludes completed-word targets.',
      'Desktop timings depend on cache, process scheduling and JIT. Initial and body strata share warm caches. No smartphone timing or human speed claim.',
      'Fitts/Hick/default error costs are starting assumptions, not fitted user motor measurements.',
    ],
  };
  save('assets/evaluation/benchmark.json', report);
  console.log(JSON.stringify({ options: calibration.options, baseline: oldMetrics.all, updated: newMetrics.all, updatedMinusBaseline: differences, startup: report.startup }, null, 2));
}
