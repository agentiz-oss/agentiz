"""How a run's thinking level reaches each harness — see reasoning_settings in main.py."""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agentiz_worker.main import WorkerError, reasoning_settings, stage_config


def stage(**agent):
    return {"runtime": {"mode": "host"}, "agent": {"kind": "openhands-acp",
            "config": {"acpCommand": ["npx", "@agentclientprotocol/claude-agent-acp"]}, **agent}}


class StageConfigTest(unittest.TestCase):
    def test_absent_level_is_none(self):
        self.assertIsNone(stage_config(stage())[5])

    def test_level_is_read(self):
        self.assertEqual(stage_config(stage(reasoningLevel="high"))[5], "high")

    def test_unknown_level_is_refused(self):
        with self.assertRaises(WorkerError):
            stage_config(stage(reasoningLevel="ultra"))


class ReasoningSettingsTest(unittest.TestCase):
    def setUp(self):
        self.notes: list[str] = []

    def test_no_level_changes_nothing(self):
        with reasoning_settings("claude", "sonnet", None, self.notes.append) as model:
            self.assertEqual(model, "sonnet")
            self.assertNotIn("MAX_THINKING_TOKENS", os.environ)
        self.assertEqual(self.notes, [])

    def test_claude_sets_and_restores_the_budget(self):
        with reasoning_settings("claude", "sonnet", "high", self.notes.append) as model:
            self.assertEqual(model, "sonnet")
            self.assertEqual(os.environ["MAX_THINKING_TOKENS"], "31999")
        self.assertNotIn("MAX_THINKING_TOKENS", os.environ)
        self.assertEqual(len(self.notes), 1)

    def test_claude_restores_a_pre_existing_budget(self):
        os.environ["MAX_THINKING_TOKENS"] = "123"
        try:
            with reasoning_settings("claude", None, "low", self.notes.append):
                self.assertEqual(os.environ["MAX_THINKING_TOKENS"], "4000")
            self.assertEqual(os.environ["MAX_THINKING_TOKENS"], "123")
        finally:
            os.environ.pop("MAX_THINKING_TOKENS", None)

    def test_codex_carries_the_level_in_the_model_id(self):
        with reasoning_settings("codex", "gpt-5.5", "xhigh", self.notes.append) as model:
            self.assertEqual(model, "gpt-5.5/xhigh")

    def test_codex_without_a_model_warns_instead_of_guessing(self):
        with reasoning_settings("codex", None, "high", self.notes.append) as model:
            self.assertIsNone(model)
        self.assertIn("пропущен", self.notes[0])

    def test_unknown_harness_warns(self):
        with reasoning_settings("acp", "m", "high", self.notes.append) as model:
            self.assertEqual(model, "m")
        self.assertIn("пропущен", self.notes[0])
