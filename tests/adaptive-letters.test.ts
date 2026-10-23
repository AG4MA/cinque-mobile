import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chooseAdaptiveLetters, placeStableLetters } from '../src/prediction/adaptive-letters';
import { LexicalEngine } from '../src/prediction/lexical-engine';
import { StatisticalEngine } from '../src/prediction/statistical-engine';

const letters = (scores: number[]) => scores.map((score, index) => ({ letter: 'abcdefghijklmnopqrstuvwxyz'[index], score }));

test('concentrated predictions use four choices and diffuse predictions expand up to the cap', () => {
  assert.equal(chooseAdaptiveLetters(letters([80, 10, 5, 4, 1])).count, 4);
  const diffuse = letters(Array(20).fill(1));
  for (const cap of [4, 6, 8, 10]) assert.equal(chooseAdaptiveLetters(diffuse, cap).count, cap);
  assert.equal(chooseAdaptiveLetters(diffuse).count, 8);
  assert.equal(chooseAdaptiveLetters(diffuse, 100).count, 10);
  assert.equal(chooseAdaptiveLetters(diffuse, 1).count, 4);
  // Here the sixth option avoids a page for 5% of continuations, worth more
  // than its added search cost under the declared motor priors.
  assert.equal(chooseAdaptiveLetters(letters([30, 20, 20, 15, 10, 5])).count, 6);
});

test('selection is scale invariant, removes duplicates, and guarantees four accessible letters', () => {
  const input = letters([30, 20, 20, 15, 10, 5]);
  assert.deepEqual(chooseAdaptiveLetters(input).letters.map(item => item.letter),
    chooseAdaptiveLetters(input.map(item => ({ ...item, score: item.score * 0.001 }))).letters.map(item => item.letter));
  const chosen = chooseAdaptiveLetters([{ letter: 'A', score: 4 }, { letter: 'a', score: 6 },
    { letter: 'e', score: NaN }, { letter: 'text', score: 100 }, { letter: 'z', score: -1 }]);
  assert.equal(chosen.count, 4);
  assert.equal(chosen.letters[0].letter, 'a');
  assert.equal(new Set(chosen.letters.map(item => item.letter)).size, 4);
  assert.equal(chooseAdaptiveLetters([]).count, 8);
});

test('growing and shrinking choices preserves surviving positions and never loses selected letters', () => {
  const original = letters([4, 3, 2, 1]);
  const expanded = [...original].reverse().concat([{ letter: 'e', score: 0.5 }, { letter: 'f', score: 0.4 }]);
  const slots = placeStableLetters(original, expanded, 6);
  assert.deepEqual(slots.slice(0, 4).map(item => item?.letter), ['a', 'b', 'c', 'd']);
  const survivors = [expanded[4], original[1], original[2], expanded[5]];
  const reduced = placeStableLetters(slots, survivors, 4);
  assert.equal(reduced[1]?.letter, 'b');
  assert.equal(reduced[2]?.letter, 'c');
  assert.deepEqual(reduced.map(item => item?.letter).sort(), ['b', 'c', 'e', 'f']);
});

test('full Italian engine produces both narrow and wide choices from actual context', () => {
  const require = createRequire(import.meta.url);
  const vocabulary = require('../assets/runtime/lexicon.js');
  const contexts = require('../assets/runtime/context.js');
  const openings = require('../assets/runtime/openings.js');
  const engine = new StatisticalEngine(new LexicalEngine(vocabulary.entries), contexts, openings);
  const counts = new Set<number>();
  for (const text of ['', 'a', 'm', 'vo', 'p', 'vorrei ', 'vorrei m', 'Vorrei bere ac', 'zxq']) {
    const selection = chooseAdaptiveLetters(engine.predict(text).letters, 6);
    assert.ok(selection.count >= 4 && selection.count <= 6);
    assert.ok(Number.isFinite(selection.expectedTimeMs) && selection.expectedTimeMs > 0);
    counts.add(selection.count);
  }
  assert.ok(counts.size > 1, 'real predictions must admit both narrower and broader groups');
});
