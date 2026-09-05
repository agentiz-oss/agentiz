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
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
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
#: Token endpoint and public client id of Claude Code's own OAuth app, as the CLI itself uses
#: them. Refreshing with any other client id is rejected.
CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
#: The token endpoint answers 403 to an unrecognized client, so identify as the CLI whose
#: credential this is — a bare urllib User-Agent is refused before the body is even looked at.
CLAUDE_TOKEN_USER_AGENT = "claude-cli/2.1.196 (external, cli)"
#: Refresh this long before the token actually expires, so a report is never sent with a
#: credential that dies mid-flight.
TOKEN_EXPIRY_SKEW_SEC = 60


def claude_config_dir() -> Path:
    """Where Claude Code keeps its profile — `CLAUDE_CONFIG_DIR` wins, as it does for the CLI."""
    override = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".claude"


def claude_credentials_path() -> Path:
    return claude_config_dir() / ".credentials.json"


def _read_claude_oauth() -> dict[str, Any] | None:
    """The `claudeAiOauth` block of the credential store, or None if unreadable."""
    try:
        data = json.loads(claude_credentials_path().read_text())
    except (OSError, json.JSONDecodeError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    return oauth if isinstance(oauth, dict) else None


def _is_expired(oauth: dict[str, Any]) -> bool:
    """True when the access token is gone or about to be. `expiresAt` is epoch milliseconds."""
    expires_at = oauth.get("expiresAt")
    if not isinstance(expires_at, (int, float)):
        return False
    return expires_at / 1000 <= time.time() + TOKEN_EXPIRY_SKEW_SEC


def _persist_refreshed_token(payload: dict[str, Any], used_refresh_token: str) -> str | None:
    """Writes a refresh result back into the store the CLI owns, or gives up quietly.

    Two things make this safe to do next to a running CLI. It is a compare-and-swap: the file is
    re-read at the last moment and the write is abandoned if the stored refresh token is no
    longer the one this refresh consumed — that means the CLI refreshed first, and its result is
    the newer one. And the write is atomic (`os.replace` of a 0600 temp file in the same
    directory), so a reader never sees a half-written credential store.
    """
    token = payload.get("access_token")
    if not isinstance(token, str) or not token.strip():
        return None
    path = claude_credentials_path()
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or oauth.get("refreshToken") != used_refresh_token:
        return None

    oauth["accessToken"] = token.strip()
    # The server may rotate the refresh token; losing the rotated one would log the CLI out.
    if isinstance(payload.get("refresh_token"), str) and payload["refresh_token"].strip():
        oauth["refreshToken"] = payload["refresh_token"].strip()
    if isinstance(payload.get("expires_in"), (int, float)):
        oauth["expiresAt"] = int((time.time() + float(payload["expires_in"])) * 1000)
    if isinstance(payload.get("scope"), str) and payload["scope"].strip():
        oauth["scopes"] = payload["scope"].split()
    if isinstance(payload.get("refresh_token_expires_in"), (int, float)):
        oauth["refreshTokenExpiresAt"] = int((time.time() + float(payload["refresh_token_expires_in"])) * 1000)

    temporary = path.with_name(f"{path.name}.agentiz-{os.getpid()}")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle)
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        return None
    return oauth["accessToken"]


