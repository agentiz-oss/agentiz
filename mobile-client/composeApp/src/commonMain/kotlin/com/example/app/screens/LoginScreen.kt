package com.example.app.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppButton
import com.example.app.components.AppTextField
import com.example.app.data.AGENTIZ_SERVER_URL
import com.example.app.data.AgentizApi
import com.example.app.data.ApiException
import com.example.app.data.Session
import com.example.app.data.platformDefaultBaseUrl
import com.example.app.theme.AppTheme
import com.example.app.platform.hapticActionComplete
import kotlinx.coroutines.launch

/**
 * Credential entry. Exchanges an Adminizer admin login for a bearer token via the mobile API and,
 * on success, hands a ready [Session] up to the caller. The server field is pre-filled with
 * [AGENTIZ_SERVER_URL] so the common case needs only a login and password.
 */
@Composable
fun LoginScreen(onLoggedIn: (Session) -> Unit) {
    var server by remember { mutableStateOf(platformDefaultBaseUrl()) }
    var login by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

    fun submit() {
        if (busy || login.isBlank() || password.isBlank()) return
        error = null
        busy = true
        scope.launch {
            val api = AgentizApi(server.trim())
            try {
                val result = api.login(login.trim(), password)
                hapticActionComplete()
                onLoggedIn(Session(serverUrl = server.trim(), token = result.token, user = result.user))
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Throwable) {
                error = "Не удалось подключиться к серверу: ${e.message ?: "неизвестная ошибка"}"
            } finally {
                api.close()
                busy = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppTheme.Background)
            // The login screen sits outside AppScaffold, so it applies the safe-area inset
            // itself — otherwise the form would run under the status bar on a phone.
            .windowInsetsPadding(WindowInsets.safeDrawing)
            // Before the padding, so the scrollable area is the whole screen and the last field
            // can still be scrolled clear of an open keyboard.
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(modifier = Modifier.widthIn(max = 380.dp).fillMaxWidth()) {
            Text(text = "Agentiz", style = AppTheme.Title, color = AppTheme.Foreground)
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Войдите, чтобы посмотреть свои проекты",
                style = AppTheme.Body,
                color = AppTheme.Muted,
            )
            Spacer(Modifier.height(32.dp))

            AppTextField(
                label = "Сервер",
                value = server,
                onValueChange = { server = it },
                placeholder = AGENTIZ_SERVER_URL,
                enabled = !busy,
            )
            Spacer(Modifier.height(16.dp))
            AppTextField(
                label = "Логин",
                value = login,
                onValueChange = { login = it },
                placeholder = "admin",
                enabled = !busy,
            )
            Spacer(Modifier.height(16.dp))
            AppTextField(
                label = "Пароль",
                value = password,
                onValueChange = { password = it },
                isPassword = true,
                enabled = !busy,
                imeAction = ImeAction.Done,
            )

            if (error != null) {
                Spacer(Modifier.height(16.dp))
                Text(text = error!!, style = AppTheme.Body, color = AppTheme.Danger)
            }

            Spacer(Modifier.height(24.dp))
            AppButton(
                text = if (busy) "Вход…" else "Войти",
                onClick = ::submit,
                enabled = !busy && login.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
