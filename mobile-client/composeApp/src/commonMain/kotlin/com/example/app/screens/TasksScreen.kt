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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppButton
import com.example.app.components.AppScaffold
import com.example.app.components.AppTextField
import com.example.app.components.MenuEntry
import com.example.app.components.PullToRefresh
import com.example.app.data.AgentizApi
import com.example.app.data.ApiException
import com.example.app.data.LocalStore
import com.example.app.data.ProjectDto
import com.example.app.data.Session
import com.example.app.data.TaskDto
import com.example.app.theme.AppTheme
import kotlinx.coroutines.launch

/**
 * Tasks of one project: the list, plus an inline form to add one. Creating a task does not start
 * a pipeline — that is a deliberate second step on the task screen, so a half-written task is
 * never executed by accident.
 *
 * The form and the list share one scrolling column. Keeping the form pinned would cost the list
 * most of a phone screen while composing, and the two-line description field makes that worse.
 */
@Composable
fun TasksScreen(
    session: Session,
    project: ProjectDto,
    menu: List<MenuEntry>,
    onOpenTask: (TaskDto) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val api = remember(session.serverUrl) { AgentizApi(session.serverUrl) }
    DisposableEffect(api) { onDispose { api.close() } }
    val scope = rememberCoroutineScope()

    // Seeded from the last successful load for this project, same as the projects list above it.
    var tasks by remember(project.id) { mutableStateOf(LocalStore.loadTasks(project.id)) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(tasks == null) }
    var reloadKey by remember { mutableStateOf(0) }

    // A pull-to-refresh is tracked apart from `loading` so it replaces neither the list nor the
    // composer: the existing tasks stay put under the spinner until the new ones arrive.
    var refreshing by remember { mutableStateOf(false) }

    var composing by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }

    LaunchedEffect(reloadKey) {
        loading = tasks == null
        error = null
        try {
            val loaded = api.tasks(session.token, project.id)
            tasks = loaded
            LocalStore.saveTasks(project.id, loaded)
        } catch (e: ApiException) {
            error = e.message
        } catch (e: Throwable) {
            error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
        } finally {
            loading = false
            refreshing = false
        }
    }

    fun submit() {
        if (creating || title.isBlank()) return
        creating = true
        error = null
        scope.launch {
            try {
                api.createTask(session.token, project.id, title.trim(), description.trim().ifBlank { null })
                title = ""
                description = ""
                composing = false
                reloadKey++
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Throwable) {
                error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
            } finally {
                creating = false
            }
        }
    }

    AppScaffold(
        title = project.name,
        subtitle = project.slug.takeIf { it.isNotBlank() },
        menu = menu,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
        onBack = onBack,
    ) {
        // Pulling is disabled while the composer is open: the form is the first item of the same
        // list, and a refresh under a half-typed task would be an odd thing to offer mid-sentence.
        PullToRefresh(
            refreshing = refreshing,
            onRefresh = {
                refreshing = true
                reloadKey++
            },
            enabled = !composing && !creating,
            modifier = Modifier.fillMaxSize(),
        ) {
            // One lazy list for the whole screen: the form is its first item, so it scrolls away as
            // the user moves down the tasks and the list is never boxed into what is left over.
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "composer") {
                    if (composing) {
                        NewTaskForm(
                            title = title,
                            onTitleChange = { title = it },
                            description = description,
                            onDescriptionChange = { description = it },
                            busy = creating,
                            onSubmit = ::submit,
                            onCancel = {
                                composing = false
                                title = ""
                                description = ""
                            },
                        )
                    } else {
                        AppButton(
                            text = "Новая задача",
                            onClick = { composing = true },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                // A create or refresh error while the list already has content: keep the list,
                // show the reason.
                val inlineError = error?.takeIf { tasks != null }
                if (inlineError != null) {
                    item(key = "error") {
                        Text(text = inlineError, style = AppTheme.Label, color = AppTheme.Danger)
                    }
                }

                when {
                    loading && tasks == null -> item(key = "loading") {
                        CenterBlock("Загрузка задач…", AppTheme.Muted)
                    }

                    error != null && tasks == null -> item(key = "retry") {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(text = error!!, style = AppTheme.Body, color = AppTheme.Danger)
                            Spacer(Modifier.height(16.dp))
                            AppButton(text = "Повторить", onClick = { reloadKey++ })
                        }
                    }

                    tasks.isNullOrEmpty() -> item(key = "empty") {
                        CenterBlock("В проекте пока нет задач.", AppTheme.Muted)
                    }

                    else -> items(tasks!!, key = { it.id }) { task ->
                        TaskCard(task, onClick = { onOpenTask(task) })
                    }
                }
            }
        }
    }
}

/** A status line sized as a list item — the list itself owns the scrolling around it. */
@Composable
private fun CenterBlock(text: String, color: Color) {
    Box(
        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, style = AppTheme.Body, color = color)
    }
}

@Composable
private fun NewTaskForm(
    title: String,
    onTitleChange: (String) -> Unit,
    description: String,
    onDescriptionChange: (String) -> Unit,
    busy: Boolean,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
    ) {
        AppTextField(
            label = "Заголовок",
            value = title,
            onValueChange = onTitleChange,
            placeholder = "Что нужно сделать",
            enabled = !busy,
        )
        Spacer(Modifier.height(12.dp))
        AppTextField(
            label = "Описание",
            value = description,
            onValueChange = onDescriptionChange,
            placeholder = "Подробности (необязательно)",
            enabled = !busy,
            imeAction = ImeAction.Done,
            // A description is prose, not a line: let it wrap and grow rather than scrolling
            // sideways through what the user just typed.
            minLines = 3,
        )
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AppButton(
                text = if (busy) "Создание…" else "Создать",
                onClick = onSubmit,
                enabled = !busy && title.isNotBlank(),
                modifier = Modifier.weight(1f),
            )
            AppButton(text = "Отмена", onClick = onCancel, enabled = !busy)
        }
    }
}

@Composable
private fun TaskCard(task: TaskDto, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AppTheme.Radius))
            .clickable(role = Role.Button, onClick = onClick)
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = task.title,
                style = AppTheme.Body,
                color = AppTheme.Foreground,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            TaskStatusBadge(task.status)
        }
        if (task.tags.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(text = task.tags.joinToString(" · "), style = AppTheme.Label, color = AppTheme.Muted)
        }
    }
}

/**
 * Pipeline status of a task. Only the terminal-good and terminal-bad states get a strong colour;
 * everything in between stays muted so a list of in-flight tasks does not read as alarming.
 */
@Composable
fun TaskStatusBadge(status: String) {
    val (label, color) = when (status) {
        "new" -> "новая" to AppTheme.Disabled
        "queued" -> "в очереди" to AppTheme.Muted
        "running" -> "выполняется" to AppTheme.Muted
        "waiting_review" -> "на проверке" to AppTheme.Muted
        "done" -> "готово" to AppTheme.Primary
        "failed" -> "ошибка" to AppTheme.Danger
        "cancelled" -> "отменена" to AppTheme.Disabled
        "ignored" -> "пропущена" to AppTheme.Disabled
        else -> status to AppTheme.Muted
    }
    Text(
        text = label,
        style = AppTheme.Label,
        color = AppTheme.PrimaryForeground,
        modifier = Modifier
            .background(color, RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 3.dp),
    )
}
