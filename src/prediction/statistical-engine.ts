import { LexicalEngine, splitComposition, type Prediction, type WordCandidate } from './lexical-engine';
import { OpeningPolicy, type OpeningDataset } from './opening-policy';

export type ContextDataset = {
  metadata: Record<string, unknown>;
  contexts: Array<[string, Array<[string, number]>]>;
};

export function tokenize(text: string): string[] {
  return text.normalize('NFC').toLocaleLowerCase('it').replace(/[‘’]/g, "'").match(/[a-zàèéìòù]+/g) ?? [];
}

/** Counts from public Italian sentences, interpolated from 1–3 previous words. */
export class StatisticalEngine {
  readonly contextOrder = 3;
  readonly contextCount: number;
  private contexts: Map<string, Array<[string, number]>>;
  private openings?: OpeningPolicy;

  constructor(readonly lexical: LexicalEngine, dataset: ContextDataset, openingDataset?: OpeningDataset) {
    // Index explicit pairs so a damaged dataset reports its row instead of an opaque
    // native Map iterator error before React can mount.
    if (!Array.isArray(dataset.contexts)) throw new Error('Context dataset is not an array');
    this.contexts = new Map();
    for (let i = 0; i < dataset.contexts.length; i++) {
      const row = dataset.contexts[i];
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Array.isArray(row[1])) {
        throw new Error(`Invalid context dataset row at index ${i}`);
      }
      this.contexts.set(row[0], row[1]);
    }
    this.contextCount = this.contexts.size;
    if (openingDataset) this.openings = new OpeningPolicy(lexical, openingDataset);
  }

  predict(text: string): Prediction {
    const { before, prefix } = splitComposition(text);
    const complete = tokenize(before);
    this.lexical.setPersonalWords(complete);
    const sentence = before.split(/[.!?\n]+/).at(-1) ?? '';
    const tokens = tokenize(sentence);
    if (tokens.length === 0 && this.openings) return this.openings.predict(text);
    const history = ['<s>', ...tokens];
    const scores = new Map<string, number>();
    for (let order = 1; order <= Math.min(this.contextOrder, history.length); order++) {
      const rows = this.contexts.get(history.slice(-order).join(' '));
      if (!rows) continue;
      const total = rows.reduce((sum, [, count]) => sum + count, 0);
      const reliability = total / (total + 6);
      const orderWeight = [0, 0.35, 1.1, 2.4][order];
      for (const [word, count] of rows) {
        if (word.startsWith(prefix)) scores.set(word, (scores.get(word) ?? 0) + count / total * reliability * orderWeight);
      }
    }
    // Repeated expressions in the current composition adapt immediately; corrections undo them.
    for (const completedSentence of before.split(/[.!?\n]+/)) {
      const sentenceWords = tokenize(completedSentence);
      for (let i = 1; i < sentenceWords.length; i++) {
        const candidate = sentenceWords[i];
        if (!candidate.startsWith(prefix)) continue;
        for (let order = 1; order <= Math.min(3, i, tokens.length); order++) {
          if (sentenceWords.slice(i - order, i).join(' ') === tokens.slice(-order).join(' ')) {
            scores.set(candidate, (scores.get(candidate) ?? 0) + order * 0.3);
          }
        }
      }
    }
    const candidates: WordCandidate[] = [...scores].map(([word, score]) => ({ word, score })).sort((a, b) => b.score - a.score);
    return this.lexical.predict(text, candidates);
  }
}
