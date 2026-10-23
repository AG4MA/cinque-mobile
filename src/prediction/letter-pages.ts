import { chooseAdaptiveLetters, DEFAULT_MAX_LETTERS, MIN_LETTERS, rankLetterCandidates } from './adaptive-letters';
import type { LetterCandidate } from './lexical-engine';
import type { KeyboardCostOptions } from './keyboard-cost';

/** Page through every ranked continuation while retaining the adaptive first page. */
export function buildLetterPages(
  candidates: LetterCandidate[], maxLetters = DEFAULT_MAX_LETTERS, options: KeyboardCostOptions = {},
): LetterCandidate[][] {
  const first = chooseAdaptiveLetters(candidates, maxLetters, options).letters;
  const ranked = rankLetterCandidates(candidates);
  const pages = [first];
  for (let offset = first.length; offset < ranked.length; offset += first.length) {
    // Only the last page may repeat letters: expose its remaining choices with
    // the smallest overlap needed to retain four usable targets.
    const start = Math.min(offset, ranked.length - MIN_LETTERS);
    pages.push(ranked.slice(start, offset + first.length));
  }
  return pages;
}
