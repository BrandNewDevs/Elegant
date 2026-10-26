"""Behavior checks for the evaluation report's public aggregate interface."""
import copy
import unittest

from report import aggregate, speech_metrics

FIXTURE = {
    "id": "decision", "split": "reserved", "synthetic": True,
    "transcript": {"segments": [{"speaker": "You", "text": "No launch date is agreed."}]},
    "points": [{"id": "p1", "critical": True}],
    "questions": [{"id": "q1", "question": "When do we launch?", "answer": None}],
}
RUN = {
    "id": "decision", "summary": {"tldr": "No date is agreed.", "participants": [{"speaker": "You", "said": ["No launch date is agreed."]}]},
    "chat": [{"questionId": "q1", "answer": {"text": "No launch date is established.", "refs": [0], "sufficient": True}}],
    "elapsedMs": 1234, "calls": 2, "peakRssKiB": 32100,
}
REVIEW = {
    "coveredPointIds": ["p1"], "unsupportedClaims": 0, "criticalUnsupportedClaims": 0,
    "attributionErrors": 0, "invalidReferences": 0, "criticalDecisionsCovered": True,
    "chatCriticalCorrect": True, "retrievalMisses": 0, "citationSupportErrors": 0,
}


class EvaluationReportTests(unittest.TestCase):
    def result(self, run=None, review=None):
        return aggregate({"runs": [copy.deepcopy(run or RUN)]}, [FIXTURE],
                         {"decision": copy.deepcopy(review or REVIEW)})

    def test_missing_human_review_never_passes(self):
        report = aggregate({"runs": [RUN]}, [FIXTURE])
        self.assertEqual(report["summaryQuality"], "pending")
        self.assertEqual(report["chatQuality"], "pending")
        self.assertIn("pending", report["targetDeviceAcceptance"])

    def test_incomplete_review_stays_pending(self):
        review = dict(REVIEW)
        del review["citationSupportErrors"]
        self.assertEqual(self.result(review=review)["summaryQuality"], "pending")

    def test_complete_review_can_pass_synthetic_quality_only(self):
        report = self.result()
        self.assertEqual(report["summaryQuality"], "pass")
        self.assertEqual(report["chatQuality"], "pass")
        self.assertEqual(report["observations"]["modelCalls"], 2)
        self.assertEqual(report["observations"]["medianElapsedMs"], 1234)
        self.assertIn("pending", report["targetDeviceAcceptance"])

    def test_missing_reserved_run_keeps_whole_suite_pending(self):
        other = dict(FIXTURE, id="other")
        report = aggregate({"runs": [RUN]}, [FIXTURE, other], {"decision": REVIEW})
        self.assertEqual(report["summaryQuality"], "pending")

    def test_critical_unsupported_claim_fails(self):
        report = self.result(review=dict(REVIEW, criticalUnsupportedClaims=1))
        self.assertEqual(report["summaryQuality"], "fail")
        self.assertEqual(report["chatQuality"], "fail")

    def test_citation_support_and_attribution_are_quality_gates(self):
        for key in ("citationSupportErrors", "invalidReferences", "attributionErrors"):
            with self.subTest(key=key):
                self.assertEqual(self.result(review=dict(REVIEW, **{key: 1}))["summaryQuality"], "fail")

    def test_missing_critical_point_fails_even_when_review_says_decisions_covered(self):
        self.assertEqual(self.result(review=dict(REVIEW, coveredPointIds=[]))["summaryQuality"], "fail")

    def test_unknown_point_id_is_not_counted_as_coverage(self):
        with self.assertRaisesRegex(ValueError, "unknown point IDs"):
            self.result(review=dict(REVIEW, coveredPointIds=["made-up"]))

    def test_invented_participant_fails_without_human_review(self):
        run = copy.deepcopy(RUN)
        run["summary"]["participants"][0]["speaker"] = "Alice"
        report = aggregate({"runs": [run]}, [FIXTURE])
        self.assertEqual(report["summaryQuality"], "fail")
        self.assertEqual(report["fixtures"][0]["inventedLabels"], 1)

    def test_chat_skipped_is_pending_and_failed_chat_fails(self):
        run = dict(RUN, chat=[{"questionId": "q1", "skipped": "Chat is not yet implemented"}])
        self.assertEqual(self.result(run=run)["chatQuality"], "pending")
        run["chat"] = [{"questionId": "q1", "error": "Model failed"}]
        self.assertEqual(self.result(run=run)["chatQuality"], "fail")

    def test_malformed_summary_cannot_be_overridden_by_positive_review(self):
        for summary in ({}, {"tldr": " ", "participants": []},
                        {"tldr": "A decision", "participants": "You"},
                        {"tldr": "A decision", "participants": [{"speaker": "You", "said": [1]}]},
                        {"tldr": "A decision", "participants": [{"speaker": "You", "said": [" "]}]},
                        {"tldr": "A decision", "participants": [None]}):
            with self.subTest(summary=summary):
                report = self.result(run=dict(RUN, summary=summary))
                self.assertEqual(report["summaryQuality"], "fail")
                self.assertEqual(report["chatQuality"], "pass")

    def test_duplicate_participant_is_malformed(self):
        run = copy.deepcopy(RUN)
        run["summary"]["participants"] *= 2
        self.assertEqual(self.result(run=run)["summaryQuality"], "fail")

    def test_malformed_chat_cannot_be_overridden_by_positive_review(self):
        for answer in ({}, {"text": " ", "refs": [], "sufficient": False},
                       {"text": "An answer", "refs": "0", "sufficient": True},
                       {"text": "An answer", "refs": [True], "sufficient": True},
                       {"text": "An answer", "refs": [-1], "sufficient": True},
                       {"text": "An answer", "refs": [8], "sufficient": True},
                       {"text": "An answer", "refs": [0], "sufficient": "yes"}):
            with self.subTest(answer=answer):
                report = self.result(run=dict(RUN, chat=[{"questionId": "q1", "answer": answer}]))
                self.assertEqual(report["chatQuality"], "fail")

    def test_insufficient_evidence_answer_may_have_no_citations(self):
        report = self.result(run=dict(RUN, chat=[{"questionId": "q1", "answer": {
            "text": "The requested fact is not established.", "refs": [], "sufficient": False}}]))
        self.assertEqual(report["chatQuality"], "pass")

    def test_known_chat_error_fails_without_human_review_or_summary(self):
        for summary_error in (False, True):
            with self.subTest(summary_error=summary_error):
                run = dict(RUN, chat=[{"questionId": "q1", "error": "model stopped"}])
                if summary_error:
                    run.update(summary=None, error="Summary model stopped")
                report = aggregate({"runs": [run]}, [FIXTURE])
                self.assertEqual(report["chatQuality"], "fail")

    def test_malformed_chat_is_known_failure_without_human_review(self):
        for chat in ({}, [None], [{"questionId": "q1", "answer": {}}]):
            with self.subTest(chat=chat):
                report = aggregate({"runs": [dict(RUN, chat=chat)]}, [FIXTURE])
                self.assertEqual(report["chatQuality"], "fail")

    def test_duplicate_and_unknown_question_results_fail(self):
        for chat in ([RUN["chat"][0]] * 2, [{"questionId": "unknown", "answer": RUN["chat"][0]["answer"]}]):
            with self.subTest(chat=chat):
                self.assertEqual(self.result(run=dict(RUN, chat=chat))["chatQuality"], "fail")

    def test_duplicate_runs_cannot_mask_each_other(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            aggregate({"runs": [RUN, RUN]}, [FIXTURE])

    def test_unknown_fixture_fails_instead_of_dropping_results(self):
        with self.assertRaisesRegex(ValueError, "unknown fixture"):
            aggregate({"runs": [dict(RUN, id="unknown")]}, [FIXTURE])

    def test_speech_wer_is_edit_distance_over_reference_words(self):
        result = speech_metrics({"excerpts": [
            {"reference": "We agreed on Friday", "hypothesis": "We agree Friday", "referenceSpeaker": "You", "hypothesisSpeaker": "Speaker 1"},
            {"reference": "No deadline", "hypothesis": "No deadline", "referenceSpeaker": "You", "hypothesisSpeaker": "You"},
        ]})
        self.assertEqual(result["wordErrors"], 2)
        self.assertAlmostEqual(result["wordErrorRate"], 2 / 6)
        self.assertEqual(result["speakerMismatchRate"], .5)
        self.assertIn("not diarization error rate", result["scope"])

    def test_speech_without_reference_words_cannot_claim_measured_wer(self):
        result = speech_metrics({"excerpts": [{"reference": "", "hypothesis": "hallucinated words"}]})
        self.assertEqual(result["status"], "pending")
        self.assertIsNone(result["wordErrorRate"])
        self.assertEqual(result["wordErrors"], 2)


if __name__ == "__main__":
    unittest.main()
