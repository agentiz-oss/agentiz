"""Usage telemetry of the harnesses installed on this machine.

Agentiz cannot pull these numbers: a Claude subscription's usage lives behind an OAuth token that
only exists on the worker's disk, so the server declares no `refresh()` for it and waits for a
push instead (see `app-agentiz-claude-limits`). This module is that push — one collector per
harness key, a report right after registration and one every `USAGE_REPORT_INTERVAL_SEC` after.

The worker deliberately **does not interpret** what it collects. Window names, percentages and
reset moments are provider vocabulary and belong to the server's provider layer, which the report
reaches as an opaque `raw` payload; a harness that changes its shape is then fixed in one place
and this file keeps working. Everything here is best-effort: a missing credential, an offline API
or a shape nobody recognizes must never touch the claim loop, so every failure is one warning
line and the next tick tries again.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

#: Default cadence of the reports. Fast enough that a 5-hour window's percentage is never badly
#: stale, slow enough to be invisible next to the 2-second claim poll.
USAGE_REPORT_INTERVAL_SEC = 120
#: The usage endpoint of the OAuth (subscription) regime, and the beta header it requires.
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_OAUTH_BETA = "oauth-2025-04-20"
USAGE_HTTP_TIMEOUT_SEC = 20


def claude_config_dir() -> Path:
    """Where Claude Code keeps its profile — `CLAUDE_CONFIG_DIR` wins, as it does for the CLI."""
    override = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".claude"


def claude_access_token() -> str | None:
    """The subscription's OAuth access token, or None when this machine has no usable one.

    Read-only on purpose: an expired token is skipped rather than refreshed. Refreshing would mean
    writing the credential store the CLI owns, and racing the CLI for it — the CLI renews the
    token by itself on its next run, and the next tick here picks the new one up.
    """
    path = claude_config_dir() / ".credentials.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict):
        return None
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token.strip():
        return None
    expires_at = oauth.get("expiresAt")
    # expiresAt is milliseconds since the epoch. An expired token would only earn a 401.
    if isinstance(expires_at, (int, float)) and expires_at / 1000 <= time.time():
        return None
    return token.strip()


def collect_claude() -> dict[str, Any] | None:
    """Claude's usage windows as the endpoint returns them, or None if unavailable here."""
    token = claude_access_token()
    if not token:
        return None
    request = Request(CLAUDE_USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "Accept": "application/json",
    })
    with urlopen(request, timeout=USAGE_HTTP_TIMEOUT_SEC) as response:
        payload = json.loads(response.read() or b"{}")
    return payload if isinstance(payload, dict) else None


#: Harness key (as the server derives it in `lib/harness.ts`) → collector. A collector returning
#: None means "this harness is not usable on this machine", and nothing is sent: reporting an
#: empty result would auto-create a binding and a subscription for a harness nobody runs here.
COLLECTORS: dict[str, Callable[[], dict[str, Any] | None]] = {
    "claude": collect_claude,
}


class UsageReporter:
    """Background loop that pushes every collector's payload to Agentiz.

    Runs beside the claim loop rather than inside it: the reports matter most exactly when this
    worker is claiming nothing because its subscription is spent.
    """

    def __init__(self, send: Callable[[str, dict[str, Any]], Any], interval_sec: int = USAGE_REPORT_INTERVAL_SEC) -> None:
        self._send = send
        self._interval = max(int(interval_sec), 10)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def report_once(self) -> int:
        """Collects and sends every harness this machine can report on. Returns how many went out."""
        sent = 0
        for harness_key, collect in COLLECTORS.items():
            try:
                raw = collect()
            except (HTTPError, URLError, OSError, ValueError) as error:
                print(f"usage: could not read {harness_key} usage: {error}", flush=True)
                continue
            if not raw:
                continue
            try:
                self._send(harness_key, raw)
                sent += 1
            except Exception as error:  # noqa: BLE001 - telemetry must never break the worker
                print(f"usage: could not report {harness_key} usage: {error}", flush=True)
        return sent

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="agentiz-usage", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.report_once()
            self._stop.wait(self._interval)
