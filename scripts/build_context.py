#!/usr/bin/env python3
"""Build compact real Italian 2/3/4-gram counts; Python standard library only.

python scripts/build_context.py --source path/to/ita_sentences_detailed.tsv.bz2
The exact public source snapshot is SHA-256 checked before processing.
"""
from __future__ import annotations

import argparse
import bz2
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import statistics
import time
import unicodedata
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "context"
EXPECTED_SHA256 = "05853b510a67ad0615b993e29ae7cecb482af12524a52b9646dcfe76ea29afa3"
SOURCE_URL = "https://downloads.tatoeba.org/exports/per_language/ita/ita_sentences_detailed.tsv.bz2"
WORD = re.compile(r"[a-zàèéìòù]+")
SPLIT = re.compile(r"[.!?\n]+")
CONTEXT_LIMIT = 150_000
NEXT_LIMIT = 8
MIN_COUNT = 2
HOLDOUT_MODULUS = 20


def normalize(text: str) -> str:
    return unicodedata.normalize("NFC", text).lower().replace("‘", "'").replace("’", "'")


def token_sequences(text: str):
    for part in SPLIT.split(normalize(text)):
        tokens = WORD.findall(part)
        if 2 <= len(tokens) <= 80 and all(len(token) <= 48 for token in tokens):
            yield tuple(tokens)


def top_words(counter: Counter):
    return sorted(((word, count) for word, count in counter.items() if count >= MIN_COUNT), key=lambda item: (-item[1], item[0]))[:NEXT_LIMIT]


