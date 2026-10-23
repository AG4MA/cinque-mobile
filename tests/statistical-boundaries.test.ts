import assert from 'node:assert/strict';
import test from 'node:test';
import { LexicalEngine, type Entry } from '../src/prediction/lexical-engine';
import { StatisticalEngine } from '../src/prediction/statistical-engine';

const entries: Entry[] = [['cane', 500], ['corre', 420], ['di', 700], ['dinosauro', 350], ['il', 690], ['marmellata', 380]];
const createEngine = () => new StatisticalEngine(new LexicalEngine(entries), { metadata: {}, contexts: [] });

test('session expression learning never joins words across sentence boundaries', () => {
  for (const separator of ['. ', '! ', '? ', '\n']) {
    const engine = createEngine();
    const result = engine.predict(`Marmellata${separator}Dinosauro${separator}Marmellata `);
    assert.equal(result.source, 'lexicon', `Cross-sentence transition was learned for ${JSON.stringify(separator)}.`);
    assert.notEqual(result.words[0]?.word, 'dinosauro');
  }
});

test('session still recalls expressions observed inside an earlier sentence', () => {
  const engine = createEngine();
  const result = engine.predict('Il cane corre. Il cane ');
  assert.equal(result.source, 'context');
  assert.equal(result.words[0]?.word, 'corre');
});