def refresh_claude_token(oauth: dict[str, Any]) -> str | None:
    """Exchanges the stored refresh token for a live access token, and stores the result.

    The CLI only refreshes when it is about to call the API, so a machine that runs no agent for
    a while sits on a dead token — exactly the stretch where the operator most wants to know how
    much of the subscription is left. Reporting therefore renews the credential itself, using
    Claude Code's own token endpoint and public client id, and hands the renewed one back to the
    CLI through the shared store.
    """
    if os.environ.get("AGENTIZ_CLAUDE_TOKEN_REFRESH", "").lower() in {"0", "false", "off"}:
        return None
    refresh_token = oauth.get("refreshToken")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        return None
    scopes = oauth.get("scopes")
    body = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token.strip(),
        "client_id": CLAUDE_CLIENT_ID,
    }
    if isinstance(scopes, list) and scopes:
        body["scope"] = " ".join(str(scope) for scope in scopes)
    request = Request(CLAUDE_TOKEN_URL, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": CLAUDE_TOKEN_USER_AGENT,
    })
    with urlopen(request, timeout=USAGE_HTTP_TIMEOUT_SEC) as response:
        payload = json.loads(response.read() or b"{}")
    if not isinstance(payload, dict):
        return None
    return _persist_refreshed_token(payload, refresh_token.strip())


def claude_access_token() -> str | None:
    """A live OAuth access token for the subscription, refreshing it first if it has expired."""
    oauth = _read_claude_oauth()
    if oauth is None:
        return None
    token = oauth.get("accessToken")
    has_token = isinstance(token, str) and bool(token.strip())
    if has_token and not _is_expired(oauth):
        return token.strip()
    refreshed = refresh_claude_token(oauth)
    if refreshed:
        return refreshed
    # A refresh that produced nothing usually means the CLI refreshed concurrently; its result is
    # on disk, so re-read once before giving up.
    current = _read_claude_oauth()
    if current is not None and not _is_expired(current):
        token = current.get("accessToken")
        if isinstance(token, str) and token.strip():
            return token.strip()
    return None


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

#: How long one poke may take, and how often one may run. The server keeps asking while its
#: telemetry shows no open window, so the throttle only caps the cost of a poke that silently
#: fails to open one.
POKE_TIMEOUT_SEC = 180
POKE_MIN_INTERVAL_SEC = 600
#: The server stores the reason as a diagnosis, not as a log — see AgentCapacityService.
POKE_ERROR_MAX_LENGTH = 300

#: Explicit location of the Claude Code CLI, for an installation none of the guesses below finds.
CLAUDE_BIN_ENV = "AGENTIZ_CLAUDE_BIN"
#: Where that CLI actually lands when a person installs it the usual way. Looked at only after
#: PATH, and it exists because PATH is the wrong question for a daemon: systemd hands a service a
#: minimal PATH of its own, so `~/.local/bin` — the CLI's own default target — is invisible to the
#: worker even on a machine where `claude` works perfectly for its owner. That is exactly how the
#: poke failed with `[Errno 2] No such file or directory: 'claude'` every throttle interval while
#: nothing else on the worker noticed (the ACP stages reach their harness through `npx`).
CLAUDE_BIN_FALLBACKS = (
    "~/.local/bin/claude",
    "~/bin/claude",
    "~/.claude/local/claude",
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
)


def claude_cli_path() -> str | None:
    """Absolute path of the Claude Code CLI, or None if this machine has none."""
    override = os.environ.get(CLAUDE_BIN_ENV, "").strip()
    # An explicit setting is used as given: a wrong one has to fail loudly, not be guessed around.
    if override:
        return override
    found = shutil.which("claude")
    if found:
        return found
    for candidate in CLAUDE_BIN_FALLBACKS:
        path = Path(candidate).expanduser()
        if os.access(path, os.X_OK):
            return str(path)
    return None


@dataclass(frozen=True)
class PokeOutcome:
    """What came of one poke. The reason travels back to the server on the next report, so it has
    to be one short human line rather than a traceback — see `UsageReporter._send_report`."""

    ok: bool
    error: str | None = None


