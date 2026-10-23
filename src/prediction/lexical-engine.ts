export type Entry = [string, number];
export type WordCandidate = { word: string; score: number };
export type LetterCandidate = { letter: string; score: number };
export type Prediction = {
  letters: LetterCandidate[];
  words: WordCandidate[];
  source: 'lexicon' | 'context' | 'opening';
  busy: boolean;
};

const VALID_SINGLE = new Set(['a', 'e', 'è', 'i', 'o']);
const LETTER = /^[a-zàèéìòù]$/u;
const WORD = /^[a-zàèéìòù]+(?:'[a-zàèéìòù]+)*$/u;
const normalize = (s: string) => s.toLocaleLowerCase('it').normalize('NFC').replace(/’/g, "'");

export function splitComposition(text: string) {
  const prefix = text.match(/[a-zàèéìòù]+$/iu)?.[0] ?? '';
  return { prefix: normalize(prefix), before: text.slice(0, text.length - prefix.length) };
}

export function replaceCurrentWord(text: string, word: string): string {
  const prefix = text.match(/[a-zàèéìòù]+$/iu)?.[0] ?? '';
  const before = text.slice(0, text.length - prefix.length);
  const formatted = prefix.length > 0 && prefix === prefix.toLocaleUpperCase('it')
    ? (prefix.length > 1 ? word.toLocaleUpperCase('it') : word[0].toLocaleUpperCase('it') + word.slice(1))
    : prefix[0] && prefix[0] === prefix[0].toLocaleUpperCase('it')
      ? word[0].toLocaleUpperCase('it') + word.slice(1)
      : word;
  return before + formatted + ' ';
}

function usable(word: string) {
  return WORD.test(word) && (word.length > 1 || VALID_SINGLE.has(word));
}

function topInsert(top: WordCandidate[], item: WordCandidate, max = 40) {
  if (top.length === max && item.score <= top[top.length - 1].score) return;
  let at = top.findIndex(other => item.score > other.score);
  if (at < 0) at = top.length;
  top.splice(at, 0, item);
  if (top.length > max) top.pop();
}

/** Corpus frequency retrieval. Scores are ranking weights, not calibrated probabilities. */
export class LexicalEngine {
  readonly count: number;
  private cache = new Map<string, Prediction>();
  private personal = new Map<string, number>();

  constructor(private entries: Entry[]) {
    this.count = entries.length;
  }

  private lowerBound(term: string) {
    let low = 0, high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.entries[mid][0] < term) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  frequency(word: string): number {
    const key = normalize(word);
    const i = this.lowerBound(key);
    return this.entries[i]?.[0] === key ? this.entries[i][1] / 100 : 0;
  }

  /** Session-only learning; no typed text is persisted or transmitted. */
  learn(text: string) {
    const completed = text.match(/[a-zàèéìòù]+(?=[\s.,!?;:])/giu) ?? [];
    for (const raw of completed.slice(-1)) {
      const word = normalize(raw);
      if (usable(word)) this.personal.set(word, Math.min((this.personal.get(word) ?? 0) + 1, 8));
    }
    if (this.personal.size > 256) this.personal.delete(this.personal.keys().next().value!);
  }

  setPersonalWords(words: string[]) {
    this.personal.clear();
    for (const raw of words.slice(-512)) {
      const word = normalize(raw);
      if (word.length >= 4 && usable(word)) this.personal.set(word, Math.min((this.personal.get(word) ?? 0) + 1, 8));
    }
  }

  private lexical(prefix: string): Prediction {
    const cached = this.cache.get(prefix);
    if (cached) return cached;
    const start = this.lowerBound(prefix);
    const end = prefix ? this.lowerBound(prefix + '\uffff') : this.entries.length;
    const letters = new Map<string, number>();
    const words: WordCandidate[] = [];
    for (let i = start; i < end; i++) {
      const [word, zipf100] = this.entries[i];
      if (!usable(word)) continue;
      const score = 10 ** (zipf100 / 100 - 7);
      const next = word[prefix.length];
      if (next && (LETTER.test(next) || next === "'")) letters.set(next, (letters.get(next) ?? 0) + score);
      topInsert(words, { word, score });
    }
    const sum = [...letters.values()].reduce((a, b) => a + b, 0) || 1;
    const result: Prediction = {
      letters: [...letters].map(([letter, score]) => ({ letter, score: score / sum })).sort((a, b) => b.score - a.score),
      words, source: 'lexicon', busy: false,
    };
    this.cache.set(prefix, result);
    if (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  predict(text: string, contextualWords: WordCandidate[] = []): Prediction {
    const { prefix } = splitComposition(text);
    const base = this.lexical(prefix);
    const wordWeights = new Map<string, number>();
    const personalLetters = new Map<string, number>();
    const lexicalTotal = base.words.reduce((sum, w) => sum + w.score, 0) || 1;
    base.words.forEach(w => wordWeights.set(w.word, w.score / lexicalTotal));
    for (const [word, count] of this.personal) {
      if (word.startsWith(prefix)) {
        const boost = 0.025 * Math.log1p(count);
        wordWeights.set(word, (wordWeights.get(word) ?? 0) + boost);
        const next = word[prefix.length];
        if (next) personalLetters.set(next, (personalLetters.get(next) ?? 0) + boost);
      }
    }
    const seen = new Set<string>();
    const context = contextualWords.map(w => ({ word: normalize(w.word), score: w.score }))
      .filter(w => {
        if (seen.has(w.word) || !usable(w.word) || !w.word.startsWith(prefix) || !Number.isFinite(w.score) || w.score <= 0) return false;
        seen.add(w.word);
        return this.frequency(w.word) > 0 || this.personal.has(w.word);
      }).slice(0, 40);
    const contextualLetters = new Map<string, number>();
    const rankTotal = context.reduce((sum, w) => sum + w.score, 0) || 1;
    context.forEach(({ word, score }) => {
      const rankWeight = score / rankTotal;
      // Interpolated corpus weights rank suggestions; they are not measured user accuracy.
      wordWeights.set(word, (wordWeights.get(word) ?? 0) * 0.25 + rankWeight * 3);
      const next = word[prefix.length];
      if (next) contextualLetters.set(next, (contextualLetters.get(next) ?? 0) + rankWeight);
    });
    const allLetters = new Map(base.letters.map(l => [l.letter, l.score * (context.length ? 0.25 : 1)]));
    for (const [letter, score] of personalLetters) allLetters.set(letter, (allLetters.get(letter) ?? 0) + score);
    for (const [letter, score] of contextualLetters) allLetters.set(letter, (allLetters.get(letter) ?? 0) + score * 0.75);
    if (allLetters.size < 4) {
      this.lexical('').letters.forEach(l => { if (!allLetters.has(l.letter)) allLetters.set(l.letter, l.score * 0.001); });
    }
    return {
      letters: [...allLetters].map(([letter, score]) => ({ letter, score })).sort((a, b) => b.score - a.score),
      words: [...wordWeights].map(([word, score]) => ({ word, score })).sort((a, b) => b.score - a.score).slice(0, 5),
      source: context.length ? 'context' : 'lexicon', busy: false,
    };
  }
}
