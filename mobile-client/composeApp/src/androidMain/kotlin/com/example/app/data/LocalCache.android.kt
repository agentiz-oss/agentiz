package com.example.app.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Its own private-preferences file, separate from [SessionStorage]'s, so clearing cached server
 * data on logout never risks touching the session prefs and vice versa. [LocalCache.init] must run
 * before the first access; [com.example.app.MainActivity] does it alongside [initSessionStorage].
 */
actual object LocalCache {
    private const val PREFS = "com.example.app.cache"

    private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    actual fun get(key: String): String? = prefs?.getString(key, null)

    actual fun put(key: String, value: String) {
        prefs?.edit()?.putString(key, value)?.apply()
    }

    actual fun remove(key: String) {
        prefs?.edit()?.remove(key)?.apply()
    }
}

/** Wires the cache to a context. Call once, before [com.example.app.App] first composes. */
fun initLocalCache(context: Context) = LocalCache.init(context)
