package com.example.app.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppButton
import com.example.app.components.AppScaffold
import com.example.app.components.MenuEntry
import com.example.app.components.PullToRefresh
import com.example.app.data.AgentizApi
import com.example.app.data.ApiException
import com.example.app.data.LocalStore
import com.example.app.data.ProjectDto
import com.example.app.data.Session
import com.example.app.theme.AppTheme

/**
 * The post-login screen: lists the projects the signed-in admin owns, fetched from the mobile API.
 * Handles the four states a network list has — loading, error (with retry), empty, and populated.
 */
@Composable
fun ProjectsScreen(
    session: Session,
    menu: List<MenuEntry>,
    userLabel: String,
    onOpenProject: (ProjectDto) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val api = remember(session.serverUrl) { AgentizApi(session.serverUrl) }
    DisposableEffect(api) { onDispose { api.close() } }

    // Seeded from the last successful load so a returning user sees their projects immediately;
    // `loading` only ever gates the spinner for a screen that has nothing cached to show yet.
    var projects by remember { mutableStateOf(LocalStore.loadProjects()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(projects == null) }
    var reloadKey by remember { mutableStateOf(0) }

    // A pull-to-refresh is tracked apart from `loading` so it replaces neither the list nor the
    // error state: the old content stays put under the spinner until the new content arrives.
    var refreshing by remember { mutableStateOf(false) }

    LaunchedEffect(reloadKey) {
        loading = projects == null
        error = null
        try {
            val loaded = api.projects(session.token)
            projects = loaded
            LocalStore.saveProjects(loaded)
        } catch (e: ApiException) {
            error = e.message
        } catch (e: Throwable) {
            error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
        } finally {
            loading = false
            refreshing = false
        }
    }

    AppScaffold(
        title = "Проекты",
        subtitle = userLabel,
        menu = menu,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
    ) {
        when {
            loading && projects == null -> CenterMessage("Загрузка проектов…")
            error != null && projects == null -> RetryState(message = error!!, onRetry = { reloadKey++ })
            else -> PullToRefresh(
                refreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    reloadKey++
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    // Padding as content rather than on the list: the cards then scroll under the
                    // top bar's edge instead of stopping short of it, and the last one clears the
                    // bottom.
                    contentPadding = PaddingValues(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // A failed refresh keeps the list it could not replace and states why above it.
                    error?.let { message ->
                        item(key = "error") {
                            Text(text = message, style = AppTheme.Label, color = AppTheme.Danger)
                        }
                    }

                    if (projects.isNullOrEmpty()) {
                        // Still a lazy list rather than a plain box: an empty project list has to
                        // stay pullable, or the only way out of it would be to leave the screen.
                        item(key = "empty") {
                            Box(
                                modifier = Modifier.fillParentMaxSize(),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "У вас пока нет проектов.",
                                    style = AppTheme.Body,
                                    color = AppTheme.Muted,
                                )
                            }
                        }
                    } else {
                        items(projects!!, key = { it.id }) { project ->
                            ProjectCard(project, onClick = { onOpenProject(project) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectCard(project: ProjectDto, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            // Clipped before the click so the press highlight follows the rounded card edge.
            .clip(RoundedCornerShape(AppTheme.Radius))
            .clickable(role = Role.Button, onClick = onClick)
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(20.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = project.name,
                style = AppTheme.Subtitle,
                color = AppTheme.Foreground,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            StatusBadge(active = project.isActive)
        }
        if (project.slug.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(text = project.slug, style = AppTheme.Label, color = AppTheme.Muted)
        }
        val description = project.description?.takeIf { it.isNotBlank() }
        if (description != null) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = description,
                style = AppTheme.Body,
                color = AppTheme.Muted,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StatusBadge(active: Boolean) {
    val color = if (active) AppTheme.Primary else AppTheme.Disabled
    Text(
        text = if (active) "активен" else "выключен",
        style = AppTheme.Label,
        color = AppTheme.PrimaryForeground,
        modifier = Modifier
            .background(color, RoundedCornerShape(999.dp))
            .padding(horizontal = 12.dp, vertical = 4.dp),
    )
}

/**
 * A centred status line. Scrollable because it is also the error surface: a long message from the
 * server must stay readable on a short window rather than being clipped top and bottom.
 */
@Composable
fun CenterMessage(text: String) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = text, style = AppTheme.Body, color = AppTheme.Muted)
    }
}

@Composable
fun RetryState(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = message, style = AppTheme.Body, color = AppTheme.Danger)
        Spacer(Modifier.height(16.dp))
        AppButton(text = "Повторить", onClick = onRetry)
    }
}
