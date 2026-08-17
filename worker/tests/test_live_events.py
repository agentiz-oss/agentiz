from __future__ import annotations

import threading
import unittest

from agentiz_worker.live_events import LiveEventStream, SequenceCounter
from agentiz_worker.main import MAX_TOOL_TITLE_CHARS, tool_call_progress


class ACPToolCallEvent:
    """Stand-in for the SDK class: the worker matches it by name, so a name is all it needs."""

    def __init__(self, tool_call_id: str, title: str, status: str | None = None, tool_kind: str | None = None) -> None:
        self.tool_call_id = tool_call_id
        self.title = title
        self.status = status
        self.tool_kind = tool_kind
        self.source = "agent"


class MessageEvent:
    def __init__(self) -> None:
        self.source = "agent"


class ToolCallProgressTest(unittest.TestCase):
    def test_key_changes_with_status_so_repeats_collapse(self) -> None:
        first = tool_call_progress(ACPToolCallEvent("call-1", "Read src/main.py", "pending"))
        again = tool_call_progress(ACPToolCallEvent("call-1", "Read src/main.py", "pending"))
        later = tool_call_progress(ACPToolCallEvent("call-1", "Read src/main.py", "completed"))
        assert first and again and later
        self.assertEqual(first[0], again[0])
        self.assertNotEqual(first[0], later[0])
        self.assertEqual(first[1], "Read src/main.py — pending")
        self.assertEqual(later[1], "Read src/main.py — completed")

    def test_missing_status_still_produces_a_line(self) -> None:
        progress = tool_call_progress(ACPToolCallEvent("call-2", "Bash", None))
        assert progress
        self.assertEqual(progress, ("call-2:started", "Bash — started"))

    def test_titleless_call_falls_back_to_its_kind(self) -> None:
        progress = tool_call_progress(ACPToolCallEvent("call-3", "", "in_progress", tool_kind="execute"))
        assert progress
        self.assertEqual(progress[1], "execute — in_progress")

    def test_long_title_is_capped(self) -> None:
        progress = tool_call_progress(ACPToolCallEvent("call-4", "x" * 5_000, "pending"))
        assert progress
        self.assertLessEqual(len(progress[1]), MAX_TOOL_TITLE_CHARS + len("… — pending"))

    def test_other_events_are_not_tool_calls(self) -> None:
        self.assertIsNone(tool_call_progress(MessageEvent()))
        self.assertIsNone(tool_call_progress(object()))


class SequenceCounterTest(unittest.TestCase):
    def test_two_threads_never_get_the_same_number(self) -> None:
        counter = SequenceCounter()
        seen: list[int] = []
        lock = threading.Lock()

        def take() -> None:
            for _ in range(500):
                value = counter.next()
                with lock:
                    seen.append(value)

        threads = [threading.Thread(target=take) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(seen), 1_000)
        self.assertEqual(sorted(seen), list(range(1, 1_001)))


