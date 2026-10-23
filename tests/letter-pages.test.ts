import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdaptiveLetters, rankLetterCandidates } from '../src/prediction/adaptive-letters';
import { buildLetterPages } from '../src/prediction/letter-pages';

const alphabet = "abcdefghijklmnopqrstuvwxyzàèéìòù'";
const candidates = (scores: number[]) => scores.map((score, index) => ({ letter: alphabet[index], score }));
const labels = (pages: ReturnType<typeof buildLetterPages>) => pages.map(page => page.map(item => item.letter).join(''));

test('concentrated predictions retain four first choices and page through the next most likely letters', () => {
  const input = candidates([80, 10, 5, 4, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.03, 0.02]);
  const pages = buildLetterPages(input);
  assert.deepEqual(pages[0], chooseAdaptiveLetters(input).letters);
  assert.deepEqual(labels(pages), ['abcd', 'efgh', 'ijkl']);
  assert.ok(pages[1][0].score > pages[2][0].score);
});

test('broad predictions expose eight choices and overlap only the tail when fewer than four remain', () => {
  const input = candidates(Array(18).fill(1));
  const pages = buildLetterPages(input);
  assert.deepEqual(pages[0], chooseAdaptiveLetters(input).letters);
  assert.deepEqual(labels(pages), ['abcdefgh', 'ijklmnop', 'opqr']);
  assert.deepEqual(labels(buildLetterPages(candidates(Array(21).fill(1)))), ['abcdefgh', 'ijklmnop', 'qrstu']);
  assert.deepEqual(labels(buildLetterPages(candidates(Array(16).fill(1)))), ['abcdefgh', 'ijklmnop']);
});

test('all valid continuations remain reachable within the chosen cap and minimum four targets', () => {
  for (const cap of [4, 6, 8, 10, 1, 100, NaN, Infinity, 5.8]) {
    for (let length = 4; length <= alphabet.length; length++) {
      const input = candidates(Array(length).fill(1));
      const pages = buildLetterPages(input, cap);
      const selection = chooseAdaptiveLetters(input, cap);
      assert.deepEqual(pages[0], selection.letters);
      for (const page of pages) {
        assert.ok(page.length >= 4 && page.length <= selection.count);
        assert.equal(new Set(page.map(item => item.letter)).size, page.length);
        assert.ok(page.every((item, index) => index === 0 || item.score <= page[index - 1].score));
      }
      const exposed = [...new Set(pages.flat().map(item => item.letter))];
      assert.deepEqual(exposed, input.map(item => item.letter));
      const beforeLast = pages.slice(0, -1).flat().map(item => item.letter);
      assert.equal(new Set(beforeLast).size, beforeLast.length);
    }
  }
});

test('ranking combines case and Unicode duplicates, rejects invalid weights, and leaves inputs untouched', () => {
  const input = [
    { letter: 'A', score: 3 }, { letter: 'a', score: 2 }, { letter: 'E\u0300', score: 2 },
    { letter: 'è', score: 2 }, { letter: 'c', score: 3 }, { letter: 'd', score: 2 },
    { letter: 'e', score: 1 }, { letter: 'f', score: 0.5 }, { letter: 'g', score: 0.1 },
    { letter: 'abc', score: 200 }, { letter: 'h', score: NaN }, { letter: 'i', score: Infinity },
    { letter: 'j', score: 0 }, { letter: 'k', score: -1 }, { letter: '💡', score: 100 },
  ];
  const original = structuredClone(input);
  input.forEach(Object.freeze);
  Object.freeze(input);
  const pages = buildLetterPages(input, 4);
  assert.deepEqual(labels(pages), ['aècd', 'defg']);
  assert.deepEqual(pages[0], chooseAdaptiveLetters(input, 4).letters);
  assert.deepEqual(pages.flat().filter(item => item.letter === 'd').map(item => item.score), [2 / 15.6, 2 / 15.6]);
  assert.deepEqual(rankLetterCandidates(input).map(item => item.letter), ['a', 'è', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(input, original);
});

test('sparse or absent predictions have one usable page without invented additional probabilities', () => {
  for (const input of [[], candidates([10]), candidates([10, 1]), candidates([10, 1, 0.5])]) {
    const pages = buildLetterPages(input);
    assert.equal(pages.length, 1);
    assert.deepEqual(pages[0], chooseAdaptiveLetters(input).letters);
    if (input.length) {
      assert.equal(pages[0].filter(item => item.score > 0).length, input.length);
      assert.equal(pages[0].length, 4);
    }
  }
});
