import { LexicalEngine, splitComposition, type Prediction, type WordCandidate } from './lexical-engine';

export type OpeningDataset = {
  metadata: Record<string, unknown>;
  entries: Array<[string, number]>;
};

const WORD = /^[a-zàèéìòù]+$/u;
const SINGLE = new Set(['a', 'e', 'è', 'i', 'o']);
const COUNT_POWER = 0.8;
const FREQUENCY_POWER = 0.25;
const LETTER_BLEND = 0.5;
const WORD_BLEND = 0.85;

/** Complete observed opening counts, smoothed against the general Italian lexicon.
 * These are ranking weights, not measured probabilities of what a person will type.
 */
export class OpeningPolicy {
  private readonly weighted: WordCandidate[];

  constructor(private readonly lexical: LexicalEngine, dataset: OpeningDataset) {
    if (!Array.isArray(dataset.entries)) throw new Error('Opening dataset is not an array');
    this.weighted = [];
    for (let index = 0; index < dataset.entries.length; index++) {
      const row = dataset.entries[index];
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
        || !Number.isSafeInteger(row[1]) || row[1] <= 0) {
        throw new Error(`Invalid opening dataset row at index ${index}`);
      }
      const [word, count] = row;
      if (!WORD.test(word) || (word.length === 1 && !SINGLE.has(word))) continue;
      const frequency = lexical.frequency(word);
      if (frequency <= 0) continue;
      // Compress repeated examples and temper corpus-specific names using an
      // independent unigram prior. Names stay available; none are blacklisted.
      const score = count ** COUNT_POWER * 10 ** ((frequency - 7) * FREQUENCY_POWER);
      this.weighted.push({ word, score });
    }
  }

  predict(text: string): Prediction {
    const { prefix } = splitComposition(text);
    const base = this.lexical.predict(text);
    const matches = this.weighted.filter(candidate => candidate.word.startsWith(prefix));
    if (matches.length === 0) return base;

    const openingTotal = matches.reduce((sum, candidate) => sum + candidate.score, 0);
    const wordScores = new Map(base.words.map(candidate => [candidate.word, candidate.score * (1 - WORD_BLEND)]));
    const letterScores = new Map<string, number>();
    let continuationTotal = 0;
    for (const { word, score } of matches) {
      wordScores.set(word, (wordScores.get(word) ?? 0) + WORD_BLEND * score / openingTotal);
      const next = word[prefix.length];
      if (next) {
        continuationTotal += score;
        letterScores.set(next, (letterScores.get(next) ?? 0) + score);
      }
    }
    // Aggregate every matching opening, not only the words visible in the strip.
    // Preserve the full lexical tail so previously unseen starters stay reachable.
    const letters = base.letters.map(candidate => ({
      letter: candidate.letter,
      score: continuationTotal > 0
        ? candidate.score * (1 - LETTER_BLEND) + (letterScores.get(candidate.letter) ?? 0) / continuationTotal * LETTER_BLEND
        : candidate.score,
    })).sort((a, b) => b.score - a.score);
    const words = [...wordScores].map(([word, score]) => ({ word, score }))
      .sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)).slice(0, 5);
    return { letters, words, source: 'opening', busy: false };
  }
}