def evaluate(contexts: dict, heldout: list[tuple[str, ...]]) -> dict:
    lexicon = json.loads((ROOT / "assets/lexicon/it.json").read_text(encoding="utf-8"))["entries"]
    lexicon.sort(key=lambda row: (-row[1], row[0]))
    fallback: dict[str, list[str]] = defaultdict(list)
    for word, _ in lexicon:
        for prefix in ("", word[:2]):
            if len(fallback[prefix]) < 5:
                fallback[prefix].append(word)
    metrics = {"emptyPrefix": Counter(), "twoLetters": Counter()}
    latencies = []
    # Holdout is separate by normalized token-sequence hash, not sentence ID.
    for tokens in heldout:
        for position in range(1, len(tokens)):
            actual = tokens[position]
            previous = ["<s>", *tokens[:position]]
            for label, prefix in (("emptyPrefix", ""), ("twoLetters", actual[:2])):
                if label == "twoLetters" and len(actual) <= 2:
                    continue  # A two-letter prefix must not disclose the entire answer.
                started = time.perf_counter()
                baseline = fallback.get(prefix, [])
                suggestions = []
                used_context = False
                for size in range(min(3, len(previous)), 0, -1):
                    matches = contexts.get(" ".join(previous[-size:]), [])
                    for word, _ in matches:
                        if word.startswith(prefix) and word not in suggestions:
                            suggestions.append(word)
                            used_context = True
                    if len(suggestions) >= 5:
                        break
                suggestions = (suggestions + [word for word in baseline if word not in suggestions])[:5]
                latencies.append((time.perf_counter() - started) * 1e6)
                metric = metrics[label]
                metric["positions"] += 1
                metric["unigramTop5Hits"] += actual in baseline
                metric["contextTop5Hits"] += actual in suggestions
                metric["contextTop1Hits"] += bool(suggestions) and actual == suggestions[0]
                metric["positionsWithContextCandidate"] += used_context
    result = {
        "method": "All held-out unique normalized token sequences; all internal next-word positions (sentence initial positions excluded). Holdout iff first 8 SHA-256 bytes of normalized space-joined tokens modulo20 equal0. Exact duplicate normalized sequences are deduplicated and cannot cross splits.",
        "ranking": "Simple longest-context-first backoff (3,2,1 previous words), frequency-sorted candidates, fill top5 with wordfreq unigram. This evaluates the asset reference policy, not the final app's adaptive ranker.",
        "holdoutSentencesEvaluated": len(heldout),
        "limitations": "Same-corpus test, short translated example sentences with many near-duplicates and recurring names. Does not measure real chat accuracy, semantic understanding, smartphone latency or user speed. Two-letter case evaluates only target words of at least three letters, so the prefix never discloses the entire target.",
        "desktopPythonMedianLookupMicroseconds": round(statistics.median(latencies), 2),
    }
    for label, metric in metrics.items():
        result[label] = dict(metric)
        for key in ("unigramTop5Hits", "contextTop5Hits", "contextTop1Hits"):
            result[label][key.replace("Hits", "Rate")] = round(metric[key] / metric["positions"], 6)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != EXPECTED_SHA256:
        raise SystemExit(f"Source snapshot hash differs: {source_hash}. Preserve the original snapshot to reproduce, or deliberately review and update EXPECTED_SHA256 and snapshot metadata for a new corpus release.")
    counts: dict[str, Counter] = defaultdict(Counter)
    authors: Counter = Counter()
    seen = set()
    heldout = []
    statistics_count = Counter()
    with bz2.open(source, "rt", encoding="utf-8") as rows:
        for line in rows:
            fields = line.rstrip("\n").split("\t")
            statistics_count["sourceRows"] += 1
            if len(fields) != 6 or fields[1] != "ita":
                statistics_count["invalidRows"] += 1
                continue
            author = fields[3]
            # Keep all available attribution, including contributors to heldout data.
            authors[author if author != "\\N" else "[unattributed in source]"] += 1
            for tokens in token_sequences(fields[2]):
                joined = " ".join(tokens)
                digest = hashlib.sha256(joined.encode("utf-8")).digest()
                if digest in seen:
                    statistics_count["duplicateNormalizedSequences"] += 1
                    continue
                seen.add(digest)
                if int.from_bytes(digest[:8], "big") % HOLDOUT_MODULUS == 0:
                    heldout.append(tokens)
                    continue
                statistics_count["trainingSequences"] += 1
                statistics_count["trainingTokens"] += len(tokens)
                history = ["<s>"]
                for word in tokens:
                    for size in range(1, min(3, len(history)) + 1):
                        counts[" ".join(history[-size:])][word] += 1
                    history.append(word)
            if statistics_count["sourceRows"] % 200000 == 0:
                print(f"Processed {statistics_count['sourceRows']} source rows; {len(counts)} raw contexts", flush=True)
    del seen
    eligible = []
    for context, counter in counts.items():
        candidates = top_words(counter)
        if candidates:
            eligible.append((context, sum(counter.values()), candidates))
    raw_context_count = len(counts)
    del counts
    # Keep high-support contexts, deterministically breaking ties by string order.
    # Always retain eligible one-word contexts for broad backoff coverage.
    eligible.sort(key=lambda row: (" " in row[0], -row[1], row[0]))
    selected = eligible[:CONTEXT_LIMIT]
    selected.sort(key=lambda row: row[0])
    entries = [(context, candidates) for context, _, candidates in selected]
    contexts = dict(entries)
    metrics = evaluate(contexts, heldout)
    contributors = sorted(authors)
    metadata = {
        "id":"cinque-it-tatoeba-2026-10-10", "language":"it",
        "source":"Tatoeba Italian detailed sentence export", "sourceUrl":SOURCE_URL,
        "sourceInfoUrl":"https://tatoeba.org/en/downloads", "sourceSnapshotDate":"2026-10-10",
        "sourceSha256":source_hash, "sourceBytes":source.stat().st_size,
        "license":"CC-BY-2.0-FR", "licenseUrl":"https://creativecommons.org/licenses/by/2.0/fr/",
        "attribution":"Tatoeba and its sentence contributors. All contributor names available in the source are embedded below and linked in CONTRIBUTORS.txt. Data adapted into aggregate n-gram counts for CINQUE.",
        "contributors":contributors,
        "contributorProfileUrlTemplate":"https://tatoeba.org/en/user/profile/{username}",
        "sentenceUrlTemplate":"https://tatoeba.org/en/sentences/show/{sentenceId}",
        "format":"contexts: [space-joined previous tokens, [[nextWord, observedCount], ...]][]; contexts sorted using Unicode/JavaScript string ordering; candidates sorted by descending count then word",
        "contextOrder":3, "maxCandidatesPerContext":NEXT_LIMIT, "minimumPairCount":MIN_COUNT,
        "contextCount":len(entries), "transitionCount":sum(len(words) for _, words in entries),
        "rawContextCount":raw_context_count, "eligibleContextCount":len(eligible),
        "sentenceStartToken":"<s>",
        "normalization":"Unicode NFC, Italian-compatible lowercase, curly apostrophe to ASCII; tokens /[a-zàèéìòù]+/g; sentence boundaries /[.!?\\n]+/. Apostrophes split tokens (l'acqua -> l, acqua).",
        "changes":"Italian rows only; normalized 2–80-token sequences, max48 letters per token; deduplicated exact normalized token sequences; deterministic 5% holdout excluded from training; counted observed 2/3/4-grams; kept pairs with count>=2 and top8 per context; retained eligible one-token contexts then highest-support contexts up to150000. Counts are real and not invented.",
        "statistics":dict(statistics_count), "holdoutSequences":len(heldout),
        "limitations":["Curated/translated example sentences, not a representative corpus of private messages.","Many examples revolve around recurring proper names and repeated sentence patterns.","Backoff uses at most three preceding tokens; it does not understand the meaning of a whole sentence.","No heldout phrase is included in training after exact normalization, but near-duplicate paraphrases may still occur.","Truncated candidate lists are observed counts, not calibrated probabilities or a complete conditional distribution."],
        "warranty":"No accuracy warranty; see the Creative Commons source license.",
    }
    encoded=json.dumps({"metadata":metadata,"contexts":entries},ensure_ascii=False,separators=(",",":")).encode("utf-8")
    assert len(encoded) < 15_000_000, f"Asset too large: {len(encoded)}"
    assert len(contexts) == len(entries)
    assert [key for key,_ in entries] == sorted(contexts)
    assert all(1 <= len(key.split()) <= 3 for key in contexts)
    assert all(1 <= len(words) <= 8 and all(count >= 2 for _,count in words) for _,words in entries)
    assert contexts.get("<s>")
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/"it-context.json").write_bytes(encoded)
    (OUT/"evaluation.json").write_text(json.dumps(metrics,ensure_ascii=False,indent=2)+'\n',encoding="utf-8")
    contributor_text = "Tatoeba contributors credited by username from the 2026-10-10 Italian detailed export.\nCC BY 2.0 FR: https://creativecommons.org/licenses/by/2.0/fr/\nSource: " + SOURCE_URL + "\n\n"
    contributor_text += '\n'.join(name + ("\thttps://tatoeba.org/en/user/profile/" + quote(name) if not name.startswith('[') else '') for name in contributors) + '\n'
    (OUT/"CONTRIBUTORS.txt").write_text(contributor_text,encoding="utf-8")
    validation={"bytes":len(encoded),"sha256":hashlib.sha256(encoded).hexdigest(),"contextCount":len(entries),"transitionCount":metadata["transitionCount"],"sourceRows":statistics_count["sourceRows"],"trainingSequences":statistics_count["trainingSequences"],"trainingTokens":statistics_count["trainingTokens"],"holdoutSequences":len(heldout),"contributors":len(contributors),"checks":"source hash, deterministic disjoint holdout, sorted unique contexts, context order1..3, candidate count1..8, observed counts>=2, JSON serialization, size<15MB"}
    (OUT/"validation.json").write_text(json.dumps(validation,indent=2)+'\n',encoding="utf-8")
    print(json.dumps(validation,indent=2),flush=True)
    print(json.dumps(metrics,indent=2),flush=True)


if __name__ == "__main__":
    main()
