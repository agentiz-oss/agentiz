package com.example.app.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.UIKitView
import platform.Foundation.NSURL
import platform.Foundation.NSURLRequest
import platform.WebKit.WKWebView

@Composable
actual fun EmbeddedDashboard(url: String, modifier: Modifier) {
    val drawerOpen = LocalDrawerProgress.current > 0f
    UIKitView(
        modifier = modifier,
        factory = {
            WKWebView().apply {
                NSURL.URLWithString(url)?.let { loadRequest(NSURLRequest(it)) }
            }
        },
        update = { webView ->
            // WKWebView is placed in a native UIKit layer, above Compose's graphicsLayer. Hiding
            // it also prevents invisible content from receiving taps intended for the menu.
            webView.alpha = if (drawerOpen) 0.0 else 1.0
            webView.userInteractionEnabled = !drawerOpen
        },
    )
}
