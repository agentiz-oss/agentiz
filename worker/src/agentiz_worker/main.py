"""Stage-0 Agentiz worker: authenticated API transport plus OpenHands ACP execution.

`host` passes the fixture checkout directly to Conversation. `docker` replaces that workspace
with DockerWorkspace; OpenHands owns Agent Server startup, readiness and teardown in its context
manager. No worker code talks to Agentiz's database or invokes `docker run` itself.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import shlex
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SCHEMA_VERSION = 1
DEFAULT_API_URL = "https://agentiz.m42.cx/api/agentiz/worker/v1"
DEFAULT_SERVER_IMAGE = ""
CONFIG_VERSION = 1


class WorkerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    api_url: str
    token: str
    instance_id: str
    workspace: Path
    server_image: str
    once: bool

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
        return cls(api_url, token, str(data.get("instanceId") or f"agentiz-{socket.gethostname()}"), workspace, image, once)

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
                   Path(os.environ.get("AGENTIZ_WORKER_WORKSPACE", os.getcwd())).resolve(), image, once)


def default_config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "agentiz" / "worker.json"


def default_workspace_path() -> Path:
    return Path.home() / ".local" / "share" / "agentiz-worker" / "workspace"


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
    unit_path.parent.mkdir(parents=True, exist_ok=True)
    unit_path.write_text(f"""[Unit]\nDescription=Agentiz OpenHands worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={executable} -m agentiz_worker.main run --config {config_path}\nRestart=always\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n""")
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
            "version": "stage-0", "capabilities": {"executors": ["openhands-acp"], "workspaceModes": ["host", "docker"], "maxConcurrency": 1}})[1]

    def claim(self) -> dict[str, Any] | None:
        status, data = self.request("POST", "/claims", {"schemaVersion": SCHEMA_VERSION,
            "capabilities": {"executors": ["openhands-acp"], "workspaceModes": ["host", "docker"]}})
        return data if status == 200 else None

    def post(self, path: str, job: dict[str, Any], extra: dict[str, Any]) -> Any:
        return self.request("POST", path, {"schemaVersion": SCHEMA_VERSION, "attempt": job["attempt"], "leaseToken": job["leaseToken"], **extra})[1]


def stage_config(stage: dict[str, Any]) -> tuple[str, str, list[str]]:
    runtime = stage.get("runtime")
    mode = runtime.get("mode") if isinstance(runtime, dict) else None
    config = stage.get("agent", {}).get("config", {})
    kind = stage.get("agent", {}).get("kind")
    command = config.get("bashCommand") if kind == "bash-fixture" and isinstance(config, dict) else config.get("acpCommand") if isinstance(config, dict) else None
    if mode not in ("host", "docker"):
        raise WorkerError("stage.runtime.mode must be host or docker")
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise WorkerError("stage agent config requires acpCommand (or bashCommand for bash-fixture): [executable, ...args]")
    return mode, str(kind), command


def prompt(stage: dict[str, Any], job: dict[str, Any]) -> str:
    task = job.get("task", {})
    return "\n\n".join(part for part in [stage.get("systemPrompt") or "", f"Task: {task.get('title', '')}", task.get("description") or ""] if part)


def run_openhands(mode: str, acp_command: list[str], message: str, settings: Settings, on_event: Any) -> str:
    # Imports are deliberately here so `--help` and registration failures remain clear before a
    # virtualenv is installed. Both workspace choices use the same Conversation/ACPAgent flow.
    from openhands.sdk.agent import ACPAgent
    from openhands.sdk.conversation import Conversation
    if mode == "host":
        workspace: Any = str(settings.workspace)
        context = None
    else:
        if not settings.server_image:
            raise WorkerError("docker stage requires AGENTIZ_OPENHANDS_SERVER_IMAGE pinned by digest")
        from openhands.workspace import DockerWorkspace
        context = DockerWorkspace(server_image=settings.server_image)
        workspace = context
    agent = ACPAgent(acp_command=acp_command)
    try:
        if context:
            context.__enter__()
        conversation = Conversation(agent=agent, workspace=workspace, callbacks=[on_event])
        try:
            conversation.send_message(message)
            conversation.run()
            return str(conversation.state.execution_status)
        finally:
            conversation.close()
    finally:
        agent.close()
        if context:
            context.__exit__(None, None, None)


def run_bash_fixture(mode: str, command: list[str], settings: Settings) -> str:
    """Deterministic stage-0 probe; Docker still goes through OpenHands DockerWorkspace."""
    if mode == "host":
        result = subprocess.run(command, cwd=settings.workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
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


def execute_job(client: Client, job: dict[str, Any], settings: Settings) -> None:
    sequence = 0
    outputs: list[dict[str, Any]] = []
    def emit(kind: str, stage_id: str | None, message: str, level: str = "info") -> None:
        nonlocal sequence
        sequence += 1
        client.post(f"/jobs/{job['jobId']}/events:batch", job, {"events": [{"eventId": str(uuid.uuid4()), "sequence": sequence,
            "type": kind, "stageExecutionId": stage_id, "level": level, "message": message}]})
    try:
        for stage in job.get("stages", []):
            stage_id = stage.get("executionId")
            mode, kind, command = stage_config(stage)
            emit("stage.started", stage_id, f"{kind} stage started in {mode} workspace")
            status = run_bash_fixture(mode, command, settings) if kind == "bash-fixture" else run_openhands(mode, command, prompt(stage, job), settings,
                lambda event: emit("stage.event", stage_id, type(event).__name__))
            outputs.append({"executionId": stage_id, "status": "succeeded", "summary": status, "output": {"workspaceMode": mode, "executionStatus": status}})
            emit("stage.completed", stage_id, status)
        client.post(f"/jobs/{job['jobId']}/result", job, {"resultId": str(uuid.uuid4()), "status": "succeeded",
            "summary": "\n".join(f"- {item['summary']}" for item in outputs), "stageOutputs": outputs, "fileChanges": []})
    except Exception as error:
        client.post(f"/jobs/{job['jobId']}/result", job, {"resultId": str(uuid.uuid4()), "status": "failed", "errorMessage": str(error), "stageOutputs": outputs})


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
    while True:
        job = client.claim()
        if job: execute_job(client, job, settings)
        if settings.once: return
        time.sleep(2)


if __name__ == "__main__": main()
