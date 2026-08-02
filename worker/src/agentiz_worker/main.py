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
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SCHEMA_VERSION = 1


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
    def from_env(cls, once: bool) -> "Settings":
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
    parser = argparse.ArgumentParser(description="Agentiz OpenHands stage-0 worker")
    parser.add_argument("--once", action="store_true", help="register, claim at most one job, then exit")
    args = parser.parse_args()
    settings = Settings.from_env(args.once)
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
