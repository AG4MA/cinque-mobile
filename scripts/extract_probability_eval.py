#!/usr/bin/env python3
"""Deterministic, exact-deduplicated DEV/TEST positions from the public corpus."""
from __future__ import annotations

import argparse
import bz2
import hashlib
import heapq
import json
from pathlib import Path

from build_context import EXPECTED_SHA256, SOURCE_URL, token_sequences

ROOT = Path(__file__).resolve().parents[1]


def encode(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--dev-per-stratum", type=int, default=400)
    parser.add_argument("--test-per-stratum", type=int, default=800)
    args = parser.parse_args()
    source = args.source.resolve()
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_sha != EXPECTED_SHA256:
        raise SystemExit(f"Unrecognized source snapshot: {source_sha}")
    sizes = {"dev": args.dev_per_stratum, "test": args.test_per_stratum}
    heaps = {split: {f"{location}:{prefix}": [] for location in ("initial", "body") for prefix in (0, 1, 2)} for split in sizes}
    eligible = {split: dict.fromkeys(heaps[split], 0) for split in sizes}
    sequences = {"train": 0, "dev": 0, "test": 0}
    seen: set[bytes] = set()
    with bz2.open(source, "rt", encoding="utf-8") as rows:
        for line in rows:
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 6 or fields[1] != "ita":
                continue
            for tokens in token_sequences(fields[2]):
                joined = " ".join(tokens)
                digest = hashlib.sha256(joined.encode("utf-8")).digest()
                if digest in seen:
                    continue
                seen.add(digest)
                fold = int.from_bytes(digest[:8], "big") % 20
                split = "test" if fold == 0 else "dev" if fold == 1 else "train"
                sequences[split] += 1
                if split == "train":
                    continue
                for position, word in enumerate(tokens):
                    location = "initial" if position == 0 else "body"
                    for prefix_length in (0, 1, 2):
                        if len(word) <= prefix_length:
                            continue
                        key = f"{location}:{prefix_length}"
                        eligible[split][key] += 1
                        sample_id = hashlib.sha256(f"cinque-eval-v1|{digest.hex()}|{position}|{prefix_length}".encode()).hexdigest()
                        priority = int(sample_id, 16)
                        heap = heaps[split][key]
                        if len(heap) >= sizes[split] and priority >= -heap[0][0]:
                            continue
                        example = {
                            "id": sample_id, "sequenceSha256": digest.hex(), "sentenceId": fields[0],
                            "position": position, "location": location, "prefixLength": prefix_length,
                            "text": (" ".join(tokens[:position]) + " " if position else "") + word[:prefix_length],
                            "targetWord": word, "targetLetter": word[prefix_length],
                        }
                        item = (-priority, sample_id, example)
                        if len(heap) == sizes[split]:
                            heapq.heapreplace(heap, item)
                        else:
                            heapq.heappush(heap, item)
    output = ROOT / "assets" / "evaluation"
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"sourceSha256": source_sha, "sequences": sequences, "files": {}}
    for split in sizes:
        samples = [item[2] for key in sorted(heaps[split]) for item in sorted(heaps[split][key], key=lambda item: item[1])]
        payload = {
            "metadata": {
                "version": 1, "split": split, "sourceSha256": source_sha, "sourceUrl": SOURCE_URL,
                "sourceSnapshotDate": "2026-10-10", "license": "CC-BY-2.0-FR",
                "licenseUrl": "https://creativecommons.org/licenses/by/2.0/fr/",
                "attribution": "Tatoeba and sentence contributors. Each sample retains its public sentence ID; the complete contributor list is in assets/context/CONTRIBUTORS.txt.",
                "splitRule": "SHA256 of normalized space-joined token sequence, first 8 bytes big-endian modulo20: TEST0, DEV1, TRAIN2..19. Exact normalized sequences deduplicated before splitting.",
                "sampling": "Lowest SHA256(cinque-eval-v1|sequenceSha|wordPosition|prefixLength) per initial/body x prefix0/1/2 stratum. Every eligible word position participates. Words of length<=prefixLength excluded. Equal-size strata are macro-averaged, not corpus-prevalence weighted.",
                "samplesPerStratum": sizes[split], "eligiblePositions": eligible[split], "sequences": sequences,
            },
            "samples": samples,
        }
        data = encode(payload)
        (output / f"{split}-samples.json").write_bytes(data)
        manifest["files"][split] = {"samples": len(samples), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    (output / "sample-manifest.json").write_bytes(encode(manifest))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
