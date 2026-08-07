package com.example.app.data

/**
 * A small persistent key-value store for cached server responses — project lists, task details,
 * run payloads — so a screen the user has already opened repaints instantly from what is on disk
 * instead of sitting on a spinner for the network again, and a finished run's heavy log/result
 * payload is downloaded at most once. Not a database: no queries, no relations, just named JSON
 * blobs. Each target backs it with whatever the platform already offers, same as [SessionStorage].
 */
expect object LocalCache {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}