def poke_claude() -> PokeOutcome:
    """Opens a session window with the cheapest possible request: one word to the smallest model,
    through the CLI that owns the credential. Sent when the server answers a usage report with
    `openWindow` — its reset-alignment logic wants the window's 5 hours to start now (see the
    server's `lib/harnessAlign.ts`). Best-effort like everything in this module: a failure is one
    warning line and the server simply asks again on a later report.
    """
    cli = claude_cli_path()
    if cli is None:
        message = ("no claude CLI found — looked at PATH, "
                   f"${CLAUDE_BIN_ENV} and {', '.join(CLAUDE_BIN_FALLBACKS)}")
        print(f"usage: window poke {message}", flush=True)
        return PokeOutcome(False, message)
    try:
        result = subprocess.run(
            [cli, "-p", "ok", "--model", "haiku"],
            cwd=str(Path.home()),
            capture_output=True,
            text=True,
            timeout=POKE_TIMEOUT_SEC,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"usage: window poke could not run {cli}: {error}", flush=True)
        return PokeOutcome(False, f"could not run {cli}: {error}")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        last = detail[-1] if detail else ""
        print(f"usage: window poke exited {result.returncode}: {last}", flush=True)
        return PokeOutcome(False, f"{cli} exited {result.returncode}: {last}"[:POKE_ERROR_MAX_LENGTH])
    return PokeOutcome(True)


#: Harness key → the request that opens its session window. Only harnesses with a poker can be
#: reset-aligned when idle; the rest ignore `openWindow` and lose nothing else.
POKERS: dict[str, Callable[[], PokeOutcome]] = {
    "claude": poke_claude,
}


class UsageReporter:
    """Background loop that pushes every collector's payload to Agentiz.

    Runs beside the claim loop rather than inside it: the reports matter most exactly when this
    worker is claiming nothing because its subscription is spent.
    """

    def __init__(self, send: Callable[..., Any], interval_sec: int = USAGE_REPORT_INTERVAL_SEC) -> None:
        self._send = send
        self._interval = max(int(interval_sec), 10)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_poke_at: dict[str, float] = {}
        self._pending_poke: dict[str, dict[str, Any]] = {}

    def _send_report(self, harness_key: str, raw: dict[str, Any]) -> Any:
        """One report, carrying what the last poke did.

        The outcome rides the next report instead of a channel of its own: the server asked for the
        poke through a report's response, so this is the same conversation, and a machine that
        cannot open a window is exactly a machine whose telemetry keeps arriving. A send that fails
        re-arms the outcome for the following tick — the server must not lose the only evidence
        that its request was carried out or refused.
        """
        poke = self._pending_poke.pop(harness_key, None)
        try:
            return self._send(harness_key, raw, poke)
        except Exception:
            if poke is not None:
                self._pending_poke[harness_key] = poke
            raise

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
                response = self._send_report(harness_key, raw)
                sent += 1
            except Exception as error:  # noqa: BLE001 - telemetry must never break the worker
                print(f"usage: could not report {harness_key} usage: {error}", flush=True)
                continue
            if isinstance(response, dict) and response.get("openWindow"):
                self._maybe_poke(harness_key)
        return sent

    def _maybe_poke(self, harness_key: str) -> None:
        """Answers the server's `openWindow` by opening a session window, then re-reports right
        away so the server sees the window it asked for and stops asking. Throttled locally: a
        poke that fails to move the telemetry must not turn into one request per report tick.
        """
        poker = POKERS.get(harness_key)
        if poker is None:
            return
        now = time.monotonic()
        last = self._last_poke_at.get(harness_key)
        if last is not None and now - last < POKE_MIN_INTERVAL_SEC:
            return
        self._last_poke_at[harness_key] = now
        outcome = poker()
        self._pending_poke[harness_key] = {
            "ok": outcome.ok,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            **({"error": outcome.error} if outcome.error else {}),
        }
        if not outcome.ok:
            return
        print(f"usage: opened a {harness_key} session window on server request", flush=True)
        collect = COLLECTORS.get(harness_key)
        try:
            raw = collect() if collect else None
            if raw:
                self._send_report(harness_key, raw)
        except Exception as error:  # noqa: BLE001 - telemetry must never break the worker
            print(f"usage: could not re-report {harness_key} usage after poke: {error}", flush=True)

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
