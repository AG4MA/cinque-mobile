/** Static weighted vocabulary: logarithmic prefix mass and exact top-k lookup.
 * A sum prefix array and a range-maximum tree avoid scanning the dictionary
 * whenever the user touches a key. Shared word arrays stay immutable.
 */
export class ProbabilityIndex {
  readonly probabilities: Float64Array;
  private readonly sums: Float64Array;
  private readonly maxima: Int32Array;
  private readonly leafCount: number;
  private readonly prefixCache = new Map<string, { mass: number; letters: Array<[string, number]>; top: number[] }>();

  constructor(readonly words: string[], weights: Float64Array) {
    let total = 0;
    for (const value of weights) total += value;
    this.probabilities = new Float64Array(weights.length);
    this.sums = new Float64Array(weights.length + 1);
    for (let i = 0; i < weights.length; i++) {
      this.probabilities[i] = total > 0 ? weights[i] / total : 0;
      this.sums[i + 1] = this.sums[i] + this.probabilities[i];
    }
    let leaves = 1;
    while (leaves < words.length) leaves *= 2;
    this.leafCount = leaves;
    this.maxima = new Int32Array(leaves * 2);
    this.maxima.fill(-1);
    for (let i = 0; i < words.length; i++) this.maxima[leaves + i] = i;
    for (let i = leaves - 1; i > 0; i--) this.maxima[i] = this.better(this.maxima[i * 2], this.maxima[i * 2 + 1]);
  }

  lowerBound(term: string) {
    let low = 0, high = this.words.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.words[middle] < term) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  wordProbability(word: string) {
    const index = this.lowerBound(word);
    return this.words[index] === word ? this.probabilities[index] : 0;
  }

  private better(a: number, b: number) {
    if (a < 0) return b;
    if (b < 0) return a;
    if (this.probabilities[a] === this.probabilities[b]) return Math.min(a, b);
    return this.probabilities[a] > this.probabilities[b] ? a : b;
  }

  private maximum(start: number, end: number) {
    let left = start + this.leafCount, right = end + this.leafCount, best = -1;
    while (left < right) {
      if (left % 2) best = this.better(best, this.maxima[left++]);
      if (right % 2) best = this.better(best, this.maxima[--right]);
      left >>>= 1;
      right >>>= 1;
    }
    return best;
  }

  private top(start: number, end: number, count: number) {
    const ranges: Array<{ start: number; end: number; best: number }> = [];
    const push = (left: number, right: number) => {
      if (left >= right) return;
      const best = this.maximum(left, right);
      if (best >= 0 && this.probabilities[best] > 0) ranges.push({ start: left, end: right, best });
    };
    const result: number[] = [];
    push(start, end);
    while (result.length < count && ranges.length) {
      let bestRange = 0;
      for (let i = 1; i < ranges.length; i++) {
        if (this.better(ranges[i].best, ranges[bestRange].best) === ranges[i].best) bestRange = i;
      }
      const current = ranges.splice(bestRange, 1)[0];
      result.push(current.best);
      push(current.start, current.best);
      push(current.best + 1, current.end);
    }
    return result;
  }

  lookup(prefix: string, alphabet: readonly string[]) {
    const cached = this.prefixCache.get(prefix);
    if (cached) return cached;
    const start = this.lowerBound(prefix);
    const end = prefix ? this.lowerBound(prefix + '\uffff') : this.words.length;
    const letters: Array<[string, number]> = [];
    for (const letter of alphabet) {
      const next = prefix + letter;
      const from = this.lowerBound(next);
      const to = this.lowerBound(next + '\uffff');
      const mass = Math.max(0, this.sums[to] - this.sums[from]);
      if (mass > 0) letters.push([letter, mass]);
    }
    const result = { mass: Math.max(0, this.sums[end] - this.sums[start]), letters, top: this.top(start, end, 5) };
    this.prefixCache.set(prefix, result);
    if (this.prefixCache.size > 512) this.prefixCache.delete(this.prefixCache.keys().next().value!);
    return result;
  }
}
