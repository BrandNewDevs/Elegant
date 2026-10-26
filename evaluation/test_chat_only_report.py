import unittest
from report import aggregate

class ChatOnlyReportTests(unittest.TestCase):
    def test_skipped_summary_never_becomes_pass_even_with_a_complete_review(self):
        fixture = {"id": "one", "split": "tuning", "synthetic": True,
                   "transcript": {"segments": [{"speaker": "You"}]},
                   "points": [{"id": "p", "critical": True}],
                   "questions": [{"id": "q"}]}
        review = {"coveredPointIds": ["p"], "unsupportedClaims": 0, "criticalUnsupportedClaims": 0,
                  "attributionErrors": 0, "invalidReferences": 0, "retrievalMisses": 0,
                  "citationSupportErrors": 0, "criticalDecisionsCovered": True, "chatCriticalCorrect": True}
        run = {"id": "one", "summarySkipped": True, "chat": [{"questionId": "q",
               "answer": {"text": "A supported answer", "refs": [0], "sufficient": True}}]}
        result = aggregate({"runs": [run]}, [fixture], {"one": review})
        self.assertEqual(result["summaryQuality"], "pending")
        self.assertEqual(result["chatQuality"], "pass")
        run["error"] = "An actual Summary failure"
        self.assertEqual(aggregate({"runs": [run]}, [fixture])["summaryQuality"], "fail")
