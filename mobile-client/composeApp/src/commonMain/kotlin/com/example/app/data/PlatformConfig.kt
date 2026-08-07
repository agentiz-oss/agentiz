package com.example.app.data

/**
 * The Agentiz deployment the app talks to unless the login screen's "Server" field points it
 * elsewhere. Must stay https: the host answers on port 80 only to redirect there, and a 301 is no
 * use to a POST carrying a body.
 */
const val AGENTIZ_SERVER_URL = "https://agentiz.m42.cx"

/**
 * Origin the login screen starts on. Every target answers [AGENTIZ_SERVER_URL] today; the seam is
 * here for the platforms that cannot always reach it as written — an Android emulator pointed at a
 * server on the host machine, say, has to go through 10.0.2.2.
 */
expect fun platformDefaultBaseUrl(): String
