"""Stage-0 Agentiz worker: authenticated API transport plus OpenHands ACP execution.

`host` passes a local directory directly to Conversation. `docker` replaces that workspace
with DockerWorkspace; OpenHands owns Agent Server startup, readiness and teardown in its context
manager. No worker code talks to Agentiz's database or invokes `docker run` itself.

The directory is normally the worker's own managed workspace. A job may instead carry a
`workspace` block, which means its pipeline is configured to work in a prepared directory on this
machine — that job is only ever handed to this worker, and the directory must already exist.
"""

from __future__ import annotations

import argparse
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import os
import shutil
import socket
import subprocess
import shlex
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .changes import collect_changes
from .harness_usage import USAGE_REPORT_INTERVAL_SEC, UsageReporter
from .hooks import run_hook
from .interactions import HumanInteractionBroker, install_acp_human_input
from .live_events import LiveEventStream, SequenceCounter
from .redaction import Redactor
from .repository import prepare_checkout
from .workspace_git import finalize_action, guard_workspace, preflight as workspace_git_preflight, record_tree, run_action

SCHEMA_VERSION = 1
HEARTBEAT_INTERVAL_SEC = 20
DEFAULT_API_URL = "https://agentiz.m42.cx/api/agentiz/worker/v1"
DEFAULT_SERVER_IMAGE = ""
CONFIG_VERSION = 1


class WorkerError(RuntimeError):
    pass


def usage_interval(profile_value: Any) -> int:
    """Usage report cadence: env wins over the profile, both fall back to the default, 0 = off."""
    for candidate in (os.environ.get("AGENTIZ_USAGE_REPORT_INTERVAL_SEC"), profile_value):
        if candidate is None or candidate == "":
            continue
        try:
            return max(int(candidate), 0)
        except (TypeError, ValueError):
            continue
    return USAGE_REPORT_INTERVAL_SEC


@dataclass(frozen=True)
class Settings:
    api_url: str
    token: str
    instance_id: str
    workspace: Path
    server_image: str
    once: bool
    #: Leaves the job directory behind when something failed, for post-mortem. Off by default and
    #: not meant for production: checkouts contain the customer's source tree.
    keep_workspace_on_failure: bool = False
    #: Seconds between harness usage reports; 0 turns the reporter off entirely.
    usage_report_interval_sec: int = USAGE_REPORT_INTERVAL_SEC

    @classmethod
    def from_mapping(cls, data: dict[str, Any], once: bool) -> "Settings":
        api_url = str(data.get("apiUrl", "")).rstrip("/")
        token = str(data.get("token", ""))
        if not api_url or not token:
            raise WorkerError("Worker profile must contain apiUrl and token; run `agentiz-worker configure`")
        image = str(data.get("serverImage", ""))
        if image and "@sha256:" not in image:
            raise WorkerError("serverImage must be pinned by @sha256 digest")
        workspace = Path(str(data.get("workspace", ""))).expanduser().resolve()
        if not str(data.get("workspace", "")):
            raise WorkerError("Worker profile must contain workspace; run `agentiz-worker configure`")
        return cls(api_url, token, str(data.get("instanceId") or f"agentiz-{socket.gethostname()}"), workspace, image, once,
                   os.environ.get("AGENTIZ_KEEP_WORKSPACE_ON_FAILURE", "").lower() == "true",
                   usage_interval(data.get("usageReportIntervalSec")))

    @classmethod
    def from_env(cls, once: bool) -> "Settings":
        """Compatibility path for pre-profile deployments only."""
        api_url = os.environ.get("AGENTIZ_WORKER_API_URL", "").rstrip("/")
        token = os.environ.get("AGENTIZ_WORKER_TOKEN", "")
        if not api_url or not token:
            raise WorkerError("AGENTIZ_WORKER_API_URL and AGENTIZ_WORKER_TOKEN are required")
        # A digest is compulsory: the plan explicitly prohibits a mutable `latest` image.
        image = os.environ.get("AGENTIZ_OPENHANDS_SERVER_IMAGE", "")
        if image and "@sha256:" not in image:
            raise WorkerError("AGENTIZ_OPENHANDS_SERVER_IMAGE must be pinned by @sha256 digest")
        return cls(api_url, token, os.environ.get("AGENTIZ_WORKER_ID", f"dev-{socket.gethostname()}"),
                   Path(os.environ.get("AGENTIZ_WORKER_WORKSPACE", os.getcwd())).resolve(), image, once,
                   os.environ.get("AGENTIZ_KEEP_WORKSPACE_ON_FAILURE", "").lower() == "true",
                   usage_interval(None))


def default_config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "agentiz" / "worker.json"


def default_workspace_path() -> Path:
    return Path.home() / ".local" / "share" / "agentiz-worker" / "workspace"


def worker_version() -> str:
    """Version announced to Agentiz on every registration.

    An installed wheel normally has no .git directory, so a release pipeline can set
    AGENTIZ_WORKER_COMMIT in the optional profile .env file. Local editable installations derive
    the commit from their checkout automatically.
    """
    try:
        release = package_version("agentiz-worker")
    except PackageNotFoundError:
        release = "dev"
    commit = os.environ.get("AGENTIZ_WORKER_COMMIT", "").strip()
    if not commit:
        checkout = Path(__file__).resolve().parents[2]
        try:
            commit = subprocess.run(
                ["git", "-C", str(checkout), "rev-parse", "--short=12", "HEAD"],
                check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2,
            ).stdout.strip()
        except (FileNotFoundError, subprocess.SubprocessError):
            commit = "unknown"
    return f"agentiz-worker/{release}+{commit}"[:50]


