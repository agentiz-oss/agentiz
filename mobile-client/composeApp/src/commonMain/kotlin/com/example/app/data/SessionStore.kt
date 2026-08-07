package com.example.app.data

import kotlinx.serialization.json.Json

/**
 * The one persistent slot the app needs: the signed-in [Session], so closing the app does not sign
 * the user out. Each target backs it with whatever its platform already provides — there is no
 * database and no extra dependency behind this.
 *
 * The token is a bearer credential, so the storage chosen per target is the platform's private
 * per-app store, never a shared or world-readable one. It is still at-rest plaintext on a device
 * whose owner has root, which is the usual bar for a "keep me signed in" token with a server-side
 * expiry.
 */
expect object SessionStorage {
    fun load(): String?
    fun save(value: String)
    fun clear()
}

private val json = Json { ignoreUnknownKeys = true }

/**
 * Swapped in by tests so a UI test never reads — or writes — the developer's real signed-in
 * session. Null means "use the platform store", which is every non-test run.
 */
private var override: MutableMap<String, String>? = null

/**
 * Redirects session persistence to memory for the duration of a test, and empties it. Call from a
 * test's setup; there is no need to undo it between tests in the same process.
 */
fun useInMemorySessionStorageForTesting() {
    override = mutableMapOf()
}

/**
 * Reads back a saved session, or null when there is none. A stored value that no longer parses —
 * an older build's shape, a truncated write — is treated as no session and dropped, so a bad slot
 * can never wedge the app on the login screen.
 */
fun loadSession(): Session? {
    val raw = try {
        override?.get(KEY) ?: SessionStorage.load()
    } catch (_: Throwable) {
        null
    } ?: return null

    return try {
        json.decodeFromString<Session>(raw)
    } catch (_: Throwable) {
        clearSession()
        null
    }
}

/** Persists [session] so the next launch starts signed in. Failures are non-fatal by design. */
fun saveSession(session: Session) {
    try {
        val encoded = json.encodeToString(session)
        val slot = override
        if (slot != null) slot[KEY] = encoded else SessionStorage.save(encoded)
    } catch (_: Throwable) {
        // Persistence is a convenience: a browser with storage disabled, or a read-only home
        // directory, must not take the login itself down with it.
    }
}

/** Forgets the stored session. Called on logout and whenever the server rejects the token. */
fun clearSession() {
    try {
        val slot = override
        if (slot != null) slot.remove(KEY) else SessionStorage.clear()
    } catch (_: Throwable) {
    }
}

private const val KEY = "session"
