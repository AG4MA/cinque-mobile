#!/usr/bin/env python3
"""Build the offline Italian frequency lexicon, with inseparable attribution.

Install the build-only dependency: python -m pip install wordfreq==3.1.1
Run from any directory: python scripts/build_lexicon.py
No Python dependency or network connection is required by the mobile app.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import unicodedata

import wordfreq
from wordfreq import get_frequency_dict


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "assets" / "lexicon"
WORD = re.compile(r"[a-zàèéìòóù]+(?:'[a-zàèéìòóù]+)*'?")
VERSION = "3.1.1"
EXPECTED_SOURCE_SHA256 = "0b5500e425a50e0f1fefb256d9125e74f586ac6b2f2a6e41bc96634bd5613cc7"


def main() -> None:
    installed_version = importlib.metadata.version("wordfreq")
    if installed_version != VERSION:
        raise RuntimeError(f"Expected wordfreq {VERSION}, found {installed_version}")

    source = Path(wordfreq.__file__).parent / "data" / "large_it.msgpack.gz"
    source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_sha256 != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("wordfreq Italian data does not match the verified source")
    frequencies = get_frequency_dict("it", wordlist="large")
    cleaned: dict[str, int] = {}
    for token, frequency in frequencies.items():
        token = unicodedata.normalize("NFC", token).lower().replace("’", "'")
        if not WORD.fullmatch(token):
            continue
        # Zipf is log10(occurrences per billion tokens), already binned to 0.01
        # by wordfreq. Integers preserve the original precision without floats.
        score = round((math.log10(frequency) + 9) * 100)
        cleaned[token] = max(cleaned.get(token, 0), score)
    # Only BMP characters are admitted, so this is the same order as JS < / >.
    entries = sorted(cleaned.items())
    notice = (DESTINATION / "licenses" / "wordfreq-NOTICE.md").read_text(encoding="utf-8")
    metadata = {
        "id": "cinque-it-wordfreq-3.1.1",
        "language": "it",
        "source": "wordfreq Italian large wordlist",
        "sourceVersion": VERSION,
        "sourceUrl": "https://github.com/rspeer/wordfreq",
        "sourceDataSha256": source_sha256,
        "creator": "Robyn Speer",
        "copyright": "Copyright 2022 Robyn Speer",
        "license": "CC-BY-SA-4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "citation": "Robyn Speer (2022), rspeer/wordfreq: v3.0, https://doi.org/10.5281/zenodo.7199437",
        "notice": notice,
        "adaptationLicense": "CC-BY-SA-4.0",
        "changes": "Selected Italian large data; NFC lowercase normalization; typographic apostrophes normalized; excluded numeric and non-linguistic tokens; retained Italian-alphabet Latin words and apostrophes; encoded Zipf frequencies as integer hundredths; sorted by Unicode code point. No invented frequencies and no top-N cutoff.",
        "format": "entries: [word, zipf100][]; lexicographic Unicode order, equivalent to JavaScript string < and > for the admitted characters",
        "score": "zipf100 = round(100 * log10(frequency * 1e9)); frequency = 10 ** (zipf100 / 100 - 9)",
        "rawTokenCount": len(frequencies),
        "entryCount": len(entries),
        "minimumScore": min(score for _, score in entries),
        "maximumScore": max(score for _, score in entries),
        "limitations": [
            "A large corpus-derived vocabulary, not a normative or exhaustive dictionary. Includes proper names, loanwords, abbreviations, misspellings and some foreign words found in Italian corpora.",
            "The source is a snapshot of language usage through about 2021, not live usage data.",
            "Single-word frequencies are priors, not conditional next-word probabilities or proof of prediction accuracy.",
            "wordfreq splits many Italian elisions at the apostrophe: l'acqua becomes l and acqua. The keyboard must handle apostrophes separately.",
        ],
        "warranty": "Provided AS IS, without warranties; see the included CC BY-SA 4.0 license.",
    }
    asset = {"metadata": metadata, "entries": entries}
    encoded = json.dumps(asset, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    DESTINATION.mkdir(parents=True, exist_ok=True)
    (DESTINATION / "it.json").write_bytes(encoded)

    # Meaningful data invariants: unique sorted keys, accent preservation,
    # supported score range, deterministic round trip and genuine source ranks.
    decoded = json.loads(encoded)
    words = [entry[0] for entry in decoded["entries"]]
    assert len(words) == len(set(words))
    assert words == sorted(words)
    assert all(WORD.fullmatch(word) for word in words)
    assert all(100 <= score <= 900 for _, score in entries)
    for required in ("ciao", "perché", "caffè", "città", "più", "è", "sarebbero", "mangiandolo", "programmazione", "tastiera"):
        assert required in cleaned, f"Missing expected Italian form: {required}"
    assert cleaned["di"] > cleaned["tastiera"] > cleaned["mangiandolo"]
    validation = {
        "entries": len(entries),
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "sourceDataSha256": source_sha256,
        "scoreRange": [metadata["minimumScore"], metadata["maximumScore"]],
        "checks": "unique/sorted words, allowed alphabet, score range, JSON round trip, Italian accents, conjugations, source frequency ordering",
    }
    (DESTINATION / "validation.json").write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(validation, indent=2))


if __name__ == "__main__":
    main()
