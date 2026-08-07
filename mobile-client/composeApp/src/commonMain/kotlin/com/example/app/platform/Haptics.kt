package com.example.app.platform

/**
 * A single short vibration marking the end of an action — the tap you feel when a login goes
 * through or a task finishes loading.
 *
 * Deliberately one-shot and parameterless: the app only ever needs "that worked", and every
 * platform below can express that with its own idiomatic primitive instead of a duration this
 * layer would have to invent. Anything richer (selection ticks, error buzzes) should become its
 * own named function rather than a parameter on this one.
 *
 * Safe to call from any target. Platforms without a motor — desktop, and browsers outside Chrome
 * on Android — do nothing rather than fail, so callers never need to guard.
 */
expect fun hapticActionComplete()
