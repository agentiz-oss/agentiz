package com.example.app.data

import platform.Foundation.NSUserDefaults

/**
 * iOS's per-app defaults database, which lives inside the app's own sandboxed container. The
 * Keychain would survive a reinstall and sync across devices; neither is wanted for a server token
 * that the user can re-obtain by signing in again.
 */
actual object SessionStorage {
    private const val KEY = "com.example.app.session"

    private val defaults: NSUserDefaults get() = NSUserDefaults.standardUserDefaults

    actual fun load(): String? = defaults.stringForKey(KEY)

    actual fun save(value: String) {
        defaults.setObject(value, KEY)
    }

    actual fun clear() {
        defaults.removeObjectForKey(KEY)
    }
}
