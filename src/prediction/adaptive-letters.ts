import type { LetterCandidate } from './lexical-engine';
import { entropyBits, estimateKeyboardCost, keyboardGeometry, optimizeLetterSlots, type KeyboardCostOptions } from './keyboard-cost';

export const MIN_LETTERS = 4;
export const DEFAULT_MAX_LETTERS = 8;
export const MAX_LETTERS = 10;
const FALLBACK = ['e', 'a', 'i', 'o', 'n', 'r', 't', 'l', 's', 'c'];

/** Valid candidate letters in rank order, with duplicate weights combined. */
export function rankLetterCandidates(candidates: LetterCandidate[]): LetterCandidate[] {
  const weights = new Map<string, number>();
  for (const candidate of candidates) {
    const letter = candidate.letter.toLocaleLowerCase('it').normalize('NFC');
    if (!/^[a-zàèéìòù']$/u.test(letter) || !Number.isFinite(candidate.score) || candidate.score <= 0) continue;
    weights.set(letter, (weights.get(letter) ?? 0) + candidate.score);
  }
  const total = Array.from(weights.values()).reduce((sum, weight) => sum + weight, 0);
  return Array.from(weights, ([letter, score]) => ({ letter, score: score / total }))
    .sort((a, b) => b.score - a.score);
}

/** Minimize estimated search, reach, paging and correction time within the cap. */
export function chooseAdaptiveLetters(
  candidates: LetterCandidate[], maxLetters = DEFAULT_MAX_LETTERS, options: KeyboardCostOptions = {},
) {
  const cap = Math.max(MIN_LETTERS, Math.min(MAX_LETTERS,
    Number.isFinite(maxLetters) ? Math.floor(maxLetters) : DEFAULT_MAX_LETTERS));
  const ranked = rankLetterCandidates(candidates);
  if (!ranked.length) FALLBACK.forEach(letter => ranked.push({ letter, score: 1 / FALLBACK.length }));
  // The engine normally supplies at least four; retain a usable keyboard even
  // when a future predictor supplies only one or two continuations.
  for (const letter of FALLBACK) {
    if (ranked.length >= MIN_LETTERS) break;
    if (!ranked.some(candidate => candidate.letter === letter)) ranked.push({ letter, score: 0 });
  }
  const geometry = keyboardGeometry(cap, options.geometry);
  let count = MIN_LETTERS;
  let estimate = estimateKeyboardCost(ranked, count, geometry, options.previous);
  for (let size = MIN_LETTERS + 1; size <= Math.min(cap, ranked.length); size++) {
    const alternative = estimateKeyboardCost(ranked, size, geometry, options.previous);
    // Ties favor fewer choices. Motor/search coefficients are engineering
    // priors, not calibrated human timings.
    if (alternative.expectedTimeMs < estimate.expectedTimeMs - 0.01) {
      count = size;
      estimate = alternative;
    }
  }
  const coverage = ranked.slice(0, count).reduce((sum, item) => sum + item.score, 0);
  return { letters: ranked.slice(0, count), count, coverage, concentrated: count === MIN_LETTERS,
    entropyBits: entropyBits(ranked.map(item => item.score)), ...estimate };
}

/** Keep familiar positions unless a globally cheaper assignment clearly wins. */
export function placeStableLetters(
  previous: Array<LetterCandidate | null>, selected: LetterCandidate[], capacity: number,
  options: KeyboardCostOptions = {},
): Array<LetterCandidate | null> {
  return optimizeLetterSlots(previous, selected, capacity, keyboardGeometry(capacity, options.geometry));
}
