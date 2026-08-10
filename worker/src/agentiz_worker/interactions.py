"""Harness-neutral human-input broker and the OpenHands ACP elicitation adapter."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator
import uuid


@dataclass(frozen=True)
class HumanInputRequest:
    request_id: str
    message: str
    requested_schema: dict[str, Any]
    tool_call_id: str | None = None
    meta: dict[str, Any] | None = None


@dataclass(frozen=True)
class HumanInputResponse:
    action: str
    content: dict[str, Any] | None = None


class HumanInteractionBroker:
    """Persist a question, long-poll the answer and acknowledge delivery.

    The worker heartbeat runs on its own thread while this method blocks, so the job lease and the
    ACP process stay warm for the entire pause.
    """

    def __init__(
        self,
        client: Any,
        job: dict[str, Any],
        stage_execution_id: str,
        source: str,
        redact: Callable[[str], str],
    ) -> None:
        self.client = client
        self.job = job
        self.stage_execution_id = stage_execution_id
        self.source = source
        self.redact = redact

    def request_human_input(self, request: HumanInputRequest) -> HumanInputResponse:
        created = self.client.post(f"/jobs/{self.job['jobId']}/interactions", self.job, {
            "externalRequestId": request.request_id,
            "stageExecutionId": self.stage_execution_id,
            "kind": "elicitation",
            "source": self.source,
            "message": self.redact(request.message),
            "requestedSchema": self._redact_json(request.requested_schema),
            "toolCallId": request.tool_call_id,
            "meta": self._redact_json(request.meta or {}),
        })
        interaction = (created or {}).get("interaction") or {}
        interaction_id = interaction.get("id")
        if not interaction_id:
            raise RuntimeError("Agentiz did not return an interaction id")

        while True:
            result = self.client.post(
                f"/jobs/{self.job['jobId']}/interactions/{interaction_id}/wait",
                self.job,
                {"waitMs": 25_000},
            )
            if not result or not result.get("response"):
                continue
            response = result["response"]
            action = str(response.get("action") or "cancel")
            content = response.get("content") if action == "accept" and isinstance(response.get("content"), dict) else None
            # ACK is the boundary after which Agentiz may show the stage as running again. Build the
            # response first, acknowledge, then return it to the waiting ACP callback immediately.
            answer = HumanInputResponse(action=action, content=content)
            self.client.post(f"/jobs/{self.job['jobId']}/interactions/{interaction_id}/ack", self.job, {})
            return answer

    def _redact_json(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            return [self._redact_json(item) for item in value]
        if isinstance(value, dict):
            return {str(key): self._redact_json(item) for key, item in value.items()}
        return value


def _model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return value
    return value


def _response_for_acp(response: HumanInputResponse) -> Any:
    from acp.schema import AcceptElicitationResponse, CancelElicitationResponse, DeclineElicitationResponse

    if response.action == "accept":
        return AcceptElicitationResponse(action="accept", content=response.content or {})
    if response.action == "decline":
        return DeclineElicitationResponse(action="decline")
    return CancelElicitationResponse(action="cancel")


def request_from_acp(message: str, mode: Any, kwargs: dict[str, Any]) -> HumanInputRequest | None:
    """Normalize both ACP 0.12's scoped mode union and the older flattened callback shape."""
    raw_mode = getattr(mode, "root", mode)
    mode_payload = _model_dump(raw_mode)
    is_form = (
        isinstance(mode_payload, dict) and "requestedSchema" in mode_payload
    ) or str(getattr(raw_mode, "value", raw_mode)) == "form"
    if not is_form:
        return None
    scoped = mode_payload if isinstance(mode_payload, dict) else {}
    requested_schema = _model_dump(
        scoped.get("requestedSchema")
        or kwargs.get("requested_schema")
        or kwargs.get("requestedSchema")
        or {}
    )
    return HumanInputRequest(
        request_id=str(scoped.get("requestId") or kwargs.get("request_id") or kwargs.get("requestId") or uuid.uuid4()),
        message=message,
        requested_schema=requested_schema if isinstance(requested_schema, dict) else {},
        tool_call_id=scoped.get("toolCallId") or kwargs.get("tool_call_id") or kwargs.get("toolCallId"),
        meta=_model_dump(kwargs.get("_meta")) if kwargs.get("_meta") else None,
    )


@contextmanager
def install_acp_human_input(broker: HumanInteractionBroker) -> Iterator[None]:
    """Expose form elicitation through OpenHands 1.40's otherwise private ACP bridge.

    OpenHands constructs both objects inside ``ACPAgent._start_acp_server``. Replacing those two
    module globals for the duration of one conversation keeps all of OpenHands' session, masking,
    retry and event logic intact while adding only the missing protocol callback/capability.
    A worker executes one job at a time, so no second ACP conversation can observe the patch.
    """

    import openhands.sdk.agent.acp_agent as acp_agent_module
    from acp.schema import ClientCapabilities, ElicitationCapabilities, ElicitationFormCapabilities

    original_bridge = acp_agent_module._OpenHandsACPBridge
    original_connection = acp_agent_module.ClientSideConnection

    class AgentizACPBridge(original_bridge):
        async def create_elicitation(self, message: str, mode: Any, **kwargs: Any) -> Any:
            request = request_from_acp(message, mode, kwargs)
            if request is None:
                return _response_for_acp(HumanInputResponse(action="cancel"))
            response = await asyncio.to_thread(broker.request_human_input, request)
            return _response_for_acp(response)

        async def complete_elicitation(self, elicitation_id: str, **kwargs: Any) -> None:
            # Agent-driven completion is meaningful for URL/out-of-band flows. Agentiz MVP exposes
            # form mode only, whose request is complete once create_elicitation returns.
            return None

    class AgentizClientSideConnection(original_connection):
        async def initialize(
            self,
            protocol_version: int,
            client_capabilities: Any = None,
            client_info: Any = None,
            **kwargs: Any,
        ) -> Any:
            capabilities = client_capabilities or ClientCapabilities()
            capabilities.elicitation = ElicitationCapabilities(form=ElicitationFormCapabilities())
            return await super().initialize(
                protocol_version=protocol_version,
                client_capabilities=capabilities,
                client_info=client_info,
                **kwargs,
            )

    acp_agent_module._OpenHandsACPBridge = AgentizACPBridge
    acp_agent_module.ClientSideConnection = AgentizClientSideConnection
    try:
        yield
    finally:
        acp_agent_module._OpenHandsACPBridge = original_bridge
        acp_agent_module.ClientSideConnection = original_connection
