import type { LetterCandidate } from './lexical-engine';

export type KeyboardGeometry = {
  capacity: number;
  width: number;
  columns: number;
  rows: number;
  keyHeight: number;
  gap: number;
  leftHand: boolean;
};
export type KeyboardCostOptions = {
  geometry?: Partial<KeyboardGeometry>;
  previous?: Array<LetterCandidate | null>;
};

// Engineering priors in milliseconds, not fitted human-performance results.
// Measure these in a controlled typing study before claiming a speed gain.
export const KEYBOARD_COST_PRIORS = Object.freeze({
  searchBaseMs: 70, searchBitMs: 65, scanChoiceMs: 5,
  fittsBaseMs: 55, fittsBitMs: 80, pageAdvanceMs: 240,
  correctionMs: 850, moveBaseMs: 45, moveDistanceMs: 0.06, moveVisualMs: 4, minimumLayoutGainMs: 18,
});

export function keyboardGeometry(cap: number, input: Partial<KeyboardGeometry> = {}): KeyboardGeometry {
  const capacity = Number.isFinite(cap) ? Math.max(4, Math.min(10, Math.floor(cap))) : 8;
  const columns = input.columns === undefined ? (capacity === 4 ? 2 : 4) : input.columns === 2 ? 2 : 4;
  const finite = (value: number | undefined, fallback: number, min: number, max: number) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback;
  return {
    capacity,
    width: finite(input.width, 320, 220, 620), columns,
    rows: Math.max(Math.ceil(capacity / columns), Math.floor(finite(input.rows, Math.ceil(capacity / columns), 1, 5))),
    keyHeight: finite(input.keyHeight, 64, 64, 100), gap: finite(input.gap, 9, 0, 24),
    leftHand: input.leftHand === true,
  };
}

function position(slot: number, geometry: KeyboardGeometry) {
  const width = (geometry.width - geometry.gap * (geometry.columns - 1)) / geometry.columns;
  return {
    x: (slot % geometry.columns) * (width + geometry.gap) + width / 2,
    y: Math.floor(slot / geometry.columns) * (geometry.keyHeight + geometry.gap) + geometry.keyHeight / 2,
    width,
  };
}

/** Shannon entropy of a finite, non-negative weight distribution, in bits. */
export function entropyBits(weights: number[]): number {
  const valid = weights.filter(weight => Number.isFinite(weight) && weight > 0);
  const total = valid.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return 0;
  return valid.reduce((sum, weight) => { const p = weight / total; return sum - p * Math.log2(p); }, 0);
}

/** Fitts-style reaching time from a fixed, mirrored thumb rest position. */
export function targetTimeMs(slot: number, geometry: KeyboardGeometry): number {
  const target = position(slot, geometry);
  const restX = geometry.leftHand ? geometry.width * 0.12 : geometry.width * 0.88;
  const restY = geometry.rows * (geometry.keyHeight + geometry.gap) + 20;
  const distance = Math.hypot(target.x - restX, target.y - restY);
  return KEYBOARD_COST_PRIORS.fittsBaseMs + KEYBOARD_COST_PRIORS.fittsBitMs
    * Math.log2(1 + distance / Math.min(target.width, geometry.keyHeight));
}

function correctionTimeMs(slot: number, geometry: KeyboardGeometry): number {
  const target = position(slot, geometry);
  const errorRate = Math.min(0.08, 0.008 * (64 / Math.min(target.width, geometry.keyHeight)) ** 2);
  return errorRate * KEYBOARD_COST_PRIORS.correctionMs;
}

function searchTimeMs(page: LetterCandidate[], remainingMass: number, seen: Set<string>): number {
  const weights = page.map(candidate => seen.has(candidate.letter) ? 0 : candidate.score);
  const pageMass = weights.reduce((sum, weight) => sum + weight, 0);
  if (remainingMass > pageMass) weights.push(remainingMass - pageMass);
  // Entropy plus a uniform Hick component also models visual search when a
  // layout changes, even if the language distribution is concentrated.
  const bits = 0.5 * Math.log2(page.length + 1) + 0.5 * entropyBits(weights);
  return KEYBOARD_COST_PRIORS.searchBaseMs + KEYBOARD_COST_PRIORS.searchBitMs * bits
    + KEYBOARD_COST_PRIORS.scanChoiceMs * page.length;
}

/** Exactly the page boundaries used by Altre, including a minimum-four tail. */
export function rankedLetterPages(ranked: LetterCandidate[], count: number): LetterCandidate[][] {
  count = Number.isFinite(count) ? Math.max(4, Math.min(10, Math.floor(count))) : 8;
  const pages = [ranked.slice(0, count)];
  for (let offset = count; offset < ranked.length; offset += count) {
    const start = Math.min(offset, ranked.length - 4);
    pages.push(ranked.slice(start, offset + count));
  }
  return pages;
}

function assignmentCosts(selected: LetterCandidate[], size: number,
  previous: Array<LetterCandidate | null>, geometry: KeyboardGeometry) {
  const total = selected.reduce((sum, item) => sum + Math.max(0, item.score), 0);
  return selected.map(candidate => {
    const weight = total > 0 ? Math.max(0, candidate.score) / total : 1 / selected.length;
    const oldSlot = previous.findIndex(item => item?.letter === candidate.letter);
    return Array.from({ length: size }, (_, slot) => {
      let movement = 0;
      if (oldSlot >= 0 && oldSlot !== slot) {
        const old = position(oldSlot, geometry), next = position(slot, geometry);
        movement = KEYBOARD_COST_PRIORS.moveBaseMs
          + KEYBOARD_COST_PRIORS.moveDistanceMs * Math.hypot(old.x - next.x, old.y - next.y);
      }
      // Every changed label also disturbs visual landmarks, even if that label
      // itself has a tiny probability. This discourages gratuitous rare-key moves.
      return weight * (targetTimeMs(slot, geometry) + correctionTimeMs(slot, geometry) + movement)
        + (oldSlot >= 0 && oldSlot !== slot ? KEYBOARD_COST_PRIORS.moveVisualMs : 0);
    });
  });
}

