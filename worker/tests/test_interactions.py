from __future__ import annotations

import unittest
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from agentiz_worker.codex_acp import CodexAcpPatchError, patch_openai_form_elicitation
from agentiz_worker.interactions import HumanInputRequest, HumanInteractionBroker, request_from_acp
from agentiz_worker.main import WorkerError, pin_acp_command, stage_config


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.waits = 0

    def post(self, path: str, job: dict, payload: dict):
        self.calls.append((path, payload))
        if path.endswith("/interactions"):
            return {"interaction": {"id": "interaction-1"}}
        if path.endswith("/wait"):
            self.waits += 1
            if self.waits == 1:
                return None
            return {"response": {"action": "accept", "content": {"strategy": "safe"}}}
        if path.endswith("/ack"):
            return {"interaction": {"status": "delivered"}}
        raise AssertionError(path)


class HumanInteractionBrokerTest(unittest.TestCase):
    def test_known_acp_adapters_are_pinned(self) -> None:
        self.assertEqual(
            pin_acp_command(["npx", "-y", "@agentclientprotocol/codex-acp"]),
            [sys.executable, "-m", "agentiz_worker.codex_acp"],
        )
        self.assertEqual(
            pin_acp_command(["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.1.0"]),
            ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"],
        )

    def test_codex_adapter_patch_adds_only_form_capability(self) -> None:
        with TemporaryDirectory() as directory:
            entry = Path(directory) / "index.js"
            entry.write_text(
                "capabilities: {\n        experimentalApi: true,\n        requestAttestation: false\n      }\n"
                "    if (!clientSupportsFormElicitation(this.clientCapabilities)) {\n"
                "      return { answers: {} };\n"
                "    }\n"
                "    if (params.autoResolutionMs === null) {\n"
                "      return await this.connection.request(\n"
                "        methods.client.elicitation.create,\n"
                "        request,\n"
                "        this.requestOptions()\n"
                "      );\n"
                "    }\n"
            )
            patch_openai_form_elicitation(entry)
            patched = entry.read_text()
            self.assertIn("mcpServerOpenaiFormElicitation: true", patched)
            self.assertNotIn("clientSupportsFormElicitation(this.clientCapabilities)", patched)
            self.assertNotIn("if (params.autoResolutionMs === null)", patched)
            self.assertIn("Agentiz questions must remain open until the person responds", patched)
            patch_openai_form_elicitation(entry)

    def test_codex_adapter_patch_refuses_unknown_build(self) -> None:
        with TemporaryDirectory() as directory:
            entry = Path(directory) / "index.js"
            entry.write_text("not the adapter")
            with self.assertRaises(CodexAcpPatchError):
                patch_openai_form_elicitation(entry)

    def test_codex_plan_mode_is_an_explicit_role_opt_in(self) -> None:
        stage = {
            "runtime": {"mode": "host"},
            "agent": {
                "kind": "openhands-acp",
                "config": {
                    "acpCommand": ["npx", "-y", "@agentclientprotocol/codex-acp"],
                    "collaborationMode": "plan",
                },
            },
        }
        self.assertEqual(stage_config(stage)[4], "plan")
        stage["agent"]["config"]["collaborationMode"] = "interactive"
        with self.assertRaises(WorkerError):
            stage_config(stage)

    def test_acp_012_scoped_form_is_normalized(self) -> None:
        class FormMode:
            def model_dump(self, **kwargs):
                return {
                    "sessionId": "session-1",
                    "toolCallId": "tool-1",
                    "requestedSchema": {"type": "object", "properties": {"choice": {"type": "string"}}},
                }

        request = request_from_acp("Choose", FormMode(), {})
        self.assertIsNotNone(request)
        self.assertEqual(request.tool_call_id, "tool-1")
        self.assertEqual(request.requested_schema["properties"]["choice"]["type"], "string")

    def test_question_wait_answer_ack_round_trip(self) -> None:
        client = FakeClient()
        job = {"jobId": "job-1", "attempt": 2, "leaseToken": "lease"}
        broker = HumanInteractionBroker(client, job, "stage-1", "codex", lambda text: text.replace("secret", "[redacted]"))

        response = broker.request_human_input(HumanInputRequest(
            request_id="request-1",
            message="Choose without secret",
            requested_schema={
                "type": "object",
                "properties": {"strategy": {"type": "string", "enum": ["safe", "fast"]}},
                "required": ["strategy"],
            },
        ))

        self.assertEqual(response.action, "accept")
        self.assertEqual(response.content, {"strategy": "safe"})
        self.assertEqual(client.waits, 2)
        self.assertTrue(client.calls[-1][0].endswith("/ack"))
        self.assertEqual(client.calls[0][1]["message"], "Choose without [redacted]")

    def test_human_input_bridge_enables_unstable_acp_extension(self) -> None:
        # The actual router is constructed by OpenHands at runtime.  Keep this assertion close to
        # the bridge so a future refactor cannot silently reintroduce its default False value.
        from inspect import getsource
        from agentiz_worker.interactions import install_acp_human_input

        self.assertIn('kwargs["use_unstable_protocol"] = True', getsource(install_acp_human_input))

    def test_cancel_has_no_content(self) -> None:
        class CancelClient(FakeClient):
            def post(self, path: str, job: dict, payload: dict):
                if path.endswith("/wait"):
                    return {"response": {"action": "cancel", "content": None}}
                return super().post(path, job, payload)

        response = HumanInteractionBroker(
            CancelClient(), {"jobId": "job-1"}, "stage-1", "acp", lambda value: value,
        ).request_human_input(HumanInputRequest("request-1", "Question", {"type": "object", "properties": {}}))
        self.assertEqual(response.action, "cancel")
        self.assertIsNone(response.content)


if __name__ == "__main__":
    unittest.main()