class LiveEventStreamTest(unittest.TestCase):
    def setUp(self) -> None:
        self.batches: list[list[dict]] = []
        self.lock = threading.Lock()

    def record(self, events: list[dict]) -> None:
        with self.lock:
            self.batches.append(events)

    def stream(self, sequence: SequenceCounter | None = None, **kwargs) -> LiveEventStream:
        stream = LiveEventStream(self.record, sequence or SequenceCounter(), lambda text: text, **kwargs)
        self.addCleanup(stream.flush)
        return stream.start()

    def sent(self) -> list[dict]:
        with self.lock:
            return [event for batch in self.batches for event in batch]

    def test_flush_sends_everything_queued(self) -> None:
        stream = self.stream()
        for index in range(5):
            stream.emit("stage.tool", "stage-1", f"line {index}", level="debug")
        stream.flush(timeout=5)
        events = self.sent()
        self.assertEqual([event["message"] for event in events], [f"line {index}" for index in range(5)])
        self.assertTrue(all(event["level"] == "debug" and event["stageExecutionId"] == "stage-1" for event in events))

    def test_nothing_is_emitted_after_a_flush(self) -> None:
        stream = self.stream()
        stream.flush(timeout=5)
        stream.emit("stage.tool", None, "too late")
        self.assertEqual(self.sent(), [])

    def test_numbering_is_shared_with_synchronous_emits(self) -> None:
        sequence = SequenceCounter()
        stream = self.stream(sequence)
        stream.emit("stage.tool", None, "live")
        stream.flush(timeout=5)
        numbers = [event["sequence"] for event in self.sent()] + [sequence.next()]
        self.assertEqual(len(set(numbers)), len(numbers))

    def test_a_burst_travels_as_batches_not_one_request_each(self) -> None:
        # The sender is blocked until `release`, so everything queues up behind one in-flight POST.
        release = threading.Event()
        first = threading.Event()

        def blocking(events: list[dict]) -> None:
            self.record(events)
            if not first.is_set():
                first.set()
                release.wait(5)

        stream = LiveEventStream(blocking, SequenceCounter(), lambda text: text, max_batch=50)
        self.addCleanup(stream.flush)
        stream.start()
        stream.emit("stage.tool", None, "first")
        first.wait(5)
        for index in range(40):
            stream.emit("stage.tool", None, f"queued {index}")
        release.set()
        stream.flush(timeout=5)
        with self.lock:
            self.assertLess(len(self.batches), 41)
        self.assertEqual(len(self.sent()), 41)

    def test_a_failing_post_does_not_stop_the_sender(self) -> None:
        attempts: list[int] = []
        tried = threading.Event()

        def flaky(events: list[dict]) -> None:
            attempts.append(len(events))
            if len(attempts) == 1:
                tried.set()
                raise RuntimeError("server said no")
            self.record(events)

        errors: list[Exception] = []
        stream = LiveEventStream(flaky, SequenceCounter(), lambda text: text, on_error=errors.append)
        self.addCleanup(stream.flush)
        stream.start()
        stream.emit("stage.tool", None, "lost")
        tried.wait(5)
        stream.emit("stage.tool", None, "kept")
        stream.flush(timeout=5)
        self.assertEqual([event["message"] for event in self.sent()], ["kept"])
        self.assertEqual(len(errors), 1)
        self.assertEqual(stream.dropped, 1)

    def test_a_full_queue_drops_rather_than_blocking_the_agent(self) -> None:
        release = threading.Event()

        def blocking(events: list[dict]) -> None:
            release.wait(5)
            self.record(events)

        stream = LiveEventStream(blocking, SequenceCounter(), lambda text: text, max_queue=2)
        self.addCleanup(lambda: (release.set(), stream.flush()))
        stream.start()
        for index in range(50):
            stream.emit("stage.tool", None, f"line {index}")
        self.assertGreater(stream.dropped, 0)

    def test_drain_waits_for_the_backlog_but_keeps_the_stream_open(self) -> None:
        stream = self.stream()
        for index in range(5):
            stream.emit("stage.tool", None, f"line {index}")
        self.assertTrue(stream.drain(timeout=5))
        self.assertEqual(len(self.sent()), 5)
        stream.emit("stage.tool", None, "after the drain")
        stream.flush(timeout=5)
        self.assertEqual(self.sent()[-1]["message"], "after the drain")

    def test_drain_gives_up_rather_than_holding_up_the_next_stage(self) -> None:
        release = threading.Event()

        def blocking(events: list[dict]) -> None:
            release.wait(5)
            self.record(events)

        stream = LiveEventStream(blocking, SequenceCounter(), lambda text: text)
        self.addCleanup(lambda: (release.set(), stream.flush()))
        stream.start()
        stream.emit("stage.tool", None, "stuck")
        self.assertFalse(stream.drain(timeout=0.3))

    def test_messages_are_redacted_by_the_sender(self) -> None:
        stream = LiveEventStream(self.record, SequenceCounter(), lambda text: text.replace("secret", "***"))
        self.addCleanup(stream.flush)
        stream.start()
        stream.emit("stage.tool", None, "Bash git push https://secret@host")
        stream.flush(timeout=5)
        self.assertEqual(self.sent()[0]["message"], "Bash git push https://***@host")


if __name__ == "__main__":
    unittest.main()
