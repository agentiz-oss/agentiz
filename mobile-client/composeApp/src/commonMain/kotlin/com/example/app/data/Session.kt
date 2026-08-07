package com.example.app.data

import kotlinx.serialization.Serializable

/** Everything the app needs after a successful login: where the server is, the token, and who. */
@Serializable
data class Session(
    val serverUrl: String,
    val token: String,
    val user: UserDto,
)
