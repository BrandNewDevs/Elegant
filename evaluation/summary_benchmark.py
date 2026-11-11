#!/usr/bin/env python3
"""Create and score output-bound human Summary reviews; no model calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path

from report import combine_status, valid_summary

DIMENSIONS = ('factualSupport', 'attribution', 'conditions', 'readability', 'repetition', 'tldrUsefulness')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def prepare(results, fixtures):
    if not fixtures or len({f['id'] for f in fixtures}) != len(fixtures):
        raise ValueError('Provide non-empty uniquely identified fixtures')
    runs = results['runs']
    if len({r['id'] for r in runs}) != len(runs):
        raise ValueError('Duplicate runs')
    expected = {f['id']: f for f in fixtures}
    if set(expected) != {r['id'] for r in runs}:
        raise ValueError('Runs must match the selected fixture set exactly')
    reviews = {}
    for run in runs:
        fixture = expected[run['id']]
        points = fixture['points']
        if (fixture.get('expectationsPrepared') is False or not points
                or len({p['id'] for p in points}) != len(points)):
            raise ValueError('Prepare non-empty unique expectations before review')
        for point in points:
            refs = point['refs']
            if not refs or any(type(i) is not int or not 0 <= i < len(fixture['transcript']['segments']) for i in refs):
                raise ValueError('Expected points need valid source references')
        reviews[run['id']] = {
            'binding': fingerprint({'fixture': fixture, 'run': run, 'metadata': results.get('metadata')}),
            'reviewer': '', 'reviewedAt': '', 'complete': False,
            'points': {p['id']: {'covered': None, 'note': ''} for p in points},
            'criticalDecisionsCovered': None,
            'dimensions': {d: {'score': None, 'note': ''} for d in DIMENSIONS},
            'findings': [],
        }
    return {'rubricVersion': 1, 'reviews': reviews}


def score(results, fixtures, document):
    template = prepare(results, fixtures)
    if document.get('rubricVersion') != 1 or set(document.get('reviews', {})) != set(template['reviews']):
        raise ValueError('Review version or fixture set mismatch')
    rows = []
    by_id = {r['id']: r for r in results['runs']}
    for fixture in fixtures:
        key = fixture['id']
        review = document['reviews'][key]
        if review.get('binding') != template['reviews'][key]['binding']:
            raise ValueError('Stale review: fixture, output or run metadata changed')
        row = {'id': key, 'split': fixture['split'], 'synthetic': fixture['synthetic'],
               'status': 'pending', 'coverage': None, 'scores': {}}
        rows.append(row)
        run = by_id[key]
        summary = run.get('summary')
        if run.get('error') or not valid_summary(summary):
            row['status'] = 'fail'
            continue
        labels = {s['speaker'] for s in fixture['transcript']['segments']}
        if any(p['speaker'] not in labels for p in summary['participants']):
            row['status'] = 'fail'
            continue
        if review.get('complete') is not True:
            continue
        if not all(isinstance(review.get(k), str) and review[k].strip() for k in ('reviewer', 'reviewedAt')):
            raise ValueError('Completed review requires reviewer and review date')
        points = review.get('points', {})
        if set(points) != {p['id'] for p in fixture['points']}:
            raise ValueError('Review must cover exactly the expected point IDs')
        if any(type(p.get('covered')) is not bool or not isinstance(p.get('note'), str) or not p['note'].strip() for p in points.values()):
            raise ValueError('Each point needs a coverage judgment and evidence note')
        dimensions = review.get('dimensions', {})
        if set(dimensions) != set(DIMENSIONS) or any(
                type(d.get('score')) is not int or not 1 <= d['score'] <= 3
                or not isinstance(d.get('note'), str) or not d['note'].strip() for d in dimensions.values()):
            raise ValueError('Each dimension needs a score from 1 to 3 and rationale')
        if type(review.get('criticalDecisionsCovered')) is not bool:
            raise ValueError('Review final decisions explicitly')
        findings = review.get('findings')
        if not isinstance(findings, list):
            raise ValueError('Findings must be a list')
        for finding in findings:
            if (finding.get('kind') not in ('unsupportedClaim', 'ownership', 'invalidReference', 'citationSupport', 'other')
                    or type(finding.get('critical')) is not bool
                    or not all(isinstance(finding.get(k), str) and finding[k].strip() for k in ('location', 'evidence', 'reason'))):
                raise ValueError('Findings require kind, critical flag, output location, evidence and reason')
        coverage = sum(p['covered'] for p in points.values()) / len(points)
        hard_failure = any(f['kind'] in ('ownership', 'invalidReference', 'citationSupport')
                           or (f['kind'] == 'unsupportedClaim' and f['critical']) for f in findings)
        passed = (coverage >= .9 and all(points[p['id']]['covered'] for p in fixture['points'] if p['critical'])
                  and review['criticalDecisionsCovered'] and not hard_failure
                  and all(dimensions[d]['score'] == 3 for d in ('factualSupport', 'attribution', 'conditions')))
        row.update(status='pass' if passed else 'fail', coverage=coverage,
                   scores={d: dimensions[d]['score'] for d in DIMENSIONS}, findingCount=len(findings))
    return {'rubricVersion': 1, 'summaryQuality': combine_status([r['status'] for r in rows]),
            'fixtures': rows, 'metadata': results.get('metadata', {}),
            'limitations': ['Human judgments required; presentation scores do not offset factual failures.',
                            'Synthetic results do not establish real-Meeting or target-device acceptance.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'score'))
    parser.add_argument('results', type=Path)
    parser.add_argument('--fixtures', required=True, type=Path)
    parser.add_argument('--reviews', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text())
    results = read(args.results)
    fixtures = [read(p) for p in sorted(args.fixtures.glob('*.json'))]
    if args.mode == 'score' and args.reviews is None:
        parser.error('score requires --reviews')
    result = prepare(results, fixtures) if args.mode == 'prepare' else score(results, fixtures, read(args.reviews))
    # Never replace a human review or prior report. Private outputs are owner-only.
    with open(args.output, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(result, output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    main()
