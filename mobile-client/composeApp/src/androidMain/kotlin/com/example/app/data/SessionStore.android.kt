package com.example.app.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Android's private per-app preferences — [Context.MODE_PRIVATE], so only this app's UID can read
 * the file. [initSessionStorage] must run before the first access; [MainActivity] does it.
 */
actual object SessionStorage {
    private const val PREFS = "com.example.app.session"
    private const val KEY = "session"

    private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        // The application context, not the activity: this object outlives any one activity, and
        // holding an activity here would leak it across a rotation.
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    actual fun load(): String? = prefs?.getString(KEY, null)

    actual fun save(value: String) {
        prefs?.edit()?.putString(KEY, value)?.apply()
    }

    actual fun clear() {
        prefs?.edit()?.remove(KEY)?.apply()
    }
}

/** Wires the store to a context. Call once, before [com.example.app.App] first composes. */
fun initSessionStorage(context: Context) = SessionStorage.init(context)
