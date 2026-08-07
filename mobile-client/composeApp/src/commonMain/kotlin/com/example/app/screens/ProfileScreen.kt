package com.example.app.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppScaffold
import com.example.app.components.LogoutIcon
import com.example.app.components.MenuEntry
import com.example.app.components.PersonIcon
import com.example.app.data.Session
import com.example.app.theme.AppTheme

/**
 * The account page. Mostly a placeholder — who is signed in, and against which server — but it is
 * also where signing out now lives.
 *
 * Moving logout off the drawer list and onto this page is deliberate: the drawer is for navigating,
 * and a destructive action sitting one slip away from the entry above it does not belong in a list
 * you flick through. Behind the person icon it takes a considered tap to reach.
 */
@Composable
fun ProfileScreen(
    session: Session,
    menu: List<MenuEntry>,
    onLogout: () -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val fullName = session.user.fullName?.takeIf { it.isNotBlank() }

    AppScaffold(
        title = "Профиль",
        menu = menu,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
        onBack = onBack,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(88.dp)
                    .clip(CircleShape)
                    .background(AppTheme.Surface)
                    .border(1.dp, AppTheme.Border, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                PersonIcon(tint = AppTheme.Muted, size = 44.dp)
            }

            Spacer(Modifier.height(16.dp))
            Text(
                text = fullName ?: session.user.login,
                style = AppTheme.Subtitle,
                color = AppTheme.Foreground,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // Only when it adds something: with no full name the heading is already the login, and
            // repeating it underneath reads as a rendering bug.
            if (fullName != null) {
                Spacer(Modifier.height(4.dp))
                Text(text = session.user.login, style = AppTheme.Label, color = AppTheme.Muted)
            }

            Spacer(Modifier.height(24.dp))
            InfoRow(label = "Сервер", value = session.serverUrl)

            Spacer(Modifier.height(24.dp))
            LogoutRow(onClick = onLogout)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
    ) {
        Text(text = label, style = AppTheme.Label, color = AppTheme.Muted)
        Spacer(Modifier.height(4.dp))
        Text(
            text = value,
            style = AppTheme.Body,
            color = AppTheme.Foreground,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Signing out, as a full-width row in the danger colour. Bordered rather than filled: a solid red
 * block on an otherwise monochrome page pulls the eye harder than the action deserves.
 */
@Composable
private fun LogoutRow(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AppTheme.Radius))
            .clickable(role = Role.Button, onClick = onClick)
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        LogoutIcon(tint = AppTheme.Danger)
        Spacer(Modifier.size(8.dp))
        Text(text = "Выйти", style = AppTheme.ButtonLabel, color = AppTheme.Danger)
    }
}
