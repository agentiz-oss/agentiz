package com.example.app.components

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
actual fun EmbeddedDashboard(url: String, modifier: Modifier) {
    val drawerOpen = LocalDrawerProgress.current > 0f
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = WebViewClient()
                loadUrl(url)
            }
        },
        update = { webView ->
            // Keep behaviour consistent with platforms where the native view cannot inherit the
            // drawer's Compose transform.
            webView.visibility = if (drawerOpen) android.view.View.INVISIBLE else android.view.View.VISIBLE
            webView.isEnabled = !drawerOpen
        },
    )
}
