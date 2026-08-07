package com.example.app.data

import kotlinx.browser.localStorage
import org.w3c.dom.get

/**
 * The browser's `localStorage`, scoped to the page's origin. Every access is guarded: a browser
 * with site data blocked, or a page in a partitioned third-party context, throws on the very first
 * read rather than returning null.
 */
actual object SessionStorage {
    private const val KEY = "com.example.app.session"

    actual fun load(): String? = try {
        localStorage[KEY]
    } catch (_: Throwable) {
        null
    }

    actual fun save(value: String) {
        try {
            localStorage.setItem(KEY, value)
        } catch (_: Throwable) {
        }
    }

    actual fun clear() {
        try {
            localStorage.removeItem(KEY)
        } catch (_: Throwable) {
        }
    }
}
