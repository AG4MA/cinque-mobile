#!/usr/bin/env python3
"""Build complete sentence-opening counts from the original offline corpus.

Uses exactly build_context.py's tokenizer, deduplication and train/holdout split.
Only the first word of each sequence is counted; no full n-gram rebuild is needed.
"""
from __future__ import annotations

import argparse
import bz2
from collections import Counter
import hashlib
import json
from pathlib import Path

from build_context import EXPECTED_SHA256, HOLDOUT_MODULUS, ROOT, SOURCE_URL, token_sequences


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--holdout-output", type=Path, default=ROOT / "work" / "opening-holdout.json")
    args = parser.parse_args()
    source = args.source.resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != EXPECTED_SHA256:
        raise SystemExit(f"Source snapshot hash differs: {source_hash}")
    seen: set[bytes] = set()
    training: Counter[str] = Counter()
    holdout: Counter[str] = Counter()
    with bz2.open(source, "rt", encoding="utf-8") as stream:
        for line in stream:
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 6 or fields[1] != "ita":
                continue
            for tokens in token_sequences(fields[2]):
                digest = hashlib.sha256(" ".join(tokens).encode("utf-8")).digest()
                if digest in seen:
                    continue
                seen.add(digest)
                counter = holdout if int.from_bytes(digest[:8], "big") % HOLDOUT_MODULUS == 0 else training
                counter[tokens[0]] += 1
    entries = sorted(training.items())
    metadata = {
        "id": "cinque-it-openings-tatoeba-2026-10-10",
        "language": "it", "source": "Tatoeba Italian detailed sentence export",
        "sourceUrl": SOURCE_URL, "sourceSha256": source_hash,
        "sourceSnapshotDate": "2026-10-10",
        "license": "CC-BY-2.0-FR", "licenseUrl": "https://creativecommons.org/licenses/by/2.0/fr/",
        "attribution": "Tatoeba and its sentence contributors. Contributor names and links are included in assets/context/CONTRIBUTORS.txt and it-context.json metadata.",
        "format": "entries: [openingWord, observedTrainingCount][]; all observed opening words, sorted by Unicode code point",
        "entryCount": len(entries), "trainingSequences": sum(training.values()),
        "holdoutSequences": sum(holdout.values()),
        "changes": "First words only; identical normalized token-sequence deduplication and SHA-256 modulo20 holdout as build_context.py. No top8 truncation. Counts are observed, unmodified counts; ranking adjustments are implemented separately in opening-policy.ts.",
        "limitations": [
            "Sentence openings in translated examples are not representative of private chat openings.",
            "Recurring names and near-duplicate paraphrases can occur across the exact-deduplicated split.",
            "The ranking uses heuristic smoothing and a wordfreq prior; its weights are not calibrated probabilities.",
        ],
    }
    destination = ROOT / "assets" / "context" / "it-openings.json"
    encoded = json.dumps({"metadata": metadata, "entries": entries}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    destination.write_bytes(encoded)
    args.holdout_output.parent.mkdir(parents=True, exist_ok=True)
    args.holdout_output.write_text(json.dumps({"sourceSha256": source_hash, "holdoutSequences": sum(holdout.values()), "entries": sorted(holdout.items())}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(destination), "entries": len(entries), "bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(), "trainingSequences": sum(training.values()), "holdoutSequences": sum(holdout.values())}))


if __name__ == "__main__":
    main()
