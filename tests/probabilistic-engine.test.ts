import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ProbabilisticEngine, type ProbabilityDataset } from '../src/prediction/probabilistic-engine';
import { ProbabilityIndex } from '../src/prediction/probability-index';
import type { Entry } from '../src/prediction/lexical-engine';

const smallEntries: Entry[] = [['cane', 500], ['casa', 500], ['mare', 500], ['mela', 500]];
const empty: ProbabilityDataset = { metadata: {}, contexts: [], unigram: [], continuation: [] };
const close = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('prefix index agrees with exhaustive mass and top-five retrieval', () => {
  const words = ['a', 'abate', 'abete', 'aceto', 'acqua', 'acquisto', 'adesso', 'affetto', 'amico', 'bacio', 'bacino', 'banca'];
  const weights = Float64Array.from([1, 3, 7, 4, 2, 9, 8, 6, 5, 11, 10, 12]);
  const index = new ProbabilityIndex(words, weights);
  const alphabet = [...'abcdefghijklmnopqrstuvwxyz'];
  const total = weights.reduce((a, b) => a + b, 0);
  for (const prefix of ['', 'a', 'ab', 'ac', 'acq', 'b', 'bac', 'z', 'acqua']) {
    const actual = index.lookup(prefix, alphabet);
    const matching = words.map((word, i) => ({ word, i, weight: weights[i] })).filter(row => row.word.startsWith(prefix));
    close(actual.mass, matching.reduce((sum, row) => sum + row.weight / total, 0));
    const top = [...matching].sort((a, b) => b.weight - a.weight || a.i - b.i).slice(0, 5).map(row => row.i);
    assert.deepEqual(actual.top, top);
    for (const [letter, mass] of actual.letters) {
      close(mass, matching.filter(row => row.word[prefix.length] === letter).reduce((sum, row) => sum + row.weight / total, 0));
    }
    assert.equal(index.lookup(prefix, alphabet), actual, 'immutable prefixes are cached');
  }
});

test('prefix top-k is deterministic under equal probabilities', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const index = new ProbabilityIndex(words, Float64Array.from(words.map(() => 1)));
  assert.deepEqual(index.lookup('', words).top, [0, 1, 2, 3, 4]);
});

test('pruned context mass backs off against full denominators', () => {
  const model: ProbabilityDataset = { ...empty, contexts: [['il', 100, 2, [['casa', 10]]]] };
  const engine = new ProbabilisticEngine([['casa', 500], ['mare', 500]], model, { lexicalMix: 1, contextStrength: 1, discount: 0.5, personalization: false });
  const prediction = engine.predict('il ');
  const scores = new Map(prediction.words.map(word => [word.word, word.score]));
  close(scores.get('casa')!, 0.5475);
  close(scores.get('mare')!, 0.4525);
  close(prediction.words.reduce((sum, row) => sum + row.score, 0), 1);
  assert.equal(prediction.source, 'context');
});

test('hierarchical interpolation has exact normalized word mass', () => {
  const model: ProbabilityDataset = { ...empty, contexts: [
    ['il', 10, 2, [['casa', 6], ['mare', 4]]],
    ['vedo il', 5, 1, [['casa', 5]]],
  ] };
  const engine = new ProbabilisticEngine([['casa', 500], ['mare', 500]], model, { lexicalMix: 1, contextStrength: 1, discount: 0.5, personalization: false });
  const prediction = engine.predict('vedo il ');
  // Lower: casa=.55+.1*.5=.60, mare=.35+.1*.5=.40.
  // Higher: casa=.9+.1*.60=.96, mare=.1*.40=.04.
  close(prediction.words.find(row => row.word === 'casa')!.score, 0.96);
  close(prediction.words.find(row => row.word === 'mare')!.score, 0.04);
});

test('conditional letter distributions stay finite, positive and normalized', () => {
  const engine = new ProbabilisticEngine(smallEntries, empty, { personalization: false });
  for (const text of ['', 'c', 'cas', 'casa', 'zzzx', 'Vedo il ', 'Ciao. c', '🙂', 'a'.repeat(2000)]) {
    const prediction = engine.predict(text);
    assert.equal(prediction.letters.length, 33);
    assert.equal(new Set(prediction.letters.map(row => row.letter)).size, 33);
    assert.ok(prediction.letters.every(row => Number.isFinite(row.score) && row.score > 0));
    close(prediction.letters.reduce((sum, row) => sum + row.score, 0), 1);
    assert.ok(Number.isFinite(prediction.entropy) && prediction.entropy >= 0);
    assert.ok(prediction.endProbability >= 0 && prediction.endProbability <= 1);
  }
  close(engine.predict('casa').endProbability, 1);
  close(engine.predict('cas').endProbability, 0);
});

