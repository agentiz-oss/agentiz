package com.example.app.data

import java.io.File

/**
 * One file per key under the same `.agentiz` directory [SessionStorage] uses, in its own `cache`
 * subdirectory so clearing the session never has to know about cache entries or vice versa.
 */
actual object LocalCache {
    private val dir: File by lazy {
        File(System.getProperty("user.home"), ".agentiz/cache")
    }

    private fun fileFor(key: String): File {
        // Keys carry ':' as a namespace separator (e.g. "task:123:detail"); neither that nor most
        // punctuation is safe in a filename on every OS this target ships on, so anything outside
        // a conservative allowlist is replaced rather than trusted verbatim.
        val safe = key.map { c -> if (c.isLetterOrDigit() || c == '-' || c == '_') c else '_' }.joinToString("")
        return File(dir, "$safe.json")
    }

    actual fun get(key: String): String? = try {
        fileFor(key).takeIf { it.isFile }?.readText()?.takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
        null
    }

    actual fun put(key: String, value: String) {
        try {
            if (!dir.exists()) dir.mkdirs()
            fileFor(key).writeText(value)
        } catch (_: Throwable) {
        }
    }

    actual fun remove(key: String) {
        try {
            fileFor(key).delete()
        } catch (_: Throwable) {
        }
    }
}
