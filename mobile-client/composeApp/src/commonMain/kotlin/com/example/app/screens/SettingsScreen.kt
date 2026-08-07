package com.example.app.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppScaffold
import com.example.app.components.MenuEntry
import com.example.app.components.SettingsIcon
import com.example.app.theme.AppTheme

/**
 * Settings — a placeholder. It exists so the cog in the drawer has somewhere to lead while the
 * actual preferences are still being decided, and says as much rather than showing an empty page
 * that reads as a loading failure.
 */
@Composable
fun SettingsScreen(
    menu: List<MenuEntry>,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    AppScaffold(
        title = "Настройки",
        menu = menu,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
        onBack = onBack,
    ) {
        PlaceholderBody(
            headline = "Настройки появятся позже",
            note = "Здесь будут параметры приложения и подключения к серверу.",
        ) { SettingsIcon(tint = AppTheme.Disabled, size = 48.dp) }
    }
}

/**
 * The shared body of a not-yet-built screen: a large muted glyph, what the page will be, and one
 * line on what will live here. Scrollable so the text is never clipped on a short window.
 */
@Composable
internal fun PlaceholderBody(
    headline: String,
    note: String,
    icon: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        icon()
        Spacer(Modifier.height(16.dp))
        Text(text = headline, style = AppTheme.Subtitle, color = AppTheme.Foreground)
        Spacer(Modifier.height(8.dp))
        Text(text = note, style = AppTheme.Body, color = AppTheme.Muted)
    }
}
