from __future__ import annotations

import unittest

from agentiz_worker.prompt import MAX_PRIOR_RUNS, MAX_THREAD_CHARS, build_prompt

STAGE = {"systemPrompt": "You are a developer."}
TASK = {"title": "Add a login screen", "description": "The app opens straight into the feed."}


def job(**conversation: object) -> dict[str, object]:
    return {"task": TASK, "conversation": conversation} if conversation else {"task": TASK}


def comment(id: str, body: str, kind: str = "human", name: str | None = None) -> dict[str, object]:
    return {"id": id, "authorKind": kind, "authorName": name, "body": body, "createdAt": f"2026-08-20T10:0{id[-1]}:00Z"}


class BuildPromptTest(unittest.TestCase):
    def test_without_a_conversation_the_prompt_is_what_it_always_was(self) -> None:
        self.assertEqual(
            build_prompt(STAGE, job()),
            "You are a developer.\n\nTask: Add a login screen\n\nThe app opens straight into the feed.",
        )

    def test_trigger_comment_is_the_instruction_and_comes_last(self) -> None:
        text = build_prompt(STAGE, job(
            primaryPrompt=comment("c2", "Now make it remember the session"),
            messages=[comment("c1", "Start with the form"), comment("c2", "Now make it remember the session")],
        ))
        self.assertIn("# Current instruction", text)
        self.assertIn("do not start the original task over", text)
        self.assertTrue(text.rstrip().endswith("Now make it remember the session"))
        # The task stays in, as background, above the instruction.
        self.assertLess(text.index("The app opens straight into the feed."), text.index("# Current instruction"))

    def test_the_instruction_is_not_repeated_inside_the_thread(self) -> None:
        text = build_prompt(STAGE, job(
            primaryPrompt=comment("c2", "Now make it remember the session"),
            messages=[comment("c1", "Start with the form"), comment("c2", "Now make it remember the session")],
        ))
        self.assertEqual(text.count("Now make it remember the session"), 1)
        self.assertIn("Start with the form", text)

    def test_a_thread_without_a_trigger_still_travels_as_context(self) -> None:
        text = build_prompt(STAGE, job(messages=[comment("c1", "Start with the form")]))
        self.assertIn("# Discussion so far", text)
        self.assertIn("Start with the form", text)
        self.assertNotIn("# Current instruction", text)

    def test_prior_runs_bring_their_summaries_and_failures(self) -> None:
        text = build_prompt(STAGE, job(priorRuns=[
            {"trigger": "manual", "status": "succeeded", "resultSummary": "- built the form"},
            {"trigger": "human_comment", "status": "failed", "errorMessage": "npm test failed",
             "stages": [{"role": "dev", "status": "failed", "output": {"agentResponse": "got as far as the router"}}]},
        ]))
        self.assertIn("# Earlier runs on this task", text)
        self.assertIn("- built the form", text)
        self.assertIn("got as far as the router", text)
        self.assertIn("Run error: npm test failed", text)

    def test_only_the_last_runs_are_rendered_and_the_rest_are_counted(self) -> None:
        runs = [{"trigger": "manual", "status": "succeeded", "resultSummary": f"summary {index}"} for index in range(6)]
        text = build_prompt(STAGE, job(priorRuns=runs))
        self.assertIn(f"({len(runs) - MAX_PRIOR_RUNS} earlier run(s) omitted.)", text)
        self.assertNotIn("summary 0", text)
        self.assertIn("summary 5", text)
        self.assertIn("--- run 6 (manual) finished as succeeded ---", text)

    def test_a_long_thread_keeps_the_newest_messages_and_says_what_it_dropped(self) -> None:
        messages = [comment(f"c{index}", f"message {index} " + "x" * 900) for index in range(40)]
        text = build_prompt(STAGE, job(primaryPrompt=comment("c99", "do this"), messages=messages))
        self.assertIn("earlier message(s) omitted.", text)
        self.assertIn("message 39", text)
        self.assertNotIn("message 0 ", text)
        self.assertTrue(text.rstrip().endswith("do this"))

    def test_one_enormous_message_is_truncated_not_dropped(self) -> None:
        text = build_prompt(STAGE, job(messages=[comment("c1", "y" * (MAX_THREAD_CHARS * 2))]))
        self.assertIn("truncated,", text)
        self.assertIn("# Discussion so far", text)

    def test_empty_and_malformed_pieces_are_ignored(self) -> None:
        text = build_prompt(STAGE, {
            "task": TASK,
            "conversation": {"primaryPrompt": None, "messages": ["not a message", {"body": "   "}], "priorRuns": ["nope"]},
        })
        self.assertEqual(text, build_prompt(STAGE, job()))

    def test_attached_files_are_listed_with_their_local_paths(self) -> None:
        text = build_prompt(STAGE, job(), [
            {"name": "screen.png", "path": "/tmp/task-files/screen.png", "mimeType": "image/png", "sizeBytes": 34_000},
            {"name": "notes.txt", "path": "/tmp/task-files/notes.txt", "sizeBytes": 120},
        ])
        self.assertIn("# Attached files", text)
        self.assertIn("- /tmp/task-files/screen.png (image/png, 33 KB)", text)
        self.assertIn("- /tmp/task-files/notes.txt (120 B)", text)
        self.assertIn("outside the working tree", text)
        # Above the history blocks, below the task itself.
        self.assertLess(text.index("The app opens straight into the feed."), text.index("# Attached files"))

    def test_no_attachments_leave_the_prompt_untouched(self) -> None:
        self.assertEqual(build_prompt(STAGE, job(), []), build_prompt(STAGE, job()))
        self.assertEqual(build_prompt(STAGE, job(), [{"name": "no-path"}]), build_prompt(STAGE, job()))


if __name__ == "__main__":
    unittest.main()
