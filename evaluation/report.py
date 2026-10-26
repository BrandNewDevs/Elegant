#!/usr/bin/env python3
"""Aggregate local evaluation observations. Human judgments are required for quality gates.

Only counts and operational metadata enter the report; Transcript and answer text do not.
Speech input: {"excerpts": [{"reference": "corrected words", "hypothesis": "recognized words",
"referenceSpeaker": "You", "hypothesisSpeaker": "You"}]}. Excerpts must be aligned manually.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import statistics
from typing import Any


REVIEW_COUNTS = (
    "unsupportedClaims", "criticalUnsupportedClaims", "attributionErrors",
    "invalidReferences", "retrievalMisses", "citationSupportErrors",
)
REVIEW_BOOLEANS = ("criticalDecisionsCovered", "chatCriticalCorrect")


def words(text: str) -> list[str]:
    return re.findall(r"\b[\w']+\b", text.lower())


def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        current = [i]
        for j, actual in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (expected != actual)))
        previous = current
    return previous[-1]


def speech_metrics(data: dict[str, Any] | None) -> dict[str, Any]:
    if data is None:
        return {"status": "pending", "reason": "No corrected speech excerpts supplied"}
    excerpts = data.get("excerpts")
    if not isinstance(excerpts, list) or not excerpts:
        raise ValueError("Speech review needs a non-empty excerpts list")
    errors = count = attributed = mismatches = 0
    for excerpt in excerpts:
        if not isinstance(excerpt.get("reference"), str) or not isinstance(excerpt.get("hypothesis"), str):
            raise ValueError("Each speech excerpt needs reference and hypothesis text")
        reference, hypothesis = words(excerpt["reference"]), words(excerpt["hypothesis"])
        errors += edit_distance(reference, hypothesis)
        count += len(reference)
        if "referenceSpeaker" in excerpt and "hypothesisSpeaker" in excerpt:
            attributed += 1
            mismatches += excerpt["referenceSpeaker"] != excerpt["hypothesisSpeaker"]
    return {
        "status": "measured" if count else "pending", "referenceWords": count,
        "wordErrors": errors, "wordErrorRate": errors / count if count else None,
        "attributedExcerpts": attributed, "speakerMismatches": mismatches,
        "speakerMismatchRate": mismatches / attributed if attributed else None,
        "scope": "Manually aligned excerpts only; speaker mismatch is not diarization error rate",
    }


def valid_review(review: Any) -> bool:
    return (isinstance(review, dict)
            and isinstance(review.get("coveredPointIds"), list)
            and all(isinstance(value, str) for value in review["coveredPointIds"])
            and all(type(review.get(key)) is int and review[key] >= 0 for key in REVIEW_COUNTS)
            and all(type(review.get(key)) is bool for key in REVIEW_BOOLEANS))


def combine_status(statuses: list[str]) -> str:
    if "fail" in statuses:
        return "fail"
    return "pass" if statuses and all(status == "pass" for status in statuses) else "pending"


def aggregate(results: dict[str, Any], fixtures: list[dict[str, Any]],
              reviews: dict[str, Any] | None = None,
              speech: dict[str, Any] | None = None) -> dict[str, Any]:
    expected = {fixture["id"]: fixture for fixture in fixtures}
    if not expected:
        raise ValueError("At least one fixture is required")
    runs = results.get("runs")
    if not isinstance(runs, list):
        raise ValueError("Results must contain a runs list")
    ids = [run["id"] for run in runs]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate fixture runs; compare separate result files")
    unknown = set(ids) - expected.keys()
    if unknown:
        raise ValueError(f"Results contain unknown fixture IDs: {sorted(unknown)}")
    by_id = {run["id"]: run for run in runs}
    rows: list[dict[str, Any]] = []
    for fixture_id, fixture in expected.items():
        run, review = by_id.get(fixture_id), (reviews or {}).get(fixture_id)
        row: dict[str, Any] = {
            "id": fixture_id, "split": fixture.get("split", "unknown"),
            "synthetic": fixture.get("synthetic", False),
            "summaryStatus": "pending", "chatStatus": "pending",
            "coverage": None, "reason": "Run or complete human review missing",
        }
        rows.append(row)
        if run is None:
            continue
        row.update({"elapsedMs": run.get("elapsedMs"), "calls": run.get("calls"),
                    "nodePeakRssKiB": run.get("peakRssKiB")})
        if run.get("error") or not isinstance(run.get("summary"), dict):
            row.update(summaryStatus="fail", reason="Summary generation failed or is absent")
            continue
        labels = {segment["speaker"] for segment in fixture["transcript"]["segments"]}
        participants = run["summary"].get("participants", [])
        invented = sum(participant.get("speaker") not in labels for participant in participants)
        row["inventedLabels"] = invented
        if invented:
            row.update(summaryStatus="fail", reason="Summary contains unknown Participant labels")
            continue
        if not valid_review(review):
            continue
        point_ids = {point["id"] for point in fixture["points"]}
        covered = set(review["coveredPointIds"])
        if covered - point_ids:
            raise ValueError(f"Review for {fixture_id} contains unknown point IDs")
        critical = {point["id"] for point in fixture["points"] if point.get("critical")}
        coverage = len(covered) / len(point_ids) if point_ids else 1.0
        summary_pass = (
            coverage >= .9 and critical <= covered and review["criticalDecisionsCovered"]
            and review["criticalUnsupportedClaims"] == 0
            and review["attributionErrors"] == 0 and review["invalidReferences"] == 0
            and review["citationSupportErrors"] == 0
        )
        row.update({
            "coverage": coverage, "criticalPointsCovered": len(critical & covered),
            "criticalPointsExpected": len(critical),
            "summaryStatus": "pass" if summary_pass else "fail",
            "reason": "Human reviewed against predefined points and original passages",
            **{key: review[key] for key in REVIEW_COUNTS},
        })
        questions = fixture.get("questions", [])
        answers = {answer["questionId"]: answer for answer in run.get("chat", [])}
        chat_errors = any(answer.get("error") for answer in answers.values())
        missing = any(question["id"] not in answers
                      or answers[question["id"]].get("skipped")
                      or not isinstance(answers[question["id"]].get("answer"), dict)
                      for question in questions)
        if chat_errors:
            row["chatStatus"] = "fail"
        elif questions and not missing:
            row["chatStatus"] = "pass" if (
                review["chatCriticalCorrect"] and review["criticalUnsupportedClaims"] == 0
                and review["invalidReferences"] == 0 and review["citationSupportErrors"] == 0
            ) else "fail"
    timings = [row["elapsedMs"] for row in rows if isinstance(row.get("elapsedMs"), (int, float))]
    return {
        "metadata": results.get("metadata", {}), "fixtures": rows,
        "summaryQuality": combine_status([row["summaryStatus"] for row in rows]),
        "chatQuality": combine_status([row["chatStatus"] for row in rows]),
        "speech": speech_metrics(speech),
        "observations": {
            "runs": len(runs), "generationErrors": sum(bool(run.get("error")) for run in runs),
            "modelCalls": sum(run.get("calls", 0) for run in runs),
            "medianElapsedMs": statistics.median(timings) if timings else None,
            "maxElapsedMs": max(timings) if timings else None,
        },
        "targetDeviceAcceptance": "pending: requires M4 timings, model/engine memory and real Recordings",
        "limitations": [
            "Quality depends on human review; no lexical score proves factual support",
            "Node peak RSS excludes Ollama and the Swift engine",
            "Synthetic fixtures do not establish real Meeting or 60-minute quality",
        ],
    }


def markdown(report: dict[str, Any]) -> str:
    lines = ["# Local AI evaluation", "", f"Summary quality: **{report['summaryQuality']}**. "
             f"Chat quality: **{report['chatQuality']}**.", "",
             "| Example | Split | Summary | Chat | Point coverage |",
             "| --- | --- | --- | --- | --- |"]
    for row in report["fixtures"]:
        coverage = "pending" if row["coverage"] is None else f"{row['coverage']:.0%}"
        lines.append(f"| {row['id']} | {row['split']} | {row['summaryStatus']} | {row['chatStatus']} | {coverage} |")
    observations = report["observations"]
    lines.extend(["", f"Runs: {observations['runs']}; model calls: {observations['modelCalls']}; "
                  f"generation errors: {observations['generationErrors']}.",
                  f"Median/max elapsed milliseconds: {observations['medianElapsedMs']} / {observations['maxElapsedMs']}.",
                  "", f"Speech: {report['speech']['status']}.",
                  f"Target-device acceptance: {report['targetDeviceAcceptance']}.", ""])
    if report["speech"]["status"] == "measured":
        lines.append(f"Excerpt WER: {report['speech']['wordErrorRate']:.1%}; "
                     f"speaker mismatches: {report['speech']['speakerMismatches']}/{report['speech']['attributedExcerpts']} excerpts.")
    lines.extend(report["limitations"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--fixtures", type=Path, default=Path(__file__).parent / "fixtures")
    parser.add_argument("--reviews", type=Path)
    parser.add_argument("--speech", type=Path)
    parser.add_argument("--json", type=Path, dest="json_output")
    args = parser.parse_args()
    read = lambda path: json.loads(path.read_text())
    report = aggregate(read(args.results), [read(path) for path in sorted(args.fixtures.glob("*.json"))],
                       read(args.reviews) if args.reviews else None,
                       read(args.speech) if args.speech else None)
    if args.json_output:
        args.json_output.write_text(json.dumps(report, indent=2) + "\n")
    print(markdown(report), end="")


if __name__ == "__main__":
    main()