def load_settings(config_path: Path, once: bool) -> Settings:
    if config_path.is_file():
        try:
            return Settings.from_mapping(json.loads(config_path.read_text()), once)
        except json.JSONDecodeError as error:
            raise WorkerError(f"Invalid worker profile {config_path}: {error}") from error
    # Keeping this fallback makes an existing systemd deployment continue to work after upgrade.
    if os.environ.get("AGENTIZ_WORKER_API_URL") or os.environ.get("AGENTIZ_WORKER_TOKEN"):
        return Settings.from_env(once)
    raise WorkerError(f"Worker profile not found: {config_path}. Run `agentiz-worker configure`.")


def api_url_for(server: str) -> str:
    server = server.strip().rstrip("/")
    if not server.startswith(("https://", "http://")):
        raise WorkerError("Server URL must begin with https:// or http://")
    suffix = "/api/agentiz/worker/v1"
    return server if server.endswith(suffix) else f"{server}{suffix}"


def prompt_value(label: str, default: str | None = None, secret: bool = False) -> str:
    hint = f" [{default}]" if default else ""
    reader = __import__("getpass").getpass if secret else input
    value = reader(f"{label}{hint}: ").strip()
    return value or (default or "")


def configure(config_path: Path) -> None:
    if not sys.stdin.isatty():
        raise WorkerError("`configure` needs an interactive terminal")
    print("Выберите сервер:")
    print(f"  1) Agentiz production ({DEFAULT_API_URL})")
    print("  2) Свой сервер")
    choice = prompt_value("Номер", "1")
    if choice == "1":
        api_url = DEFAULT_API_URL
    elif choice == "2":
        api_url = api_url_for(prompt_value("Адрес сервера"))
    else:
        raise WorkerError("Choose 1 or 2")
    print(f"\nСоздайте воркер в панели: {api_url.rsplit('/api/', 1)[0]}/dashboard")
    print("Панель покажет одноразовый токен. Вставьте его ниже (не ID воркера).")
    token = prompt_value("Токен воркера", secret=True)
    if not token:
        raise WorkerError("Worker token is required")
    # Stage-0 host execution still needs a local directory. It is an implementation detail of the
    # worker, not an onboarding decision: create a private managed directory automatically.
    workspace = default_workspace_path()
    workspace.mkdir(parents=True, exist_ok=True)
    image = prompt_value("OpenHands image digest (необязательно)", DEFAULT_SERVER_IMAGE)
    if image and "@sha256:" not in image:
        raise WorkerError("OpenHands image must be pinned by @sha256 digest")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": CONFIG_VERSION, "apiUrl": api_url, "token": token,
               "instanceId": f"agentiz-{socket.gethostname()}-{uuid.uuid4().hex[:8]}",
               "workspace": str(workspace.resolve()), "serverImage": image}
    temporary = config_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(config_path)
    config_path.chmod(0o600)
    print(f"Профиль сохранён: {config_path} (доступ только владельцу)")
    print(f"Рабочая директория создана автоматически: {workspace}")
    print("Запустите `agentiz-worker install-service` для постоянного запуска.")


def install_service(config_path: Path, no_start: bool) -> None:
    if not config_path.is_file():
        raise WorkerError(f"Worker profile not found: {config_path}. Run `agentiz-worker configure` first.")
    unit_path = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd/user/agentiz-worker.service"
    # Do not resolve this symlink: a virtualenv's python usually points at the system interpreter,
    # while its original path is what activates the virtualenv's site-packages.
    executable = Path(sys.executable)
    environment_path = config_path.with_suffix('.env')
    unit_path.parent.mkdir(parents=True, exist_ok=True)
    unit_path.write_text(f"""[Unit]\nDescription=Agentiz OpenHands worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=-{environment_path}\nExecStart={executable} -m agentiz_worker.main run --config {config_path}\nRestart=always\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n""")
    unit_path.chmod(0o644)
    systemd_environment = os.environ.copy()
    # A terminal launched outside the graphical login/SSH PAM session may not export these even
    # though the per-user manager is live. systemctl then talks to no bus and only says exit 1.
    runtime_dir = Path(f"/run/user/{os.getuid()}")
    if not systemd_environment.get("XDG_RUNTIME_DIR") and runtime_dir.is_dir():
        systemd_environment["XDG_RUNTIME_DIR"] = str(runtime_dir)
        systemd_environment.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime_dir}/bus")
    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, env=systemd_environment)
        command = ["systemctl", "--user", "enable"] + ([] if no_start else ["--now"]) + ["agentiz-worker.service"]
        subprocess.run(command, check=True, env=systemd_environment)
    except FileNotFoundError as error:
        raise WorkerError("systemctl is not installed; profile was saved but the service was not enabled") from error
    except subprocess.CalledProcessError as error:
        raise WorkerError(f"systemd could not enable the worker; unit was written to {unit_path}: {error}") from error
    print(f"systemd user service installed: {unit_path}")


