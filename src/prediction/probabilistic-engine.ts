import { splitComposition, type Entry, type Prediction, type WordCandidate } from './lexical-engine';
import { ProbabilityIndex } from './probability-index';

export type ProbabilityContext = [string, number, number, Array<[string, number]>];
export type ProbabilityDataset = {
  metadata: Record<string, unknown>;
  contexts: ProbabilityContext[];
  unigram: Array<[string, number]>;
  continuation: Array<[string, number]>;
};
export type ProbabilityOptions = {
  /** Fitted on DEV only. Applied to letters conditional on continuation. */
  temperature?: number;
  discount?: number;
  contextStrength?: number;
  personalization?: boolean;
  lexicalMix?: number;
  openingMix?: number;
};
export type ProbabilisticPrediction = Prediction & {
  entropy: number;
  endProbability: number;
  probabilityModel: true;
};

const ALPHABET = [..."abcdefghijklmnopqrstuvwxyzàèéìòù'"];
const WORD = /^[a-zàèéìòù]+(?:'[a-zàèéìòù]+)*$/u;
const SINGLES = new Set(['a', 'e', 'è', 'i', 'o']);
const usable = (word: string) => WORD.test(word) && (word.length > 1 || SINGLES.has(word));
const tokens = (text: string) => text.normalize('NFC').toLocaleLowerCase('it').replace(/[‘’]/g, "'").match(/[a-zàèéìòù]+/g) ?? [];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const option = (value: number | undefined, fallback: number, low: number, high: number) => Number.isFinite(value) ? clamp(value!, low, high) : fallback;

/** Normalized word model with hierarchical absolute-discount interpolation.
 * The continuation prior is Kneser Ney inspired; higher orders use raw counts,
 * so this is explicitly not full modified Kneser Ney. Missing/pruned mass is
 * assigned to backoff rather than pretending retained candidates are complete.
 */
export class ProbabilisticEngine {
  readonly lexical: { count: number };
  readonly contextOrder = 3;
  readonly contextCount: number;
  private readonly contexts = new Map<string, ProbabilityContext>();
  private readonly general: ProbabilityIndex;
  private readonly opening: ProbabilityIndex;
  private readonly temperature: number;
  private readonly discount: number;
  private readonly contextStrength: number;
  private readonly personalization: boolean;
  private personalBefore = '';
  private personalWords = new Map<string, number>();
  private personalContexts = new Map<string, Map<string, number>>();

  constructor(entries: Entry[], dataset: ProbabilityDataset, options: ProbabilityOptions = {}) {
    this.lexical = { count: entries.length };
    this.temperature = option(options.temperature, 1, 0.25, 4);
    this.discount = option(options.discount, 0.75, 0, 0.99);
    this.contextStrength = option(options.contextStrength, 0.9, 0, 1);
    this.personalization = options.personalization !== false;
    const lexicalMix = option(options.lexicalMix, 0.75, 0, 1);
    const openingMix = option(options.openingMix, 0.65, 0, 1);
    if (!Array.isArray(dataset.contexts) || !Array.isArray(dataset.continuation) || !Array.isArray(dataset.unigram)) {
      throw new Error('Invalid probability dataset');
    }
    const vocabulary = new Map<string, { lexical: number; continuation: number; unigram: number; opening: number }>();
    const get = (word: string) => {
      let row = vocabulary.get(word);
      if (!row) { row = { lexical: 0, continuation: 0, unigram: 0, opening: 0 }; vocabulary.set(word, row); }
      return row;
    };
    let lexicalTotal = 0, continuationTotal = 0, unigramTotal = 0, openingTotal = 0;
    for (const [word, zipf100] of entries) {
      if (!usable(word) || !Number.isFinite(zipf100)) continue;
      const weight = 10 ** (zipf100 / 100 - 7);
      get(word).lexical = weight;
      lexicalTotal += weight;
    }
    for (const field of ['continuation', 'unigram'] as const) {
      for (let index = 0; index < dataset[field].length; index++) {
        const row = dataset[field][index];
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] <= 0) throw new Error(`Invalid ${field} row ${index}`);
        const [word, count] = row;
        if (!usable(word)) continue;
        get(word)[field] = count;
        if (field === 'continuation') continuationTotal += count;
        else unigramTotal += count;
      }
    }
    for (let index = 0; index < dataset.contexts.length; index++) {
      const row = dataset.contexts[index];
      if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] <= 0 || !Number.isSafeInteger(row[2]) || row[2] <= 0 || !Array.isArray(row[3])) {
        throw new Error(`Invalid probability context ${index}`);
      }
      let retained = 0;
      for (const pair of row[3]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !Number.isSafeInteger(pair[1]) || pair[1] <= 0) throw new Error(`Invalid probability candidate in context ${index}`);
        retained += pair[1];
        if (usable(pair[0])) get(pair[0]);
      }
      if (retained > row[1] || row[3].length > row[2]) throw new Error(`Inconsistent probability totals at ${index}`);
      this.contexts.set(row[0], row);
    }
    this.contextCount = this.contexts.size;
    for (const [word, count] of this.contexts.get('<s>')?.[3] ?? []) {
      if (!usable(word)) continue;
      const row = get(word);
      // A normalized domain prior softens repeated corpus examples using
      // independent lexical frequency, without a blacklist of names or phrases.
      const weight = count ** 0.8 * Math.max(row.lexical, 1e-9) ** 0.25;
      row.opening = weight;
      openingTotal += weight;
    }
    const words = [...vocabulary.keys()].sort();
    const generalWeights = new Float64Array(words.length);
    const openingWeights = new Float64Array(words.length);
    const corpusMix = 0.005;
    for (let index = 0; index < words.length; index++) {
      const row = vocabulary.get(words[index])!;
      const lexical = lexicalTotal ? row.lexical / lexicalTotal : 0;
      const continuation = continuationTotal ? row.continuation / continuationTotal : lexical;
      const unigram = unigramTotal ? row.unigram / unigramTotal : lexical;
      generalWeights[index] = (1 - corpusMix) * (lexicalMix * lexical + (1 - lexicalMix) * continuation) + corpusMix * unigram;
      openingWeights[index] = openingTotal ? (1 - openingMix) * generalWeights[index] + openingMix * row.opening / openingTotal : generalWeights[index];
    }
    this.general = new ProbabilityIndex(words, generalWeights);
    this.opening = new ProbabilityIndex(words, openingWeights);
  }

  private updatePersonal(before: string) {
    // Rebuild from the current composition, never from prediction invocations.
    // Undo/delete immediately removes observations; memory and work are bounded.
    const bounded = before.slice(-16384);
    if (bounded === this.personalBefore) return;
    this.personalBefore = bounded;
    this.personalWords.clear();
    this.personalContexts.clear();
    const sentences = bounded.split(/[.!?\n]+/).map(sentence => tokens(sentence));
    let remaining = 512;
    for (let sentenceIndex = sentences.length - 1; sentenceIndex >= 0 && remaining > 0; sentenceIndex--) {
      const sentence = sentences[sentenceIndex].slice(-remaining);
      remaining -= sentence.length;
      const history = ['<s>'];
      for (const word of sentence) {
        if (usable(word)) {
          if (word.length >= 4) this.personalWords.set(word, (this.personalWords.get(word) ?? 0) + 1);
          for (let order = 1; order <= Math.min(3, history.length); order++) {
            const key = history.slice(-order).join(' ');
            let counts = this.personalContexts.get(key);
            if (!counts) { counts = new Map(); this.personalContexts.set(key, counts); }
            counts.set(word, (counts.get(word) ?? 0) + 1);
          }
        }
        history.push(word);
      }
    }
  }

  predict(text: string): ProbabilisticPrediction {
    const { before, prefix } = splitComposition(text);
    const sentence = before.split(/[.!?\n]+/).at(-1) ?? '';
    const historyTokens = tokens(sentence).slice(-3);
    const history = ['<s>', ...historyTokens];
    const initial = historyTokens.length === 0;
    const index = initial ? this.opening : this.general;
    const base = index.lookup(prefix, ALPHABET);
    let baseWeight = 1;
    const increments = new Map<string, number>();
    let contextual = false;
    const mix = (pairs: Iterable<[string, number]>, total: number, discount: number, strength: number) => {
      if (total <= 0 || strength <= 0) return;
      const additions: Array<[string, number]> = [];
      let allocated = 0;
      for (const [word, count] of pairs) {
        if (!usable(word)) continue;
        const mass = strength * Math.max(0, count - discount) / total;
        if (mass <= 0) continue;
        allocated += mass;
        if (word.startsWith(prefix)) additions.push([word, mass]);
      }
      const backoff = clamp(1 - allocated, 0, 1);
      baseWeight *= backoff;
      for (const [word, mass] of increments) increments.set(word, mass * backoff);
      for (const [word, mass] of additions) increments.set(word, (increments.get(word) ?? 0) + mass);
    };
    if (!initial) {
      for (let order = 1; order <= Math.min(this.contextOrder, history.length); order++) {
        const context = this.contexts.get(history.slice(-order).join(' '));
        if (!context) continue;
        contextual = true;
        mix(context[3], context[1], this.discount, this.contextStrength);
      }
    }
    if (this.personalization) {
      this.updatePersonal(before);
      const wordTotal = [...this.personalWords.values()].reduce((a, b) => a + b, 0);
      // A Dirichlet posterior: counts plus a fixed prior concentration.
      mix(this.personalWords, wordTotal + 512, 0, 1);
      for (let order = 1; order <= Math.min(3, history.length); order++) {
        const counts = this.personalContexts.get(history.slice(-order).join(' '));
        if (!counts) continue;
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        mix(counts, total + 12, 0, 1);
      }
    }
    const letterMass = new Map(base.letters.map(([letter, mass]) => [letter, mass * baseWeight]));
    let prefixMass = base.mass * baseWeight;
    let endingMass = index.wordProbability(prefix) * baseWeight;
    for (const [word, mass] of increments) {
      prefixMass += mass;
      const next = word[prefix.length];
      if (next) letterMass.set(next, (letterMass.get(next) ?? 0) + mass);
      else endingMass += mass;
    }
    const continuationMass = [...letterMass.values()].reduce((a, b) => a + b, 0);
    const fallback = this.general.lookup('', ALPHABET);
    const fallbackTotal = fallback.letters.reduce((sum, [, mass]) => sum + mass, 0) || 1;
    const fallbackMap = new Map(fallback.letters);
    // Every letter stays reachable, including out-of-vocabulary names. The tiny
    // floor is explicit, then temperature and normalization use the same support.
    const floor = 0.001;
    const letters = ALPHABET.map(letter => {
      const prior = 0.99 * (fallbackMap.get(letter) ?? 0) / fallbackTotal + 0.01 / ALPHABET.length;
      const raw = continuationMass > 0 ? (1 - floor) * (letterMass.get(letter) ?? 0) / continuationMass + floor * prior : prior;
      return { letter, score: raw ** (1 / this.temperature) };
    });
    const letterTotal = letters.reduce((sum, candidate) => sum + candidate.score, 0);
    for (const candidate of letters) candidate.score /= letterTotal;
    letters.sort((a, b) => b.score - a.score || (a.letter < b.letter ? -1 : 1));
    const candidates = new Map<string, number>();
    for (const position of base.top) {
      const word = index.words[position];
      candidates.set(word, baseWeight * index.probabilities[position] + (increments.get(word) ?? 0));
    }
    for (const [word, mass] of increments) candidates.set(word, mass + baseWeight * index.wordProbability(word));
    const words: WordCandidate[] = [...candidates].filter(([, score]) => score > 0).map(([word, score]) => ({ word, score: prefixMass > 0 ? score / prefixMass : 0 }))
      .sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1)).slice(0, 5);
    return {
      letters, words, source: initial ? 'opening' : contextual ? 'context' : 'lexicon', busy: false,
      entropy: -letters.reduce((sum, candidate) => sum + candidate.score * Math.log2(candidate.score), 0),
      endProbability: prefixMass > 0 ? clamp(endingMass / prefixMass, 0, 1) : 0,
      probabilityModel: true,
    };
  }
}
