import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAdaptiveLetters, placeStableLetters, rankLetterCandidates } from '../src/prediction/adaptive-letters';
import { buildLetterPages } from '../src/prediction/letter-pages';
import { entropyBits, estimateKeyboardCost, keyboardGeometry, targetTimeMs } from '../src/prediction/keyboard-cost';

const alphabet = "abcdefghijklmnopqrstuvwxyzàèéìòù'";
const letters = (scores: number[]) => scores.map((score, index) => ({ letter: alphabet[index], score }));

test('entropy measures uncertainty independently of score scale and ignores invalid weights', () => {
  assert.equal(entropyBits([1, 0, 0]), 0);
  assert.equal(entropyBits([1, 1, 1, 1]), 2);
  assert.equal(entropyBits([NaN, -1, Infinity, 0]), 0);
  assert.equal(entropyBits([10, 20]), entropyBits([1, 2]));
});

test('selected count minimizes the explicit expected cost across every permitted alternative', () => {
  const inputs = [letters([80, 10, 5, 4, 1]), letters([30, 20, 20, 15, 10, 5]), letters(Array(26).fill(1))];
  for (const candidates of inputs) for (const cap of [4, 6, 8, 10]) {
    const ranked = rankLetterCandidates(candidates);
    const selected = chooseAdaptiveLetters(candidates, cap);
    for (let count = 4; count <= Math.min(cap, ranked.length); count++) {
      const alternative = estimateKeyboardCost(ranked, count, keyboardGeometry(cap));
      assert.ok(selected.expectedTimeMs <= alternative.expectedTimeMs + 0.011);
    }
    assert.ok(selected.entropyBits >= 0 && selected.entropyBits <= Math.log2(ranked.length) + 1e-10);
  }
});

test('paging cost counts each letter once despite a repeated minimum-four tail', () => {
  const ranked = rankLetterCandidates(letters(Array(18).fill(1)));
  const result = estimateKeyboardCost(ranked, 8, keyboardGeometry(8));
  assert.ok(Math.abs(result.estimatedPageTaps - (8 + 2 * 2) / 18) < 1e-10);
  assert.ok(result.expectedTimeMs < estimateKeyboardCost(ranked, 4, keyboardGeometry(8)).expectedTimeMs);
});

test('handed geometry mirrors reach time and places the strongest unfamiliar letter near the thumb', () => {
  const right = keyboardGeometry(8), left = keyboardGeometry(8, { leftHand: true });
  const candidates = letters([70, 20, 8, 2]);
  for (let slot = 0; slot < 8; slot++) {
    const mirrored = Math.floor(slot / 4) * 4 + 3 - slot % 4;
    assert.ok(Math.abs(targetTimeMs(slot, right) - targetTimeMs(mirrored, left)) < 1e-8);
  }
  const rightSlots = placeStableLetters([], candidates, 8, { geometry: right });
  const leftSlots = placeStableLetters([], candidates, 8, { geometry: left });
  assert.equal(rightSlots[7]?.letter, 'a');
  assert.equal(leftSlots[4]?.letter, 'a');
  assert.equal(rightSlots.filter(Boolean).length, 4);
});

test('fixed slots survive changes of count, rank and page, with no candidate loss', () => {
  const initial = letters([50, 30, 15, 5]);
  const slots = placeStableLetters([], initial, 8);
  const changed = letters([5, 20, 35, 30, 6, 4]);
  const expanded = placeStableLetters(slots, changed, 8);
  initial.forEach(item => assert.equal(expanded.findIndex(candidate => candidate?.letter === item.letter),
    slots.findIndex(candidate => candidate?.letter === item.letter)));
  const reduced = placeStableLetters(expanded, changed.slice(0, 4), 8);
  assert.deepEqual(reduced.filter(Boolean).map(item => item!.letter).sort(), ['a', 'b', 'c', 'd']);
  const pages = buildLetterPages(letters(Array(26).fill(1)), 8);
  for (const page of pages) {
    const layout = placeStableLetters([], page, 8);
    assert.deepEqual(layout.filter(Boolean).map(item => item!.letter).sort(), page.map(item => item.letter).sort());
  }
});

test('exact assignment moves a badly placed dominant key only for a substantial cost reduction', () => {
  const candidates = letters([99, 0.3, 0.3, 0.4]);
  const slots = placeStableLetters(candidates, candidates, 8);
  assert.equal(slots[7]?.letter, 'a');
  assert.equal(slots[1]?.letter, 'b');
  assert.equal(slots[2]?.letter, 'c');
  assert.equal(slots[3]?.letter, 'd');
});

test('layout guards invalid dimensions and capacity without allocating unbounded work', () => {
  const geometry = keyboardGeometry(8, { width: NaN, rows: Infinity, keyHeight: -20, gap: 1000 });
  assert.equal(geometry.width, 320);
  assert.equal(geometry.keyHeight, 64);
  assert.equal(geometry.gap, 24);
  assert.equal(placeStableLetters([], letters([1, 1, 1, 1]), NaN).length, 0);
  assert.equal(placeStableLetters([], letters(Array(26).fill(1)), 10000).length, 10);
});