class Client:
    def __init__(self, settings: Settings): self.settings = settings

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
        request = Request(f"{self.settings.api_url}{path}", data=json.dumps(body).encode() if body else None, method=method,
                          headers={"Authorization": f"Bearer {self.settings.token}", "Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=70) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except HTTPError as error:
            # A server may intentionally disable remote execution during maintenance. Claims are
            # a polling endpoint, so preserve the daemon and retry rather than crash-looping under
            # systemd. Other authentication/protocol failures still fail loudly below.
            if error.code in (502, 503, 504) and path == "/claims":
                return error.code, None
            raise WorkerError(f"{method} {path}: HTTP {error.code}: {error.read().decode(errors='replace')}") from error

    def register(self) -> Any:
        return self.request("POST", "/register", {"schemaVersion": SCHEMA_VERSION, "instanceId": self.settings.instance_id,
            "version": worker_version(), "capabilities": {"executors": ["openhands-acp"], "workspaceModes": ["host", "docker"],
                "workspaceGit": True, "jobKinds": ["pipeline", "workspace_commit_push", "workspace_reset"],
                "humanInput": {"modes": ["form"], "nativeRoundTrip": True, "durableResume": False}, "maxConcurrency": 1}})[1]

    def claim(self) -> dict[str, Any] | None:
        status, data = self.request("POST", "/claims", {"schemaVersion": SCHEMA_VERSION,
            "capabilities": {"executors": ["openhands-acp"], "workspaceModes": ["host", "docker"], "workspaceGit": True}})
        return data if status == 200 else None

    def post(self, path: str, job: dict[str, Any], extra: dict[str, Any]) -> Any:
        return self.request("POST", path, {"schemaVersion": SCHEMA_VERSION, "attempt": job["attempt"], "leaseToken": job["leaseToken"], **extra})[1]

    def heartbeat(self, job: dict[str, Any]) -> Any:
        return self.post(f"/jobs/{job['jobId']}/heartbeat", job, {})

    def report_harness_usage(self, harness_key: str, raw: dict[str, Any]) -> Any:
        """Pushes one harness's usage payload. Outside any job lease — see the server endpoint."""
        return self.request("POST", "/harness-usage", {"schemaVersion": SCHEMA_VERSION,
            "harnessKey": harness_key, "raw": raw})[1]

    def secrets(self, job: dict[str, Any]) -> Any:
        """Repository credentials for this job. Never part of the job payload — see the server's
        AgentWorkerApiService.issueSecrets for why."""
        return self.post(f"/jobs/{job['jobId']}/secrets", job, {})


def stage_config(stage: dict[str, Any]) -> tuple[str, str, list[str], str | None, str | None]:
    runtime = stage.get("runtime")
    mode = runtime.get("mode") if isinstance(runtime, dict) else None
    agent = stage.get("agent", {})
    config = agent.get("config", {})
    kind = agent.get("kind")
    command = config.get("bashCommand") if kind == "bash-fixture" and isinstance(config, dict) else config.get("acpCommand") if isinstance(config, dict) else None
    if mode not in ("host", "docker"):
        raise WorkerError("stage.runtime.mode must be host or docker")
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise WorkerError("stage agent config requires acpCommand (or bashCommand for bash-fixture): [executable, ...args]")
    model = agent.get("model")
    collaboration_mode = config.get("collaborationMode") if isinstance(config, dict) else None
    if collaboration_mode is not None and collaboration_mode not in ("default", "plan"):
        raise WorkerError("stage agent config collaborationMode must be default or plan")
    return mode, str(kind), pin_acp_command(command), (str(model) if model else None), collaboration_mode


def prompt(stage: dict[str, Any], job: dict[str, Any]) -> str:
    task = job.get("task", {})
    return "\n\n".join(part for part in [stage.get("systemPrompt") or "", f"Task: {task.get('title', '')}", task.get("description") or ""] if part)


MAX_AGENT_MESSAGE_CHARS = 4_000
#: A tool call's title is a one-line "what is happening now", not output — a shell command or a
#: prompt fragment can otherwise run to kilobytes on every progress notification.
MAX_TOOL_TITLE_CHARS = 300
ACP_ADAPTER_PINS = {
    "@agentclientprotocol/codex-acp": "@agentclientprotocol/codex-acp@1.1.14",
    "@agentclientprotocol/claude-agent-acp": "@agentclientprotocol/claude-agent-acp@0.66.0",
}


def pin_acp_command(command: list[str]) -> list[str]:
    """Make old role snapshots use the contract-tested adapter versions too."""
    codex_index = next(
        (index for index, part in enumerate(command)
         if part == "@agentclientprotocol/codex-acp" or part.startswith("@agentclientprotocol/codex-acp@")),
        None,
    )
    if codex_index is not None:
        # Agentiz owns the form-elicitation bridge.  The upstream adapter receives the matching
        # App Server capability through this launcher; a bare npx invocation omits it and Codex
        # hides request_user_input from the agent.
        return [sys.executable, "-m", "agentiz_worker.codex_acp", *command[codex_index + 1:]]
    pinned: list[str] = []
    for part in command:
        replacement = next(
            (version for package, version in ACP_ADAPTER_PINS.items() if part == package or part.startswith(f"{package}@")),
            None,
        )
        pinned.append(replacement or part)
    return pinned


def agent_message_text(event: Any) -> str | None:
    """Return the displayable final agent text without tool output or reasoning.

    ACPAgent emits ordinary assistant messages as ``MessageEvent``, but a successful
    ACP turn is finalized as ``ActionEvent(FinishAction(message=...))``.  Reading
    only MessageEvent silently loses every normal successful response.
    """
    if getattr(event, "source", None) != "agent":
        return None
    if type(event).__name__ == "MessageEvent":
        try:
            from openhands.sdk.llm import content_to_str
            text = "".join(content_to_str(event.llm_message.content)).strip()
        except Exception:
            return None
    elif type(event).__name__ == "ActionEvent" and type(getattr(event, "action", None)).__name__ == "FinishAction":
        text = str(getattr(event.action, "message", "")).strip()
    else:
        return None
    if not text:
        return None
    return text[:MAX_AGENT_MESSAGE_CHARS] + ("…" if len(text) > MAX_AGENT_MESSAGE_CHARS else "")


def tool_call_progress(event: Any) -> tuple[str, str] | None:
    """One live tool call as `(dedup key, log line)`, or None for any other event.

    openhands-sdk emits an ``ACPToolCallEvent`` for every ``ToolCallStart`` / ``ToolCallProgress``
    notification, so a single call arrives two or three times as its status advances
    (``pending`` → ``in_progress`` → ``completed``). The key collapses those repeats into one line
    per status change — the SDK asks consumers to dedup by ``tool_call_id`` itself.

    Matched by class name rather than imported, for the same reason ``MessageEvent`` and
    ``ActionEvent`` are (see `agent_message_text`): an SDK that moves the import path would
    otherwise silence the run log instead of failing loudly, and the worker supports whatever
    version is installed beside it.
    """
    if type(event).__name__ != "ACPToolCallEvent":
        return None
    call_id = str(getattr(event, "tool_call_id", "") or "")
    status = str(getattr(event, "status", "") or "") or "started"
    title = str(getattr(event, "title", "") or getattr(event, "tool_kind", "") or "tool call").strip()
    if len(title) > MAX_TOOL_TITLE_CHARS:
        title = title[:MAX_TOOL_TITLE_CHARS] + "…"
    # raw_input/raw_output are deliberately left out: they are the bulk and the secret-bearing part
    # of a tool call, and the title already answers "what is it doing right now".
    return f"{call_id}:{status}", f"{title} — {status}"


def resolve_workdir(job: dict[str, Any], settings: Settings) -> Path:
    """Directory every stage of this job runs in.

    Without `workspace` in the payload this is the worker's own managed directory, exactly as
    before. With it, the pipeline is one that works in a directory on this machine named either by
    a key declared on this worker (`AgentWorker.workspaces`) or directly by an absolute path in the
    spec. The declared-key case still requires the directory to exist already: creating it here
    would hand the agent an empty tree while the operator believes it is working in their project.
    The direct-path case is spelled out by the spec author instead, and only creates the directory
    when the spec explicitly opted in with `createIfMissing` — access errors underneath that
    (permissions, a parent that is actually a file, and so on) still surface as-is rather than being
    swallowed.
    """
    workspace = job.get("workspace")
    if not isinstance(workspace, dict):
        return settings.workspace
    raw = str(workspace.get("path") or "").strip()
    if not raw:
        raise WorkerError("job workspace has no path")
    directory = Path(raw).expanduser()
    if not directory.is_absolute():
        raise WorkerError(f"job workspace path must be absolute, got {raw}")
    if not directory.is_dir():
        if directory.exists():
            raise WorkerError(f"job workspace path exists on this worker but is not a directory: {directory}")
        if not workspace.get("createIfMissing"):
            raise WorkerError(f"job workspace directory does not exist on this worker: {directory}")
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def stage_token_usage(agent: Any) -> dict[str, Any] | None:
    """Token/cost numbers the SDK accumulated for one stage, in the wire's camelCase.

    openhands-sdk records every ACP ``PromptResponse.usage`` into ``agent.llm.metrics``
    (claude-agent-acp and codex-acp send the standard field; an executor that reports nothing
    leaves the counters at zero, and this returns None so the stage output carries no usage block
    instead of a block of zeros that reads as "the agent spent nothing").
    """
    try:
        metrics = agent.llm.metrics
        usage = metrics.accumulated_token_usage
        cost = float(metrics.accumulated_cost or 0.0)
    except Exception:
        return None
    if usage is None:
        return None
    tokens = {
        "inputTokens": int(usage.prompt_tokens or 0),
        "outputTokens": int(usage.completion_tokens or 0),
        "cacheReadTokens": int(usage.cache_read_tokens or 0),
        "cacheWriteTokens": int(usage.cache_write_tokens or 0),
        "reasoningTokens": int(usage.reasoning_tokens or 0),
    }
    if not any(tokens.values()) and cost <= 0:
        return None
    tokens["totalTokens"] = tokens["inputTokens"] + tokens["outputTokens"] + tokens["cacheReadTokens"] + tokens["cacheWriteTokens"]
    if usage.context_window:
        tokens["contextWindow"] = int(usage.context_window)
    if cost > 0:
        # litellm's pricing estimate; on a subscription the real marginal cost is zero.
        tokens["estimatedCostUsd"] = round(cost, 6)
    if usage.model:
        tokens["model"] = str(usage.model)
    return tokens


def run_openhands(mode: str, acp_command: list[str], model: str | None, message: str, settings: Settings, workdir: Path,
                  on_agent_message: Any, interaction_broker: HumanInteractionBroker,
                  collaboration_mode: str | None = None, on_tool_progress: Any = None,
                  on_usage: Any = None) -> tuple[str, str | None]:
    # Imports are deliberately here so `--help` and registration failures remain clear before a
    # virtualenv is installed. Both workspace choices use the same Conversation/ACPAgent flow.
    from openhands.sdk.agent import ACPAgent
    from openhands.sdk.conversation import Conversation
    if mode == "host":
        workspace: Any = str(workdir)
        context = None
    else:
        if not settings.server_image:
            raise WorkerError("docker stage requires AGENTIZ_OPENHANDS_SERVER_IMAGE pinned by digest")
        from openhands.workspace import DockerWorkspace
        context = DockerWorkspace(server_image=settings.server_image)
        workspace = context
    # acp_model is applied to the session after it starts (set_config_option/set_session_model on
    # the ACP server) rather than as a CLI arg or env var — see the stage.model field on the spec.
    # None keeps the executor's own default, exactly as before this field existed.
    agent = ACPAgent(acp_command=acp_command, acp_model=model)
    final_message: str | None = None
    # Per stage: the SDK's tool call ids are only unique within one conversation, and a stage that
    # ended has nothing left to dedup against.
    seen_tool_calls: set[str] = set()

    def forward_event(event: Any) -> None:
        nonlocal final_message
        progress = tool_call_progress(event)
        if progress:
            key, line = progress
            # `_cancel_inflight_tool_calls` sends a terminal status for calls the turn never
            # closed, so an abandoned call still gets its last line through this same path.
            if on_tool_progress and key not in seen_tool_calls:
                seen_tool_calls.add(key)
                on_tool_progress(line)
            return
        text = agent_message_text(event)
        if text:
            final_message = text
            # The run log is user-facing.  Sending the event class name for tool/system events
            # made it look like a result while hiding the actual agent response.
            on_agent_message(text)

    try:
        if context:
            context.__enter__()
        with install_acp_human_input(interaction_broker, collaboration_mode):
            conversation = Conversation(agent=agent, workspace=workspace, callbacks=[forward_event])
            try:
                conversation.send_message(message)
                conversation.run()
                return str(conversation.state.execution_status), final_message
            finally:
                conversation.close()
    finally:
        # Read before close, and on the failure path too: tokens spent by a stage that then
        # failed are still spent, and the run's totals must include them.
        if on_usage:
            usage = stage_token_usage(agent)
            if usage:
                on_usage(usage)
        agent.close()
        if context:
            context.__exit__(None, None, None)


def run_bash_fixture(mode: str, command: list[str], settings: Settings, workdir: Path) -> str:
    """Deterministic stage-0 probe; Docker still goes through OpenHands DockerWorkspace."""
    if mode == "host":
        result = subprocess.run(command, cwd=workdir, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode:
            raise WorkerError(result.stdout or f"bash fixture exited {result.returncode}")
        return result.stdout.strip()
    if not settings.server_image:
        raise WorkerError("docker stage requires AGENTIZ_OPENHANDS_SERVER_IMAGE pinned by digest")
    from openhands.workspace import DockerWorkspace
    with DockerWorkspace(server_image=settings.server_image) as workspace:
        result = workspace.execute_command(shlex.join(command))
        if result.exit_code:
            raise WorkerError(result.stderr or result.stdout or f"bash fixture exited {result.exit_code}")
        return result.stdout.strip()


def maintain_lease(client: Client, job: dict[str, Any], stop: threading.Event, failure: list[Exception]) -> None:
    """Keep a claimed job private while a long-running ACP conversation is executing."""
    while not stop.wait(HEARTBEAT_INTERVAL_SEC):
        try:
            response = client.heartbeat(job) or {}
            if response.get("command") == "cancel":
                failure.append(WorkerError(response.get("reason") or "Job cancellation requested by server"))
                stop.set()
                return
        except Exception as error:
            # Never submit a stale success after the server has revoked this lease.
            failure.append(error)
            stop.set()
            return
def execute_job(client: Client, job: dict[str, Any], settings: Settings) -> None:
    sequence = SequenceCounter()
    outputs: list[dict[str, Any]] = []
    heartbeat_stop = threading.Event()
    heartbeat_failure: list[Exception] = []
    # Everything sent back to Agentiz goes through this: the clone token is in this process only
    # because the checkout needs it, and it must not reach a stored log or summary.
    redact = Redactor()

    def send_events(events: list[dict[str, Any]]) -> None:
        client.post(f"/jobs/{job['jobId']}/events:batch", job, {"events": events})

    def emit(kind: str, stage_id: str | None, message: str, level: str = "info") -> None:
        """Milestones (workspace/stage/hook), posted inline: their order against the job's result
        is part of the record, and there are only a handful of them per run."""
        send_events([{"eventId": str(uuid.uuid4()), "sequence": sequence.next(), "type": kind,
            "stageExecutionId": stage_id, "level": level, "message": redact(message)}])

    # Progress the agent produces mid-stage instead goes out on this thread — see live_events.py
    # for why posting it from the callback would stall the ACP turn.
    live = LiveEventStream(send_events, sequence, redact,
                           on_error=lambda error: print(f"live events dropped: {error}", flush=True)).start()

    # Started before the checkout on purpose: cloning a large repository takes longer than a lease.
    heartbeat = threading.Thread(target=maintain_lease, args=(client, job, heartbeat_stop, heartbeat_failure), daemon=True)
    heartbeat.start()

    repository = job.get("repository") if isinstance(job.get("repository"), dict) else None
    proposal = job.get("proposal") if isinstance(job.get("proposal"), dict) else None
    job_kind = str(job.get("jobKind") or "pipeline")
    job_root: Path | None = None
    workdir: Path | None = None
    workspace_marker: dict[str, Any] | None = None
    # Filled by guard/preflight when they clear a marker an abandoned proposal left behind.
    workspace_report: dict[str, Any] = {}
    workspace_lock_context: Any = None
    failed = False
    try:
        pinned = isinstance(job.get("workspace"), dict)
        if job_kind != "pipeline":
            # `repository` is optional: a directory that pushes through its own remote pins none.
            if not pinned or not proposal:
                raise WorkerError(f"{job_kind} job is missing workspace or proposal")
            workdir = resolve_workdir(job, settings)
            action_result = run_action(workdir, job_kind, proposal, repository)
            live.flush()
            client.post(f"/jobs/{job['jobId']}/result", job, {
                "resultId": str(uuid.uuid4()), "status": "succeeded", **action_result,
            })
            finalize_action(workdir, str(proposal.get("id")))
            return
        if repository and not pinned:
            # One disposable checkout per job, under the managed workspace root.
            job_root = settings.workspace / str(job["jobId"])
            job_root.mkdir(parents=True, exist_ok=True)
            credentials = (client.secrets(job) or {}).get("repository")
            if credentials and credentials.get("password"):
                redact.add(str(credentials["password"]))
            workdir = prepare_checkout(repository, credentials, job_root, log=lambda message: emit("workspace.progress", None, message))
            emit("workspace.ready", None, f"Чекаут {repository.get('owner')}/{repository.get('repo')} на {str(repository.get('baseSha'))[:12]}")
            # Cancellation during a long clone must be honoured before the agent starts.
            if heartbeat_failure:
                raise heartbeat_failure[0]
        else:
            workdir = resolve_workdir(job, settings)
            if pinned:
                emit("job.workspace", None, f"Работа идёт в готовой папке воркера: {workdir}")

        if pinned:
            # The server sets this when its reservation table shows nobody holding the directory,
            # which makes a marker still lying in it the leftover of a proposal that is already over.
            allow_stale_marker = bool((job.get("workspace") or {}).get("staleMarkerAllowed"))
            workspace_lock_context = guard_workspace(
                workdir, str(proposal.get("id")) if proposal else None,
                allow_stale_marker=allow_stale_marker, report=workspace_report,
            )
            locked_root = workspace_lock_context.__enter__()
            if proposal:
                workdir, workspace_marker = workspace_git_preflight(
                    locked_root, proposal, repository, allow_stale_marker=allow_stale_marker,
                    report=workspace_report,
                    # Absent means stash: an older server sends no flag, and the new default is the
                    # one that does not stop a run over work nobody claimed.
                    stash_dirty=(job.get("workspace") or {}).get("stashDirty") is not False,
                )
            preexisting = workspace_report.get("preexisting")
            if preexisting:
                emit("workspace.stashed", None,
                     f"В папке была чужая работа — убрана в git stash {str(preexisting['stashSha'])[:12]}")
            recovered = workspace_report.get("recovered")
            if recovered:
                # Said out loud the moment it happens: the run may still die before it reports, and
                # a stash nobody can name is barely better than a deletion.
                emit("workspace.recovered", None,
                     f"Забытая работа предложения {recovered.get('proposalId') or '?'} убрана в git stash"
                     + (f" {str(recovered.get('stashSha'))[:12]}" if recovered.get("stashSha")
                        else " (в папке нечего было сохранять)"))
                emit("workspace.git.ready", None,
                     f"Git proposal {proposal.get('id')} revision {proposal.get('revision')} at {workspace_marker['baseSha'][:12]}")

        hooks = job.get("hooks") if isinstance(job.get("hooks"), dict) else None
        hook_records: list[dict[str, Any]] = []

        def run_pipeline_hook(position: str, run_status: str | None = None) -> None:
            """Runs one of the pipeline's scripts, if it declared one.

            The server already resolved every value; the three variables added here are the ones
            only this process knows — which hook is running, where, and (for `after`) how the
            stages went.
            """
            spec = (hooks or {}).get(position)
            if not isinstance(spec, dict):
                return
            env = {
                **(hooks.get("env") or {}),
                "AGENTIZ_HOOK": position,
                "AGENTIZ_WORKDIR": str(workdir),
                "AGENTIZ_JOB_ID": str(job["jobId"]),
            }
            if run_status:
                env["AGENTIZ_RUN_STATUS"] = run_status
            record = run_hook(position, spec, workdir, env, log=lambda message: emit("hook.progress", None, message))
            record["output"] = redact(record.get("output") or "")
            if record.get("error"):
                record["error"] = redact(str(record["error"]))
            hook_records.append(record)
            if record["output"]:
                emit("hook.output", None, f"Вывод {position}-хука:\n{record['output'][:MAX_AGENT_MESSAGE_CHARS]}",
                     level="warn" if record.get("error") else "info")

        run_pipeline_hook("before")
        if heartbeat_failure:
            raise heartbeat_failure[0]

        # Stage failures are caught rather than propagated so the `after` hook still gets to run —
        # it is the only place a pipeline can put teardown, and teardown that only happens on the
        # happy path is not teardown. The original error is re-raised once the hook is done.
        stage_error: Exception | None = None
        try:
            for stage in job.get("stages", []):
                if heartbeat_failure:
                    raise heartbeat_failure[0]
                stage_id = stage.get("executionId")
                mode, kind, command, model, collaboration_mode = stage_config(stage)
                # A container gets its own filesystem, so it would not contain the prepared
                # directory this pipeline exists for. The server rejects the combination too; this
                # is the guard on the side that actually owns the path.
                if pinned and mode == "docker":
                    raise WorkerError(f"stage runtime.mode 'docker' cannot use the worker directory {workdir}; configure the stage as 'host'")
                # Same reason, for a checkout: it was made on this host and DockerWorkspace starts a
                # container with its own tree. Delivering the checkout into the container (bind mount
                # or file upload) is unverified against openhands-workspace, and running the agent in
                # an empty container while the operator believes it has the code would be worse than
                # refusing. See .ai-notes/multi-repo-oauth/06-worker-checkout-and-diff.md §6.3.
                if repository and mode == "docker":
                    raise WorkerError("stage runtime.mode 'docker' cannot see the repository checkout yet; configure the stage as 'host'")
                emit("stage.started", stage_id, f"{kind} stage started in {mode} workspace")
                # Filled by run_openhands from its finally block, so a stage that raised still
                # reports what it spent — the failed entry below is how those tokens reach the run.
                stage_usage: list[dict[str, Any]] = []
                try:
                    if kind == "bash-fixture":
                        status, agent_response = run_bash_fixture(mode, command, settings, workdir), None
                    else:
                        source = "codex" if any("codex-acp" in part or "codex_acp" in part for part in command) else "claude" if any("claude-agent-acp" in part for part in command) else "acp"
                        interaction_broker = HumanInteractionBroker(client, job, str(stage_id), source, redact)
                        status, agent_response = run_openhands(
                            mode, command, model, prompt(stage, job), settings, workdir,
                            lambda text: emit("stage.event", stage_id, text),
                            interaction_broker, collaboration_mode,
                            on_tool_progress=lambda line, stage_id=stage_id: live.emit("stage.tool", stage_id, line, level="debug"),
                            on_usage=stage_usage.append,
                        )
                except Exception:
                    if stage_usage:
                        outputs.append({"executionId": stage_id, "status": "failed",
                            "output": {"workspaceMode": mode, "workdir": str(workdir), "usage": stage_usage[0]}})
                    raise
                if heartbeat_failure:
                    raise heartbeat_failure[0]
                summary = redact(agent_response or status)
                stage_output: dict[str, Any] = {"workspaceMode": mode, "workdir": str(workdir), "executionStatus": status,
                    "agentResponse": redact(agent_response) if agent_response else None}
                if stage_usage:
                    stage_output["usage"] = stage_usage[0]
                    tokens_line = f"Токены стейджа: {stage_usage[0].get('totalTokens', 0):,}".replace(",", " ")
                    emit("stage.usage", stage_id, tokens_line, level="debug")
                outputs.append({"executionId": stage_id, "status": "succeeded", "summary": summary, "output": stage_output})
                # So the stage's last tool line is not written after the line closing the stage.
                live.drain()
                emit("stage.completed", stage_id, summary)
        except Exception as error:
            stage_error = error

        # Before the diff is collected on purpose: a formatter or a codegen step in `after` is meant
        # to be part of the change the run proposes, not a thing that happens after the snapshot.
        try:
            run_pipeline_hook("after", "failed" if stage_error else "succeeded")
        except Exception as hook_error:
            # A failing teardown must not hide why the run actually failed.
            if stage_error is None:
                raise
            emit("hook.failed", None, f"after-хук тоже не удался: {hook_error}", level="warn")
        if stage_error:
            raise stage_error

        result: dict[str, Any] = {"resultId": str(uuid.uuid4()), "status": "succeeded",
            "summary": redact("\n".join(f"- {item['summary']}" for item in outputs)), "stageOutputs": outputs}
        if hook_records:
            result["hooks"] = hook_records
        if workspace_report.get("recovered"):
            result["recoveredStash"] = workspace_report["recovered"]
        if workspace_report.get("preexisting"):
            result["preexistingStash"] = workspace_report["preexisting"]
        # A workspace proposal needs its diff whether or not a hosted repository is pinned — since
        # `repositoryId` became optional for worker directories, `repository` alone would skip the
        # collection and leave the proposal with nothing to review. Mirrors the failure path below.
        if repository or (workspace_marker and proposal):
            base_sha = str((workspace_marker or {}).get("baseSha") or (repository or {}).get("baseSha") or "")
            changes = collect_changes(workdir, base_sha,
                                      int(job.get("limits", {}).get("maxPatchBytes") or 5 * 1024 * 1024))
            result.update({
                "baseSha": changes["baseSha"],
                "fileOps": changes["ops"],
                "patch": changes["patch"],
                "patchBase64": changes["patchBase64"],
                "diffStats": changes["stats"],
                "patchTruncated": changes["truncated"],
                "patchSizeBytes": changes["patchSizeBytes"],
                "patchSha256": changes["patchSha256"],
                "treeSha": changes["treeSha"],
            })
            if workspace_marker and proposal:
                record_tree(workdir, workspace_marker, changes["treeSha"], int(proposal.get("revision") or 0))
                result["git"] = {key: workspace_marker.get(key) for key in
                                 ("baseBranch", "remote", "remoteUrl", "remoteBaseSha")}
            emit("changes.collected", None,
                 f"{len(changes['ops'])} операц(ий), +{changes['stats']['insertions']} −{changes['stats']['deletions']}")
        live.flush()
        client.post(f"/jobs/{job['jobId']}/result", job, result)
    except Exception as error:
        live.flush()
        failed = True
        terminal_status = "cancelled" if "cancellation requested" in str(error).lower() else "failed"
        failure_result: dict[str, Any] = {"resultId": str(uuid.uuid4()), "status": terminal_status,
            "errorMessage": redact(str(error)), "stageOutputs": outputs}
        if workspace_report.get("preexisting"):
            failure_result["preexistingStash"] = workspace_report["preexisting"]
        if workspace_report.get("recovered"):
            # Travels on the failure path too: the stash belongs to the *previous* proposal, and
            # whether this run then worked out has nothing to do with recording where it went.
            failure_result["recoveredStash"] = workspace_report["recovered"]
        if pinned and proposal and workspace_marker is None:
            # Preflight runs before hooks/stages. Without a marker Agentiz never touched the tree,
            # so the server may safely release the reservation without attempting reset.
            failure_result["workspaceUntouched"] = True
        if workdir and workspace_marker and proposal:
            try:
                changes = collect_changes(workdir, str(workspace_marker["baseSha"]),
                                          int(job.get("limits", {}).get("maxPatchBytes") or 5 * 1024 * 1024))
                failure_result.update({"baseSha": changes["baseSha"], "fileOps": changes["ops"],
                    "patch": changes["patch"], "patchBase64": changes["patchBase64"], "diffStats": changes["stats"],
                    "patchTruncated": changes["truncated"], "patchSizeBytes": changes["patchSizeBytes"],
                    "patchSha256": changes["patchSha256"], "treeSha": changes["treeSha"],
                    "git": {key: workspace_marker.get(key) for key in ("baseBranch", "remote", "remoteUrl", "remoteBaseSha")}})
                record_tree(workdir, workspace_marker, changes["treeSha"], int(proposal.get("revision") or 0))
            except Exception as diff_error:
                failure_result["errorMessage"] += f"; diff collection also failed: {redact(str(diff_error))}"
        client.post(f"/jobs/{job['jobId']}/result", job, failure_result)
    finally:
        # Idempotent: the terminal paths above already flushed, this covers the ones that raised
        # before reaching one.
        live.flush()
        heartbeat_stop.set()
        heartbeat.join(timeout=1)
        if workspace_lock_context:
            workspace_lock_context.__exit__(None, None, None)
        # The only thing keeping the disk from filling up with checkouts.
        if job_root and job_root.exists() and not (failed and settings.keep_workspace_on_failure):
            shutil.rmtree(job_root, ignore_errors=True)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        sys.argv.insert(1, "run")
    parser = argparse.ArgumentParser(description="Agentiz OpenHands stage-0 worker")
    subcommands = parser.add_subparsers(dest="command")
    configure_parser = subcommands.add_parser("configure", help="create or update the local worker profile")
    configure_parser.add_argument("--config", type=Path, default=default_config_path(), help="profile path")
    run_parser = subcommands.add_parser("run", help="run the worker from its local profile")
    run_parser.add_argument("--config", type=Path, default=default_config_path(), help="profile path")
    run_parser.add_argument("--once", action="store_true", help="register, claim at most one job, then exit")
    service_parser = subcommands.add_parser("install-service", help="install and start a persistent systemd user service")
    service_parser.add_argument("--config", type=Path, default=default_config_path(), help="profile path")
    service_parser.add_argument("--no-start", action="store_true", help="install and enable without starting immediately")
    args = parser.parse_args()
    # Earlier stage-0 invocations used `agentiz-worker --once`. Make plain invocation a useful
    # profile-based run, while the documented CLI keeps explicit lifecycle commands.
    command = args.command or "run"
    if command == "configure":
        configure(args.config.expanduser())
        return
    if command == "install-service":
        install_service(args.config.expanduser(), args.no_start)
        return
    settings = load_settings(args.config.expanduser() if args.command else default_config_path(), getattr(args, "once", False))
    if not settings.workspace.is_dir(): raise WorkerError(f"workspace does not exist: {settings.workspace}")
    client = Client(settings)
    registration = client.register()
    print(f"registered worker {registration['workerId']} as {settings.instance_id}", flush=True)
    reporter = UsageReporter(client.report_harness_usage, settings.usage_report_interval_sec) \
        if settings.usage_report_interval_sec else None
    if reporter:
        # Both paths report immediately — the loop's first pass runs before its first wait — so a
        # spent subscription is visible without waiting out an interval. Calling report_once()
        # here *and* starting the thread would send the same snapshot twice on every restart.
        if settings.once:
            reporter.report_once()
        else:
            reporter.start()
    while True:
        job = client.claim()
        if job: execute_job(client, job, settings)
        if settings.once: return
        time.sleep(2)


if __name__ == "__main__": main()
