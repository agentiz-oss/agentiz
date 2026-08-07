package com.example.app

import com.example.app.screens.assistantWebviewUrl
import kotlin.test.Test
import kotlin.test.assertEquals

class AgentDashboardScreenTest {

    @Test
    fun webviewLaunchUsesTheServerFromTheSessionForARelativeUrl() {
        assertEquals(
            "https://agentiz.example/api/agentiz/mobile/v1/assistant/webview?code=abc",
            assistantWebviewUrl(
                serverUrl = "https://agentiz.example/",
                launchUrl = "/api/agentiz/mobile/v1/assistant/webview?code=abc",
            ),
        )
    }

    @Test
    fun webviewLaunchDoesNotKeepALocalHostReturnedByAProxy() {
        assertEquals(
            "https://agentiz.example/api/agentiz/mobile/v1/assistant/webview?code=abc",
            assistantWebviewUrl(
                serverUrl = "https://agentiz.example",
                launchUrl = "http://localhost:17280/api/agentiz/mobile/v1/assistant/webview?code=abc",
            ),
        )
    }
}