test('temperature implements the same conditional transform used by calibration', () => {
  const raw = new ProbabilisticEngine(smallEntries, empty, { temperature: 1, personalization: false }).predict('c');
  const calibrated = new ProbabilisticEngine(smallEntries, empty, { temperature: 1.4, personalization: false }).predict('c');
  const total = raw.letters.reduce((sum, row) => sum + row.score ** (1 / 1.4), 0);
  for (const row of raw.letters) close(calibrated.letters.find(next => next.letter === row.letter)!.score, row.score ** (1 / 1.4) / total);
  assert.deepEqual(calibrated.words, raw.words);
  assert.ok(calibrated.entropy > raw.entropy);
});

test('personal learning uses only current bounded composition and undo removes it', () => {
  const engine = new ProbabilisticEngine(smallEntries, empty);
  const before = engine.predict('voglio ');
  const personalized = engine.predict('voglio zaffiro. voglio zaffiro. voglio ');
  assert.ok(personalized.words.some(row => row.word === 'zaffiro'), 'new personal word is offered without a dictionary entry');
  const repeated = engine.predict('voglio zaffiro. voglio zaffiro. voglio ');
  assert.deepEqual(repeated, personalized, 'reading predictions must not count as learning');
  assert.deepEqual(engine.predict('voglio '), before, 'undo reconstructs counts and removes the deleted evidence');
  const other = new ProbabilisticEngine(smallEntries, empty);
  assert.deepEqual(other.predict('voglio '), before, 'personal counts never persist between engine instances');
});

test('sentence boundaries reset contextual history while apostrophes split tokens', () => {
  const model: ProbabilityDataset = { ...empty, contexts: [['il', 10, 1, [['mare', 10]]], ['l', 10, 1, [['casa', 10]]]] };
  const engine = new ProbabilisticEngine(smallEntries, model, { personalization: false });
  assert.deepEqual(engine.predict('il. '), engine.predict(''));
  assert.deepEqual(engine.predict('il! '), engine.predict(''));
  assert.deepEqual(engine.predict('il\n'), engine.predict(''));
  assert.equal(engine.predict("l'").source, 'context');
  assert.equal(engine.predict('il ').source, 'context');
});

test('real model excludes development and test data and supports conversational openings', () => {
  const dataset = JSON.parse(readFileSync(new URL('../assets/probability/it-model.json', import.meta.url), 'utf8')) as ProbabilityDataset;
  const vocabulary = JSON.parse(readFileSync(new URL('../assets/lexicon/it.json', import.meta.url), 'utf8')) as { entries: Entry[] };
  assert.equal(dataset.metadata.sourceSha256, '05853b510a67ad0615b993e29ae7cecb482af12524a52b9646dcfe76ea29afa3');
  assert.match(String(dataset.metadata.split), /Neither TEST nor DEV/);
  const statistics = dataset.metadata.statistics as Record<string, number>;
  assert.equal(statistics.trainingSequences, 817943);
  assert.equal(statistics.developmentSequences, 45415);
  assert.equal(statistics.testSequences, 45160);
  assert.ok(dataset.contexts.find(row => row[0] === '<s>')![3].length > 10000);
  const engine = new ProbabilisticEngine(vocabulary.entries, dataset, { personalization: false });
  assert.ok(engine.predict('ci').words.some(row => row.word === 'ciao'));
  assert.ok(engine.predict('bu').words.some(row => row.word === 'buongiorno'));
  assert.equal(engine.predict('').source, 'opening');
  for (const text of ['', 'ci', 'bu', 'vorrei bere un ca', 'sono andato a ', 'zxq']) {
    const prediction = engine.predict(text);
    close(prediction.letters.reduce((sum, row) => sum + row.score, 0), 1);
    assert.ok(prediction.words.every(row => row.score > 0 && row.score <= 1 + 1e-8));
  }
});

test('invalid probability asset rows fail with a useful diagnostic', () => {
  assert.throws(() => new ProbabilisticEngine(smallEntries, { ...empty, contexts: [['il', 1, 1, [['casa', 2]]]] }), /Inconsistent probability totals/);
  assert.throws(() => new ProbabilisticEngine(smallEntries, { ...empty, continuation: [['casa', -1]] }), /Invalid continuation row/);
});
