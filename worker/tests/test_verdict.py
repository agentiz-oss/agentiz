"""Mirrors runVerdict.test.ts on the TypeScript side — same marker format, same cases."""
from __future__ import annotations

import unittest

from agentiz_worker.verdict import extract_verdict


class ExtractVerdictTest(unittest.TestCase):
    def test_plain_pass(self) -> None:
        self.assertEqual(extract_verdict("Всё проверил.\nAGENTIZ_VERDICT: pass"), ("pass", None))

    def test_fail_with_reason(self) -> None:
        self.assertEqual(extract_verdict("AGENTIZ_VERDICT: fail — тесты не проходят"), ("fail", "тесты не проходят"))

    def test_accepts_a_plain_hyphen(self) -> None:
        self.assertEqual(extract_verdict("AGENTIZ_VERDICT: fail - build broken"), ("fail", "build broken"))

    def test_case_insensitive(self) -> None:
        self.assertEqual(extract_verdict("agentiz_verdict: PASS"), ("pass", None))

    def test_last_marker_wins(self) -> None:
        text = "AGENTIZ_VERDICT: fail — draft\nMore investigation...\nAGENTIZ_VERDICT: pass"
        self.assertEqual(extract_verdict(text), ("pass", None))

    def test_reason_does_not_spill_onto_the_next_line(self) -> None:
        text = "AGENTIZ_VERDICT: fail — see below\nActually the whole story is longer than one line"
        self.assertEqual(extract_verdict(text), ("fail", "see below"))

    def test_unclear_value_is_no_marker_at_all(self) -> None:
        self.assertEqual(extract_verdict("AGENTIZ_VERDICT: unclear"), (None, None))

    def test_missing_or_empty_text(self) -> None:
        self.assertEqual(extract_verdict(None), (None, None))
        self.assertEqual(extract_verdict(""), (None, None))
        self.assertEqual(extract_verdict("No marker here at all."), (None, None))


if __name__ == "__main__":
    unittest.main()
