import copy
import unittest
from summary_benchmark import prepare, score


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = [{'id': 'meeting', 'split': 'tuning', 'synthetic': True,
                          'transcript': {'segments': [{'speaker': 'You', 'text': 'Friday is final.'}]},
                          'points': [{'id': str(i), 'refs': [0], 'critical': i == 0} for i in range(10)]}]
        self.results = {'metadata': {'model': 'test'}, 'runs': [{'id': 'meeting', 'summary': {
            'tldr': 'Friday is final.', 'participants': [{'speaker': 'You', 'said': ['Friday is final.']}]}}]}
        self.review = prepare(self.results, self.fixtures)
        r = self.review['reviews']['meeting']
        r.update(complete=True, reviewer='Human reviewer', reviewedAt='2026-11-03', criticalDecisionsCovered=True)
        for p in r['points'].values():
            p.update(covered=True, note='Participant point 0, source segment 0')
        for d in r['dimensions'].values():
            d.update(score=3, note='Checked against segment 0')

    def status(self):
        return score(self.results, self.fixtures, self.review)['summaryQuality']

    def test_complete_review_passes(self):
        self.assertEqual(self.status(), 'pass')

    def test_missing_review_pending(self):
        self.review['reviews']['meeting']['complete'] = False
        self.assertEqual(self.status(), 'pending')

    def test_critical_omission_fails_at_ninety_percent(self):
        self.review['reviews']['meeting']['points']['0']['covered'] = False
        self.assertEqual(self.status(), 'fail')

    def test_readability_cannot_offset_wrong_owner(self):
        self.review['reviews']['meeting']['findings'] = [{'kind': 'ownership', 'critical': True,
            'location': 'TL;DR', 'evidence': 'segment 0', 'reason': 'Owner invented'}]
        self.assertEqual(self.status(), 'fail')

    def test_stale_output_fixture_and_metadata_rejected(self):
        for target in ('output', 'fixture', 'metadata'):
            with self.subTest(target=target):
                results, fixtures = copy.deepcopy(self.results), copy.deepcopy(self.fixtures)
                if target == 'output': results['runs'][0]['summary']['tldr'] = 'Monday'
                if target == 'fixture': fixtures[0]['split'] = 'reserved'
                if target == 'metadata': results['metadata']['model'] = 'other'
                with self.assertRaisesRegex(ValueError, 'Stale'):
                    score(results, fixtures, self.review)

    def test_invalid_review_rejected(self):
        for change in ('unknownPoint', 'missingScore', 'missingRationale'):
            with self.subTest(change=change):
                review = copy.deepcopy(self.review)
                r = review['reviews']['meeting']
                if change == 'unknownPoint': r['points']['unknown'] = r['points']['0']
                if change == 'missingScore': r['dimensions']['readability']['score'] = None
                if change == 'missingRationale': r['dimensions']['conditions']['note'] = ''
                with self.assertRaises(ValueError): score(self.results, self.fixtures, review)

    def test_generation_failure_and_unknown_speaker_fail_without_review(self):
        for broken in ('error', 'speaker'):
            results = copy.deepcopy(self.results)
            if broken == 'error': results['runs'][0]['error'] = 'timeout'
            else: results['runs'][0]['summary']['participants'][0]['speaker'] = 'Invented'
            review = prepare(results, self.fixtures)
            self.assertEqual(score(results, self.fixtures, review)['summaryQuality'], 'fail')

    def test_no_chat_required_and_scope_preserved(self):
        report = score(self.results, self.fixtures, self.review)
        self.assertEqual(report['fixtures'][0]['split'], 'tuning')
        self.assertTrue(report['fixtures'][0]['synthetic'])
        self.assertNotIn('chatQuality', report)

    def test_empty_expectations_and_bad_refs_rejected(self):
        for points in ([], [{'id': 'bad', 'refs': [99], 'critical': True}]):
            fixtures = copy.deepcopy(self.fixtures)
            fixtures[0]['points'] = points
            with self.assertRaises(ValueError): prepare(self.results, fixtures)

    def test_cli_creates_private_template_and_refuses_overwrite(self):
        import json
        import os
        from pathlib import Path
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = root / 'fixtures'
            fixtures.mkdir()
            (fixtures / 'meeting.json').write_text(json.dumps(self.fixtures[0]))
            results = root / 'results.json'
            results.write_text(json.dumps(self.results))
            output = root / 'review.json'
            command = [sys.executable, str(Path(__file__).with_name('summary_benchmark.py')),
                       'prepare', str(results), '--fixtures', str(fixtures), '--output', str(output)]
            first = subprocess.run(command, capture_output=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            original = output.read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
