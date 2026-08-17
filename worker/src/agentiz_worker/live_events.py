"""Live run-log events: produced on the agent's thread, sent from a background one.

`ACPAgent` calls its event callback synchronously, from the portal thread that parses ACP
`session_update` notifications. `Client.post` is a blocking `urlopen` with a 70 s timeout, so
posting from that callback stops the agent's turn for as long as Agentiz takes to answer — and on
a slow server it can break the turn outright. Everything reported *while* a stage is running
therefore goes into a queue that one sender thread drains, numbers and posts in batches.

Batching is what keeps the number of requests flat: the events endpoint already accepts an array,
so a burst of tool calls costs one POST rather than one per call.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from typing import Any, Callable

#: How long the sender waits for the first event of a batch before re-checking for shutdown.
LIVE_FLUSH_INTERVAL_SEC = 1.0
#: Upper bound on one POST body. A burst larger than this simply goes out as several batches.
LIVE_MAX_BATCH = 50
#: A backlog this deep means the server is not keeping up; further progress lines are dropped
#: rather than allowed to grow without bound inside a worker process.
LIVE_MAX_QUEUE = 2000
#: How long a terminal POST is willing to wait for the queue to empty.
LIVE_FLUSH_TIMEOUT_SEC = 10.0


class SequenceCounter:
    """Event numbering shared by the job thread and the live sender.

    The server dedups by `eventId` and only tracks the highest number it has seen, so numbers must
    be unique but need not be perfectly ordered between the two threads. A bare `+= 1` from both
    threads is what would hand out the same number twice, and is the only thing this prevents.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    def next(self) -> int:
        with self._lock:
            self._value += 1
            return self._value


class LiveEventStream:
    """Queue + sender thread for events that must not block the thread that produced them.

    [send] receives a ready list of event dicts (the caller owns the transport), [sequence] is the
    same counter the synchronous emits use, and [redact] is applied here rather than at the call
    site so a message never sits in the queue with a token still in it.
    """

    def __init__(
        self,
        send: Callable[[list[dict[str, Any]]], None],
        sequence: SequenceCounter,
        redact: Callable[[str], str],
        on_error: Callable[[Exception], None] | None = None,
        max_batch: int = LIVE_MAX_BATCH,
        flush_interval: float = LIVE_FLUSH_INTERVAL_SEC,
        max_queue: int = LIVE_MAX_QUEUE,
    ) -> None:
        self._send = send
        self._sequence = sequence
        self._redact = redact
        self._on_error = on_error
        self._max_batch = max_batch
        self._flush_interval = flush_interval
        self._queue: queue.Queue[tuple[str, str | None, str, str]] = queue.Queue(maxsize=max_queue)
        self._stop = threading.Event()
        # Starts set: nothing is queued yet, and `drain` must not wait 10 s for a sender thread
        # that has been scheduled but has not had its first turn on the CPU.
        self._idle = threading.Event()
        self._idle.set()
        self._thread = threading.Thread(target=self._pump, name="agentiz-live-events", daemon=True)
        self.dropped = 0

    def start(self) -> "LiveEventStream":
        self._thread.start()
        return self

    def emit(self, kind: str, stage_id: str | None, message: str, level: str = "info") -> None:
        """Queue one live event. Never raises and never waits — this runs on the agent's thread."""
        if self._stop.is_set():
            return
        try:
            self._queue.put_nowait((kind, stage_id, message, level))
        except queue.Full:
            self.dropped += 1

    def drain(self, timeout: float = LIVE_FLUSH_TIMEOUT_SEC) -> bool:
        """Wait for the backlog to go out, without closing the stream.

        Used before a milestone that is posted inline (`stage.completed`), so the stage's last tool
        line is not written after the line saying the stage finished. Best effort by design — the
        ordering is cosmetic, and a slow server must not hold up the next stage. `flush` is the one
        that guarantees delivery, because it joins the thread.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._queue.empty() and self._idle.is_set():
                return True
            time.sleep(0.02)
        return False

    def flush(self, timeout: float = LIVE_FLUSH_TIMEOUT_SEC) -> None:
        """Send what is queued, then stop accepting more.

        Called before every terminal POST: a log line that lands after the run's result reads as
        garbage at the end of the run. Idempotent, so the failure path may call it again.
        """
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def _pump(self) -> None:
        while True:
            batch = self._drain()
            if batch:
                try:
                    self._send(batch)
                except Exception as error:
                    # A progress line is not worth failing a job over: report and keep draining.
                    self.dropped += len(batch)
                    if self._on_error:
                        self._on_error(error)
            elif self._stop.is_set():
                return

    def _drain(self) -> list[dict[str, Any]]:
        """First event blocking (so a lone event goes out at once), the rest whatever is already
        waiting — which is what turns a burst into one request."""
        stopping = self._stop.is_set()
        items: list[tuple[str, str | None, str, str]] = []
        try:
            # Idle only spans the wait for the first event: anything already taken from the queue
            # counts as in flight, which is what `drain` needs it to mean.
            self._idle.set()
            items.append(self._queue.get_nowait() if stopping else self._queue.get(timeout=self._flush_interval))
        except queue.Empty:
            return []
        finally:
            if items:
                self._idle.clear()
        while len(items) < self._max_batch:
            try:
                items.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return [self._event(*item) for item in items]

    def _event(self, kind: str, stage_id: str | None, message: str, level: str) -> dict[str, Any]:
        return {
            "eventId": str(uuid.uuid4()),
            "sequence": self._sequence.next(),
            "type": kind,
            "stageExecutionId": stage_id,
            "level": level,
            "message": self._redact(message),
        }
