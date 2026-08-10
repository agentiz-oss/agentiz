from __future__ import annotations

import unittest

from agentiz_worker.interactions import HumanInputRequest, HumanInteractionBroker, request_from_acp
from agentiz_worker.main import pin_acp_command


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
            ["npx", "-y", "@agentclientprotocol/codex-acp@1.1.14"],
        )
        self.assertEqual(
            pin_acp_command(["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.1.0"]),
            ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"],
        )

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
