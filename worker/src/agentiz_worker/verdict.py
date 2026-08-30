"""Machine-readable pass/fail read off a verdict stage's own answer.

Mirrors `layers/app-agentiz/lib/runVerdict.ts` byte-for-byte in marker format and regex — there is
no shared package between Python and TypeScript, so a change to the format has to touch both files
in the same commit. See `.ai-notes/machine-verdict-plan.md` for the design.

Used by `main.py: run_openhands` to decide whether the first answer already carries a usable
marker before spending the one fallback retry the plan allows.
"""

from __future__ import annotations

import re
from typing import NamedTuple

#: The worker's one fallback question when a verdict stage's first answer had no usable marker —
#: same wording the server's VERDICT_RETRY_PROMPT (runVerdict.ts) uses, so a person reading a run's
#: log sees one phrasing regardless of which side asked.
VERDICT_RETRY_PROMPT = (
    "Ответь одной строкой строго в формате `AGENTIZ_VERDICT: pass` или "
    "`AGENTIZ_VERDICT: fail — причина одной строкой`. Без вызовов инструментов, без остального текста."
)

# Line-anchored on purpose, same as the TS side: a reason with no explicit end-of-line cannot be
# captured, which is the chosen answer to "what happens with a multi-line reason" rather than
# silently swallowing the rest of the answer.
_VERDICT_LINE_RE = re.compile(
    r"AGENTIZ_VERDICT:\s*(pass|fail)\s*(?:[—-]\s*(.+?))?\s*$",
    re.IGNORECASE | re.MULTILINE,
)


class ExtractedVerdict(NamedTuple):
    verdict: str | None
    reason: str | None


def extract_verdict(text: str | None) -> ExtractedVerdict:
    """Last valid marker line wins, same rule as the TS `extractVerdict`. A line that looks like a
    marker but does not carry `pass`/`fail` verbatim is not a match at all — it is "corrupted" per
    the plan, not coerced to whichever word reads closest.
    """
    if not text:
        return ExtractedVerdict(None, None)
    matches = list(_VERDICT_LINE_RE.finditer(text))
    if not matches:
        return ExtractedVerdict(None, None)
    last = matches[-1]
    reason = (last.group(2) or "").strip() or None
    return ExtractedVerdict(last.group(1).lower(), reason)
