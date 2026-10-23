import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { LexicalEngine } from '../src/prediction/lexical-engine';
import { StatisticalEngine } from '../src/prediction/statistical-engine';
import { ProbabilisticEngine } from '../src/prediction/probabilistic-engine';
import calibration from '../src/prediction/calibration.json';

const require = createRequire(import.meta.url);

test('phone runtime data preserves every lexicon and context row', () => {
  const vocabulary = require('../assets/runtime/lexicon.js');
  const context = require('../assets/runtime/context.js');
  const openings = require('../assets/runtime/openings.js');
  assert.deepEqual(vocabulary, JSON.parse(readFileSync(new URL('../assets/lexicon/it.json', import.meta.url), 'utf8')));
  assert.deepEqual(context, JSON.parse(readFileSync(new URL('../assets/context/it-context.json', import.meta.url), 'utf8')));
  assert.deepEqual(openings, JSON.parse(readFileSync(new URL('../assets/context/it-openings.json', import.meta.url), 'utf8')));
  const engine = new StatisticalEngine(new LexicalEngine(vocabulary.entries), context, openings);
  assert.equal(engine.contextCount, 150_000);
  assert.equal(engine.lexical.count, 316_423);
  const first = engine.predict('');
  assert.ok(first.letters.length >= 4);
  assert.ok(first.words.length > 0);
  assert.equal(first.source, 'opening');
  assert.ok(engine.predict('Vorrei bere ac').words.some(row => row.word === 'acqua'));
});

test('a broken native dataset reports the exact row before prediction', () => {
  assert.throws(() => new StatisticalEngine(new LexicalEngine([]), {
    metadata: {}, contexts: [undefined as never],
  }), /Invalid context dataset row at index 0/);
});

test('current phone runtime preserves the calibrated probability model and all rows', () => {
  const vocabulary = require('../assets/runtime/lexicon.js');
  const probability = require('../assets/runtime/probability.js');
  assert.deepEqual(probability, JSON.parse(readFileSync(new URL('../assets/probability/it-model.json', import.meta.url), 'utf8')));
  const engine = new ProbabilisticEngine(vocabulary.entries, probability, calibration.options);
  assert.equal(engine.contextCount, 150_000);
  for (const text of ['', 'ci', 'bu', 'Vorrei bere un ca']) {
    const prediction = engine.predict(text);
    assert.equal(prediction.letters.length, 33);
    assert.ok(prediction.letters.every(row => Number.isFinite(row.score) && row.score > 0));
    assert.ok(Math.abs(prediction.letters.reduce((sum, row) => sum + row.score, 0) - 1) < 1e-9);
  }
  assert.equal(engine.predict('Vorrei bere un ca').words[0].word, 'caffè');
});
