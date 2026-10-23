import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { LexicalEngine, splitComposition, replaceCurrentWord, type Entry } from '../src/prediction/lexical-engine';
import { StatisticalEngine, tokenize } from '../src/prediction/statistical-engine';

const entries: Entry[] = JSON.parse(readFileSync(new URL('../assets/lexicon/it.json', import.meta.url), 'utf8')).entries;
const engine = new LexicalEngine(entries);

test('real dataset remains sorted, unique and covers Italian inflections', () => {
  assert.ok(entries.length > 300_000);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1][0] < entries[i][0]);
  for (const word of ['tastiera', 'caffè', 'perché', 'scrivendo', 'andavamo']) assert.ok(engine.frequency(word) > 0, word);
  assert.ok(engine.frequency('casa') > engine.frequency('casamento'));
});

test('completion preserves sentence, accents, capitals and elision', () => {
  assert.deepEqual(splitComposition("Vorrei bere l'acq"), { before: "Vorrei bere l'", prefix: 'acq' });
  assert.equal(replaceCurrentWord("Vorrei bere l'acq", 'acqua'), "Vorrei bere l'acqua ");
  assert.equal(replaceCurrentWord('Caf', 'caffè'), 'Caffè ');
  assert.equal(replaceCurrentWord('CA', 'casa'), 'CASA ');
  assert.deepEqual(tokenize('Perché l’acqua è calda?'), ['perché', 'l', 'acqua', 'è', 'calda']);
  for (const prefix of ['ca', 'perch', 'tasti', 'scrit']) {
    const result = engine.predict('Sto scrivendo ' + prefix);
    assert.ok(result.words.length > 0);
    result.words.forEach(({ word }) => assert.ok(word.startsWith(prefix)));
    assert.ok(result.letters.length >= 4);
  }
});

test('observed phrase context changes completions with the same prefix', () => {
  const stats = new StatisticalEngine(new LexicalEngine(entries), {metadata:{},contexts:[
    ['ordino', [['pasta', 80], ['pane', 20]]], ['rinnovo il', [['passaporto', 30], ['patentino', 2]]],
  ]});
  assert.equal(stats.predict('Al ristorante ordino pa').words[0].word, 'pasta');
  assert.equal(stats.predict('Per viaggiare rinnovo il pa').words[0].word, 'passaporto');
  assert.equal(stats.predict('Al ristorante ordino pa').source, 'context');
  assert.equal(stats.predict('xyzq pa').source, 'lexicon');
});

test('sentence boundaries stop ngram history and prefix filtering never replaces typed letters', () => {
  const stats = new StatisticalEngine(new LexicalEngine(entries), {metadata:{},contexts:[
    ['bere', [['acqua', 80]]], ['<s>', [['ciao', 50]]],
  ]});
  assert.equal(stats.predict('Vorrei bere ').words[0].word, 'acqua');
  assert.equal(stats.predict('Vorrei bere. ').words[0].word, 'ciao');
  assert.ok(stats.predict('Vorrei bere tr').words.every(w => w.word.startsWith('tr')));
});

test('session adapts to names and undo removes personal learning', () => {
  const stats = new StatisticalEngine(new LexicalEngine(entries), {metadata:{},contexts:[]});
  assert.ok(stats.predict('zelmocrino è un nome. zelmocr').words.some(w => w.word === 'zelmocrino'));
  assert.ok(!stats.predict('zelmocr').words.some(w => w.word === 'zelmocrino'));
  assert.ok(stats.predict('zxq').letters.length >= 4);
  assert.ok(!stats.predict('').words.some(w => ['l', 'd', 'c'].includes(w.word)));
});

test('next-letter scores come from phrase candidates and remain finite', () => {
  const stats = new StatisticalEngine(new LexicalEngine(entries), {metadata:{},contexts:[['bevo', [['acqua', 90], ['aranciata', 10]]]]});
  const result = stats.predict('Io bevo a');
  assert.equal(result.letters[0].letter, 'c');
  assert.ok(result.letters.every(c => Number.isFinite(c.score) && c.score >= 0));
});
