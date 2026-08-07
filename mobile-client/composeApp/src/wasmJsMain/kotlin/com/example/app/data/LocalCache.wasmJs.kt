package com.example.app.data

import kotlinx.browser.localStorage
import org.w3c.dom.get

/**
 * The browser's `localStorage`, same origin-scoped store [SessionStorage] uses, under its own key
 * prefix so cache entries and the session token never collide.
 */
actual object LocalCache {
    private const val PREFIX = "com.example.app.cache."

    actual fun get(key: String): String? = try {
        localStorage[PREFIX + key]
    } catch (_: Throwable) {
        null
    }

    actual fun put(key: String, value: String) {
        try {
            localStorage.setItem(PREFIX + key, value)
        } catch (_: Throwable) {
        }
    }

    actual fun remove(key: String) {
        try {
            localStorage.removeItem(PREFIX + key)
        } catch (_: Throwable) {
        }
    }
}
