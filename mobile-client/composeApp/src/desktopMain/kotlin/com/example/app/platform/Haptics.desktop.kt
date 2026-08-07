package com.example.app.platform

/** Desktop machines have no vibration motor, so completing an action is signalled visually only. */
actual fun hapticActionComplete() {
    // Intentionally empty.
}
