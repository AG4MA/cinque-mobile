#!/usr/bin/env python3
"""Reproducible normalized model counts, using only Python's standard library.

The original source snapshot and tokenizer are shared with build_context.py.
Fold 0 is untouched TEST; fold 1 is DEV; folds 2..19 alone form this model.
Full context totals include discarded candidates, so their mass can back off.
"""
from __future__ import annotations

import argparse
import bz2
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

from build_context import EXPECTED_SHA256, SOURCE_URL, token_sequences

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets/probability"
CONTEXT_LIMIT = 150_000
NEXT_LIMIT = 24


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"Unexpected source SHA256: {digest}")
    counts = defaultdict(Counter)
    unigram = Counter()
    seen = set()
    contributors = set()
    stats = Counter()
    with bz2.open(source, "rt", encoding="utf-8") as rows:
        for line in rows:
            stats["sourceRows"] += 1
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 6 or fields[1] != "ita":
                continue
            contributors.add(fields[3] if fields[3] != "\\N" else "[unattributed in source]")
            for tokens in token_sequences(fields[2]):
                sequence_hash = hashlib.sha256(" ".join(tokens).encode("utf-8")).digest()
                if sequence_hash in seen:
                    stats["duplicateNormalizedSequences"] += 1
                    continue
                seen.add(sequence_hash)
                fold = int.from_bytes(sequence_hash[:8], "big") % 20
                if fold == 0:
                    stats["testSequences"] += 1
                    continue
                if fold == 1:
                    stats["developmentSequences"] += 1
                    continue
                stats["trainingSequences"] += 1
                stats["trainingTokens"] += len(tokens)
                unigram.update(tokens)
                previous = ["<s>"]
                for word in tokens:
                    for order in range(1, min(3, len(previous)) + 1):
                        counts[" ".join(previous[-order:])][word] += 1
                    previous.append(word)
            if stats["sourceRows"] % 200000 == 0:
                print(f"Read {stats['sourceRows']} rows, {len(counts)} contexts", flush=True)
    del seen
    continuation = Counter()
    eligible = []
    for context, counter in counts.items():
        if " " not in context:
            # Number of distinct immediately preceding tokens for every word.
            continuation.update(counter.keys())
        ranked = sorted(counter.items(), key=lambda row: (-row[1], row[0]))
        retained = ranked if context == "<s>" else [row for row in ranked if row[1] >= 2][:NEXT_LIMIT]
        if retained:
            eligible.append((context, sum(counter.values()), len(counter), retained))
    raw_count = len(counts)
    del counts
    eligible.sort(key=lambda row: (" " in row[0], -row[1], row[0]))
    selected = sorted(eligible[:CONTEXT_LIMIT], key=lambda row: row[0])
    metadata = {
        "id": "cinque-it-probability-v1", "language": "it", "contextOrder": 3,
        "source": "Tatoeba Italian detailed sentence export", "sourceUrl": SOURCE_URL,
        "sourceSnapshotDate": "2026-10-10", "sourceSha256": digest,
        "sourceBytes": source.stat().st_size,
        "license": "CC-BY-2.0-FR", "licenseUrl": "https://creativecommons.org/licenses/by/2.0/fr/",
        "attribution": "Tatoeba and its sentence contributors. Adapted into aggregate counts for CINQUE.",
        "contributors": sorted(contributors),
        "format": "contexts:[previousTokens,fullCount,distinctNextWords,[[word,count],...]]; unigram:[word,count]; continuation:[word,distinctPredecessors]",
        "split": "Deduplicate normalized token sequences; SHA256 first8 bytes big-endian modulo20: 0 TEST, 1 DEV, 2..19 TRAIN. Neither TEST nor DEV contributes any model count.",
        "normalization": "Same token_sequences as scripts/build_context.py; NFC lowercase; Italian letters; split apostrophes into tokens; sentence boundaries .!? and newline; 2..80 tokens, max48 letters per token.",
        "model": "Hierarchical interpolated absolute discounting with continuation prior mixed with external wordfreq. This is not full modified Kneser Ney: higher orders use raw counts, a single discount is used, and discarded count mass backs off.",
        "changes": "Retain full totals and distinct counts before pruning. Keep complete sentence-initial distribution. Other contexts retain up to24 pairs with count>=2. Prefer one-token contexts then highest-support contexts, capped at150000.",
        "contextCount": len(selected), "rawContextCount": raw_count,
        "transitionCount": sum(len(row[3]) for row in selected),
        "statistics": dict(stats),
        "limitations": ["Translated example sentences, not representative private chats.", "Near-duplicate paraphrases may cross splits.", "wordfreq is external pretraining and may overlap the evaluation corpus.", "At most three preceding tokens, without whole-sentence semantic understanding."],
    }
    data = {"metadata": metadata, "contexts": selected, "unigram": sorted(unigram.items()), "continuation": sorted(continuation.items())}
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert len(encoded) < 20_000_000, f"Model too big: {len(encoded)}"
    assert all(total >= sum(count for _, count in pairs) and distinct >= len(pairs) for _, total, distinct, pairs in selected)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "it-model.json").write_bytes(encoded)
    validation = {"bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(), "contexts": len(selected), "transitions": metadata["transitionCount"], **dict(stats)}
    (OUT / "validation.json").write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(validation, indent=2), flush=True)


if __name__ == "__main__":
    main()
