"""Keeps issued credentials out of everything the worker sends back to Agentiz.

The token reaches this process legitimately — it is needed to clone — but it must not reach the run
log, the stage summaries or an error message, because those are stored forever and shown in the
admin panel. Every string leaving the worker goes through `redact`.
"""

from __future__ import annotations

from typing import Iterable

MASK = "***"
#: Anything shorter is too likely to occur in ordinary text; masking it would turn output into
#: confetti and hide the very errors this is supposed to keep readable.
MIN_SECRET_LENGTH = 8


class Redactor:
    """Holds the secrets of one job. Cheap to build, safe to call on every string."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets: list[str] = []
        for secret in secrets:
            self.add(secret)

    def add(self, secret: str | None) -> None:
        value = (secret or "").strip()
        if len(value) >= MIN_SECRET_LENGTH and value not in self._secrets:
            self._secrets.append(value)

    def __call__(self, text: str | None) -> str:
        return redact(text, self._secrets)


def redact(text: str | None, secrets: Iterable[str]) -> str:
    if not text:
        return text or ""
    result = text
    for secret in secrets:
        value = (secret or "").strip()
        if len(value) < MIN_SECRET_LENGTH:
            continue
        result = result.replace(value, MASK)
    return result
