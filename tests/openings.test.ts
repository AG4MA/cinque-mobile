import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { LexicalEngine } from '../src/prediction/lexical-engine';
import { OpeningPolicy, type OpeningDataset } from '../src/prediction/opening-policy';
import { StatisticalEngine, type ContextDataset } from '../src/prediction/statistical-engine';

const lexicon = JSON.parse(readFileSync(new URL('../assets/lexicon/it.json', import.meta.url), 'utf8'));
const dataset: OpeningDataset = JSON.parse(readFileSync(new URL('../assets/context/it-openings.json', import.meta.url), 'utf8'));
const lexical = new LexicalEngine(lexicon.entries);
const policy = new OpeningPolicy(lexical, dataset);

test('opening counts cover the original training split without a top8 truncation', () => {
  assert.equal(dataset.entries.length, 13_408);
  assert.equal(dataset.entries.reduce((sum, [, count]) => sum + count, 0), 863_358);
  assert.equal(dataset.metadata.holdoutSequences, 45_160);
  for (let i = 1; i < dataset.entries.length; i++) assert.ok(dataset.entries[i - 1][0] < dataset.entries[i][0]);
  for (const word of ['ciao', 'buongiorno', 'grazie', 'tom', 'mary']) {
    assert.ok(dataset.entries.some(([entry, count]) => entry === word && count > 0), word);
  }
});

test('opening choices cover common initials without promoting corpus names by default', () => {
  const initial = policy.predict('');
  for (const letter of ['c', 's', 'a']) assert.ok(initial.letters.slice(0, 8).some(candidate => candidate.letter === letter), letter);
  assert.ok(initial.words.every(candidate => candidate.word !== 'tom' && candidate.word !== 'mary'));
  assert.ok(policy.predict('tom').words.some(candidate => candidate.word === 'tom'));
  assert.ok(policy.predict('mary').words.some(candidate => candidate.word === 'mary'));
});

test('observed greetings appear after their prefix without a hand-written starter list', () => {
  for (const [prefix, expected] of [['ci', 'ciao'], ['bu', 'buongiorno'], ['gr', 'grazie'], ['vo', 'vorrei']]) {
    const prediction = policy.predict(prefix);
    assert.ok(prediction.words.slice(0, 3).some(candidate => candidate.word === expected), `${prefix}: ${expected}`);
    assert.ok(prediction.words.every(candidate => candidate.word.startsWith(prefix)));
  }
});

test('all matching opening words contribute to letters; unknown prefixes preserve lexical fallback', () => {
  const miniature = new OpeningPolicy(lexical, { metadata: {}, entries: [
    ['casa', 8], ['cena', 7], ['cibo', 6], ['coda', 5], ['cura', 4], ['crema', 3], ['cliente', 2], ['chiesa', 1],
  ] });
  const result = miniature.predict('c');
  for (const letter of ['a', 'e', 'i', 'o', 'u', 'r', 'l', 'h']) assert.ok(result.letters.some(candidate => candidate.letter === letter && candidate.score > 0));
  assert.ok(result.letters.find(candidate => candidate.letter === 'h')!.score > lexical.predict('c').letters.find(candidate => candidate.letter === 'h')!.score * 0.5);
  assert.deepEqual(policy.predict('zxq'), lexical.predict('zxq'));
  assert.ok(result.letters.every(candidate => Number.isFinite(candidate.score) && candidate.score >= 0));
  assert.throws(() => new OpeningPolicy(lexical, { metadata: {}, entries: [['ciao', -1]] }), /Invalid opening dataset/);
});

test('opening policy applies at sentence starts and preserves predictions after completed words', () => {
  const context: ContextDataset = { metadata: {}, contexts: [
    ['<s>', [['tom', 100]]], ['ciao', [['come', 30]]], ['come', [['stai', 40]]], ['bere', [['acqua', 50]]],
  ] };
  const previous = new StatisticalEngine(new LexicalEngine(lexicon.entries), context);
  const next = new StatisticalEngine(new LexicalEngine(lexicon.entries), context, dataset);
  for (const text of ['', 'ci', 'Ciao. ci', 'Ciao! bu', 'Ciao\ngr']) assert.equal(next.predict(text).source, 'opening', text);
  for (const text of ['Ciao ', 'Ciao, come ', 'Vorrei bere ac', "L'acq"]) {
    assert.deepEqual(next.predict(text), previous.predict(text), text);
  }
});
