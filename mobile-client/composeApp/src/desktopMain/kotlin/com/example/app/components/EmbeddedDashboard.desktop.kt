package com.example.app.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import com.composeunstyled.Text
import com.example.app.theme.AppTheme
import java.awt.Desktop
import java.net.URI

@Composable
actual fun EmbeddedDashboard(url: String, modifier: Modifier) {
    // Swing's JEditorPane does not execute JavaScript, while the assistant is a streaming web
    // application. Open it in the user's real browser, which also has a proper cookie store for
    // the one-use WebView session bridge.
    LaunchedEffect(url) {
        runCatching {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI(url))
            }
        }
    }
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = "Агент открыт в браузере",
            style = AppTheme.Body,
            color = AppTheme.Muted,
        )
    }
}
