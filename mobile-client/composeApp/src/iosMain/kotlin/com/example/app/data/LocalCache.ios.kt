package com.example.app.data

import platform.Foundation.NSUserDefaults

/** Same per-app defaults database [SessionStorage] uses, under its own key prefix. */
actual object LocalCache {
    private const val PREFIX = "com.example.app.cache."

    private val defaults: NSUserDefaults get() = NSUserDefaults.standardUserDefaults

    actual fun get(key: String): String? = defaults.stringForKey(PREFIX + key)

    actual fun put(key: String, value: String) {
        defaults.setObject(value, PREFIX + key)
    }

    actual fun remove(key: String) {
        defaults.removeObjectForKey(PREFIX + key)
    }
}
