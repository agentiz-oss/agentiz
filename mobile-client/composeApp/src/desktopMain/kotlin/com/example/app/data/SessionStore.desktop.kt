package com.example.app.data

import java.io.File

/**
 * A single file under the user's home directory. Created with owner-only permissions where the
 * filesystem supports it, so another account on a shared machine cannot read the token.
 */
actual object SessionStorage {
    private val file: File by lazy {
        File(System.getProperty("user.home"), ".agentiz/session.json")
    }

    actual fun load(): String? = try {
        file.takeIf { it.isFile }?.readText()?.takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
        null
    }

    actual fun save(value: String) {
        val dir = file.parentFile
        if (dir != null && !dir.exists()) {
            dir.mkdirs()
            restrictToOwner(dir)
        }
        file.writeText(value)
        // Applied after the write: on a fresh file the mode has to be set on something that
        // exists, and re-applying it on every save keeps a hand-loosened file from staying open.
        restrictToOwner(file)
    }

    actual fun clear() {
        try {
            file.delete()
        } catch (_: Throwable) {
        }
    }

    /** Best-effort chmod 700/600. A no-op on filesystems without POSIX permissions. */
    private fun restrictToOwner(target: File) {
        try {
            target.setReadable(false, false)
            target.setWritable(false, false)
            target.setExecutable(false, false)
            target.setReadable(true, true)
            target.setWritable(true, true)
            if (target.isDirectory) target.setExecutable(true, true)
        } catch (_: Throwable) {
        }
    }
}
