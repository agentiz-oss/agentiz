package com.example.app.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppButton
import com.example.app.components.AppScaffold
import com.example.app.components.EmbeddedDashboard
import com.example.app.components.MenuEntry
import com.example.app.data.AgentizApi
import com.example.app.data.ApiException
import com.example.app.data.Session
import com.example.app.theme.AppTheme

/**
 * A standalone destination for the Assistant. The one-use WebView link is requested only while
 * this screen is open, so returning to the previous screen disposes its API client and WebView.
 */
@Composable
fun AgentDashboardScreen(
    session: Session,
    menu: List<MenuEntry>,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val api = remember(session.serverUrl) { AgentizApi(session.serverUrl) }
    DisposableEffect(api) { onDispose { api.close() } }

    var webviewUrl by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        loading = true
        error = null
        webviewUrl = null
        try {
            // The API deliberately returns a path (for example `/api/.../webview?code=…`). A
            // WebView would resolve that against the client app's own origin, which is localhost
            // for the web build. Always attach it to the server saved in the mobile session.
            webviewUrl = assistantWebviewUrl(session.serverUrl, api.assistantWebviewSession(session.token).url)
        } catch (e: ApiException) {
            error = e.message
        } catch (e: Throwable) {
            error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
        } finally {
            loading = false
        }
    }

    AppScaffold(
        title = "Диалог с агентом",
        menu = menu,
        onBack = onBack,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
    ) {
        when {
            loading -> AgentStatus(text = "Подключаем агента…")
            error != null -> AgentError(message = error!!, onRetry = { reloadKey++ })
            webviewUrl != null -> EmbeddedDashboard(
                url = webviewUrl!!,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

/**
 * The launch endpoint belongs to the server authenticated during login. Even if a proxy returns
 * an absolute URL, retain only its path and query so a local/internal host cannot leak into the
 * embedded browser.
 */
internal fun assistantWebviewUrl(serverUrl: String, launchUrl: String): String {
    val pathAndQuery = when {
        launchUrl.startsWith('/') -> launchUrl
        "://" in launchUrl -> {
            val pathStart = launchUrl.indexOf('/', launchUrl.indexOf("://") + 3)
            if (pathStart >= 0) launchUrl.substring(pathStart) else "/"
        }
        else -> "/$launchUrl"
    }
    return serverUrl.trimEnd('/') + pathAndQuery
}

@Composable
private fun AgentStatus(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text = text, style = AppTheme.Body, color = AppTheme.Muted)
    }
}

@Composable
private fun AgentError(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = message, style = AppTheme.Body, color = AppTheme.Danger)
        AppButton(
            text = "Повторить",
            onClick = onRetry,
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
        )
    }
}
