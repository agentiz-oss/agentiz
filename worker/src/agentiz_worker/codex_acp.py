"""Launch the pinned Codex ACP adapter with Agentiz's form-elicitation capability.

``codex-acp`` is normally downloaded transiently by ``npx``.  Its App Server initialization
does not opt into Codex's ``openai/form`` extension, so Codex deliberately omits its built-in
``request_user_input`` tool even though Agentiz advertises ACP form elicitation.  This launcher
keeps a private, versioned copy of the adapter, applies the narrow upstream-compatible patch,
then replaces itself with Node while preserving ACP stdio.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp"
CODEX_ACP_VERSION = "1.1.14"
PATCH_REVISION = 3
PATCH_MARKER = ".agentiz-openai-form-elicitation.json"

_NEEDLE = "experimentalApi: true,\n        requestAttestation: false"
_REPLACEMENT = "experimentalApi: true,\n        requestAttestation: false,\n        mcpServerOpenaiFormElicitation: true"
_USER_INPUT_GUARD = "    if (!clientSupportsFormElicitation(this.clientCapabilities)) {\n      return { answers: {} };\n    }"
_USER_INPUT_REPLACEMENT = "    // Agentiz owns the ACP form client and installs its callback before this session starts."
_AUTO_RESOLUTION_GUARD = """    if (params.autoResolutionMs === null) {
      return await this.connection.request(
        methods.client.elicitation.create,
        request,
        this.requestOptions()
      );
    }"""
_AUTO_RESOLUTION_REPLACEMENT = """    // Agentiz questions must remain open until the person responds.  Codex's default
    // auto-resolution timer is suitable for interactive terminals, but would otherwise let the
    // ACP turn finish while Agentiz is still waiting for the answer.
    return await this.connection.request(
      methods.client.elicitation.create,
      request,
      this.requestOptions()
    );"""


class CodexAcpPatchError(RuntimeError):
    """The downloaded adapter did not match the version Agentiz reviewed."""


def patch_openai_form_elicitation(adapter_entry: Path) -> None:
    """Add Codex's form-extension opt-in, failing closed on an unknown adapter build."""
    source = adapter_entry.read_text(encoding="utf-8")
    if _REPLACEMENT in source and _USER_INPUT_REPLACEMENT in source and _AUTO_RESOLUTION_REPLACEMENT in source:
        return
    if (
        source.count(_NEEDLE) != 1
        or source.count(_USER_INPUT_GUARD) != 1
        or source.count(_AUTO_RESOLUTION_GUARD) != 1
    ):
        raise CodexAcpPatchError(
            f"{adapter_entry} is not the expected {CODEX_ACP_PACKAGE}@{CODEX_ACP_VERSION} build; refusing to patch it"
        )
    adapter_entry.write_text(
        source.replace(_NEEDLE, _REPLACEMENT, 1)
        .replace(_USER_INPUT_GUARD, _USER_INPUT_REPLACEMENT, 1)
        .replace(_AUTO_RESOLUTION_GUARD, _AUTO_RESOLUTION_REPLACEMENT, 1),
        encoding="utf-8",
    )


def cache_root() -> Path:
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return root / "agentiz-worker" / "codex-acp" / f"{CODEX_ACP_VERSION}-agentiz-{PATCH_REVISION}"


def adapter_entry(root: Path) -> Path:
    return root / "node_modules" / "@agentclientprotocol" / "codex-acp" / "dist" / "index.js"


def _ready(root: Path) -> bool:
    entry = adapter_entry(root)
    marker = root / PATCH_MARKER
    if not entry.is_file() or not marker.is_file():
        return False
    try:
        return json.loads(marker.read_text(encoding="utf-8")) == {
            "package": CODEX_ACP_PACKAGE,
            "version": CODEX_ACP_VERSION,
            "patchRevision": PATCH_REVISION,
        }
    except (OSError, ValueError):
        return False


def prepare_adapter() -> Path:
    """Install and patch the private adapter cache once, without modifying npm's cache."""
    destination = cache_root()
    if _ready(destination):
        return adapter_entry(destination)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="codex-acp-", dir=destination.parent))
    try:
        install = subprocess.run(
            [
                "npm", "install", "--prefix", str(temporary), "--ignore-scripts", "--no-audit", "--no-fund",
                f"{CODEX_ACP_PACKAGE}@{CODEX_ACP_VERSION}",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if install.returncode:
            raise CodexAcpPatchError(f"Could not install {CODEX_ACP_PACKAGE}@{CODEX_ACP_VERSION}: {install.stdout.strip()}")
        entry = adapter_entry(temporary)
        if not entry.is_file():
            raise CodexAcpPatchError(f"npm did not install {CODEX_ACP_PACKAGE}@{CODEX_ACP_VERSION} as expected")
        patch_openai_form_elicitation(entry)
        (temporary / PATCH_MARKER).write_text(json.dumps({
            "package": CODEX_ACP_PACKAGE,
            "version": CODEX_ACP_VERSION,
            "patchRevision": PATCH_REVISION,
        }) + "\n", encoding="utf-8")

        # A second worker process may have populated the cache while npm was running.  Its
        # complete marker wins; otherwise keep the temporary directory for a clear retry rather
        # than deleting an unexpected existing path.
        if _ready(destination):
            return adapter_entry(destination)
        if destination.exists():
            raise CodexAcpPatchError(f"Adapter cache {destination} exists but is incomplete; remove that exact directory and retry")
        temporary.rename(destination)
        return adapter_entry(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    entry = prepare_adapter()
    os.execvp("node", ["node", str(entry), *sys.argv[1:]])


if __name__ == "__main__":
    main()