/** Exact assignment, at most 10 * 2^10 states, with a cost for relearning slots. */
export function optimizeLetterSlots(previous: Array<LetterCandidate | null>, selected: LetterCandidate[],
  capacity: number, geometry: KeyboardGeometry): Array<LetterCandidate | null> {
  const size = Math.max(0, Math.min(10, Number.isFinite(capacity) ? Math.floor(capacity) : 0));
  const choices = selected.slice(0, size);
  if (!choices.length) return Array(size).fill(null);
  if (!choices.some(item => previous.some(old => old?.letter === item.letter))) {
    // With no familiar letters, rearrangement gives the exact optimum without
    // allocating a DP table: highest weight gets the lowest reaching cost.
    const order = Array.from({ length: size }, (_, slot) => slot).sort((a, b) =>
      targetTimeMs(a, geometry) + correctionTimeMs(a, geometry)
      - targetTimeMs(b, geometry) - correctionTimeMs(b, geometry));
    const initial: Array<LetterCandidate | null> = Array(size).fill(null);
    choices.slice().sort((a, b) => b.score - a.score).forEach((item, index) => { initial[order[index]] = item; });
    return initial;
  }
  const costs = assignmentCosts(choices, size, previous, geometry);
  const slots: Array<LetterCandidate | null> = Array(size).fill(null);
  const used = new Set<string>();
  for (let slot = 0; slot < size; slot++) {
    const existing = choices.find(item => item.letter === previous[slot]?.letter);
    if (existing && !used.has(existing.letter)) { slots[slot] = existing; used.add(existing.letter); }
  }
  // Baseline retains surviving slots and fills vacancies by reach cost.
  choices.forEach((candidate, index) => {
    if (used.has(candidate.letter)) return;
    let best = -1;
    for (let slot = 0; slot < size; slot++) {
      if (slots[slot] === null && (best < 0 || costs[index][slot] < costs[index][best])) best = slot;
    }
    slots[best] = candidate;
    used.add(candidate.letter);
  });
  const costOf = (layout: Array<LetterCandidate | null>) => layout.reduce((sum, item, slot) =>
    item ? sum + costs[choices.findIndex(choice => choice.letter === item.letter)][slot] : sum, 0);
  const states = 1 << size;
  const cost = Array(states).fill(Infinity), predecessor = Array(states).fill(-1);
  const assignedSlot = Array(states).fill(-1), popcount = Array(states).fill(0);
  cost[0] = 0;
  for (let mask = 1; mask < states; mask++) popcount[mask] = popcount[mask >> 1] + (mask & 1);
  for (let mask = 0; mask < states; mask++) {
    const item = popcount[mask];
    if (item >= choices.length || !Number.isFinite(cost[mask])) continue;
    for (let slot = 0; slot < size; slot++) {
      if (mask & (1 << slot)) continue;
      const next = mask | (1 << slot), candidateCost = cost[mask] + costs[item][slot];
      if (candidateCost < cost[next]) {
        cost[next] = candidateCost; predecessor[next] = mask; assignedSlot[next] = slot;
      }
    }
  }
  let bestMask = 0;
  for (let mask = 1; mask < states; mask++) {
    if (popcount[mask] === choices.length && (bestMask === 0 || cost[mask] < cost[bestMask])) bestMask = mask;
  }
  if (costOf(slots) - cost[bestMask] < KEYBOARD_COST_PRIORS.minimumLayoutGainMs) return slots;
  const optimal: Array<LetterCandidate | null> = Array(size).fill(null);
  for (let index = choices.length - 1; index >= 0; index--) {
    optimal[assignedSlot[bestMask]] = choices[index]; bestMask = predecessor[bestMask];
  }
  return optimal;
}

/** Expected milliseconds and page taps under current language weights. */
export function estimateKeyboardCost(ranked: LetterCandidate[], count: number, geometry: KeyboardGeometry,
  previous: Array<LetterCandidate | null> = []) {
  count = Number.isFinite(count) ? Math.max(4, Math.min(geometry.capacity, Math.floor(count))) : geometry.capacity;
  const pages = rankedLetterPages(ranked, count), seen = new Set<string>();
  let remainingMass = 1, cumulativeSearch = 0, expectedTimeMs = 0, estimatedPageTaps = 0;
  pages.forEach((page, pageIndex) => {
    cumulativeSearch += searchTimeMs(page, remainingMass, seen);
    if (pageIndex > 0) cumulativeSearch += KEYBOARD_COST_PRIORS.pageAdvanceMs;
    const old = pageIndex === 0 ? previous : [];
    const layout = optimizeLetterSlots(old, page, geometry.capacity, geometry);
    const costs = assignmentCosts(page, geometry.capacity, old, geometry);
    const pageTotal = page.reduce((sum, item) => sum + item.score, 0);
    page.forEach((candidate, index) => {
      if (seen.has(candidate.letter)) return;
      seen.add(candidate.letter);
      const slot = layout.findIndex(item => item?.letter === candidate.letter);
      const motor = candidate.score > 0 ? costs[index][slot] * pageTotal / candidate.score : 0;
      expectedTimeMs += candidate.score * (cumulativeSearch + motor);
      estimatedPageTaps += candidate.score * pageIndex;
      remainingMass = Math.max(0, remainingMass - candidate.score);
    });
  });
  return { expectedTimeMs, estimatedPageTaps };
}
