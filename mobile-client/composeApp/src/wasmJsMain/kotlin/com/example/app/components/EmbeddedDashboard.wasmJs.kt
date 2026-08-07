package com.example.app.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier

/**
 * Compose for web is canvas-based here, so an actual HTML iframe is layered over the Assistant
 * screen's content area. It is removed as soon as the screen leaves composition.
 */
@Composable
actual fun EmbeddedDashboard(url: String, modifier: Modifier) {
    val drawerOpen = LocalDrawerProgress.current > 0f
    DisposableEffect(url) {
        appendDashboardFrame(url)
        onDispose {
            removeDashboardFrame()
        }
    }
    SideEffect {
        if (drawerOpen) hideDashboardFrame() else showDashboardFrame()
    }
}

private fun appendDashboardFrame(url: String) {
    js("""
        (() => {
            const frame = document.createElement('iframe');
            frame.id = 'agentiz-dashboard-frame';
            frame.src = url;
            frame.title = 'Диалог с агентом';
            // Size from the fixed-position containing viewport instead of `vh`: mobile browsers
            // change their visual viewport when the URL bar appears, which otherwise leaves a
            // white strip below the dashboard.
            frame.style.cssText = 'position:fixed;top:64px;left:0;width:100%;height:calc(100% - 64px);border:0;background:white;z-index:2';
            document.body.appendChild(frame);
        })()
    """)
}

private fun removeDashboardFrame() {
    js("document.getElementById('agentiz-dashboard-frame')?.remove()")
}

private fun hideDashboardFrame() {
    js("""
        (() => {
            const frame = document.getElementById('agentiz-dashboard-frame');
            if (frame) { frame.style.visibility = 'hidden'; frame.style.pointerEvents = 'none'; }
        })()
    """)
}

private fun showDashboardFrame() {
    js("""
        (() => {
            const frame = document.getElementById('agentiz-dashboard-frame');
            if (frame) { frame.style.visibility = 'visible'; frame.style.pointerEvents = 'auto'; }
        })()
    """)
}
