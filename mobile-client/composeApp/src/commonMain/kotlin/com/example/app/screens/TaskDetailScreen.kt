package com.example.app.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.components.AppButton
import com.example.app.components.AppScaffold
import com.example.app.components.AppTextField
import com.example.app.components.MenuEntry
import com.example.app.data.AgentizApi
import com.example.app.data.ApiException
import com.example.app.data.CommentDto
import com.example.app.data.LocalStore
import com.example.app.data.RunDto
import com.example.app.data.Session
import com.example.app.data.TaskDetailDto
import com.example.app.data.TaskDto
import com.example.app.theme.AppTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Pipeline states that mean the worker is still holding the task. */
private val ACTIVE_TASK_STATES = setOf("queued", "running")

/**
 * One task: what it is, what its last pipeline run concluded, and the discussion around it.
 *
 * A run is executed by a worker out of band, so "Запустить" only enqueues it. While the task sits
 * in an active state the screen re-polls on a timer — that is what turns the queued run into a
 * visible result and the agent's report into a new comment without the reader doing anything.
 */
@Composable
fun TaskDetailScreen(
    session: Session,
    taskId: String,
    menu: List<MenuEntry>,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
    onOpenRun: (run: RunDto, number: Int) -> Unit,
) {
    val api = remember(session.serverUrl) { AgentizApi(session.serverUrl) }
    DisposableEffect(api) { onDispose { api.close() } }
    val scope = rememberCoroutineScope()

    // Seeded from disk before the first network round-trip, so a task the user has already opened
    // repaints instantly on return instead of showing "Загрузка задачи…" again. `cachedNonce` is
    // the comment count the cache was written with — a fresh fetch that comes back with the same
    // count changed nothing in the thread, so nothing here needs to jar the reader mid-read.
    val cached = remember(taskId) { LocalStore.loadTaskDetail(taskId) }
    var detail by remember { mutableStateOf(cached?.detail) }
    var cachedNonce by remember { mutableStateOf(cached?.commentNonce) }
    var runs by remember { mutableStateOf(LocalStore.loadRuns(taskId)) }
    var cancellingRunId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var comment by remember { mutableStateOf("") }

    suspend fun load() {
        try {
            val loadedDetail = api.task(session.token, taskId)
            val loadedRuns = api.runs(session.token, taskId)
            detail = loadedDetail
            runs = loadedRuns
            // The nonce this task was last written with: a poll tick that comes back with the same
            // comment count changed nothing worth persisting again, so an active run's every-2s
            // refresh does not also mean an every-2s disk/localStorage write for the life of it.
            if (loadedDetail.comments.size != cachedNonce) {
                cachedNonce = LocalStore.saveTaskDetail(taskId, loadedDetail).commentNonce
                LocalStore.saveRuns(taskId, loadedRuns)
            }
            if (cancellingRunId != null && loadedRuns.firstOrNull { it.id == cancellingRunId }?.status !in ACTIVE_RUN_STATES) {
                cancellingRunId = null
            }
            error = null
        } catch (e: ApiException) {
            error = e.message
        } catch (e: Throwable) {
            error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
        }
    }

    LaunchedEffect(taskId, reloadKey) { load() }

    // Poll only while something is actually in flight; a finished task costs no requests.
    val active = detail?.latestRun?.status in ACTIVE_RUN_STATES || detail?.task?.status in ACTIVE_TASK_STATES
    LaunchedEffect(taskId, active) {
        while (active) {
            delay(2000)
            load()
        }
    }

    fun runPipeline() {
        if (busy) return
        busy = true
        scope.launch {
            try {
                api.runTask(session.token, taskId)
                load()
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Throwable) {
                error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
            } finally {
                busy = false
            }
        }
    }

    fun submitComment() {
        if (busy || comment.isBlank()) return
        busy = true
        scope.launch {
            try {
                api.addComment(session.token, taskId, comment.trim())
                comment = ""
                load()
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Throwable) {
                error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
            } finally {
                busy = false
            }
        }
    }

    fun cancelPipeline() {
        val run = currentRun(detail, runs) ?: return
        if (busy || run.status !in ACTIVE_RUN_STATES) return
        busy = true
        cancellingRunId = run.id
        scope.launch {
            try {
                api.cancelRun(session.token, taskId, run.id)
                load()
            } catch (e: ApiException) {
                error = e.message
                cancellingRunId = null
            } catch (e: Throwable) {
                error = "Ошибка сети: ${e.message ?: "неизвестная ошибка"}"
                cancellingRunId = null
            } finally {
                busy = false
            }
        }
    }

    val current = detail
    AppScaffold(
        title = current?.task?.title ?: "Задача",
        subtitle = current?.task?.externalId?.takeIf { it.isNotBlank() },
        menu = menu,
        onOpenSettings = onOpenSettings,
        onOpenProfile = onOpenProfile,
        onBack = onBack,
    ) {
        when {
            current == null && error != null -> RetryState(message = error!!, onRetry = { reloadKey++ })
            current == null -> CenterMessage("Загрузка задачи…")
            else -> {
                // One requester per run, keyed by id, shared between the quick-jump links above and
                // the history cards below — a link asks the requester for the card that owns the
                // same run id to scroll itself into view.
                val runList = runs.orEmpty()
                val bringIntoViewRequesters = remember(runList.map { it.id }) {
                    runList.associate { it.id to BringIntoViewRequester() }
                }

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(24.dp),
                ) {
                    TaskSummary(current.task)

                    if (error != null) {
                        Spacer(Modifier.height(12.dp))
                        Text(text = error!!, style = AppTheme.Label, color = AppTheme.Danger)
                    }

                    Spacer(Modifier.height(16.dp))
                    AppButton(
                        text = when {
                            busy -> "…"
                            current.task.status in ACTIVE_TASK_STATES -> "Выполняется…"
                            current.latestRun == null -> "Запустить пайплайн"
                            else -> "Запустить ещё раз"
                        },
                        onClick = ::runPipeline,
                        enabled = !busy && current.task.status !in ACTIVE_TASK_STATES,
                        modifier = Modifier.fillMaxWidth(),
                    )

                    val activeRun = currentRun(current, runs)
                    if (activeRun != null && activeRun.status in ACTIVE_RUN_STATES) {
                        Spacer(Modifier.height(12.dp))
                        val cancelling = activeRun.id == cancellingRunId
                        AppButton(
                            text = when {
                                busy -> "…"
                                cancelling -> "Остановка запрошена…"
                                else -> "Остановить запуск"
                            },
                            onClick = ::cancelPipeline,
                            enabled = !busy && !cancelling,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    if (runList.isNotEmpty()) {
                        // The server now keeps runs inside the task's historical context further
                        // down the page instead of surfacing them at the top; these links stay at
                        // the top and jump straight to a run's card in that history instead of
                        // requiring a scroll-hunt for it.
                        Spacer(Modifier.height(20.dp))
                        RunQuickLinks(
                            runs = runList,
                            requesters = bringIntoViewRequesters,
                            scope = scope,
                        )
                    }

                    Spacer(Modifier.height(24.dp))
                    SectionTitle("Обсуждение")
                    Spacer(Modifier.height(12.dp))
                    if (runList.isEmpty() && current.comments.isEmpty()) {
                        Text(text = "Пока нет комментариев.", style = AppTheme.Body, color = AppTheme.Muted)
                    } else {
                        // Runs and comments used to sit in two separate lists — a "Запуски" block
                        // above the discussion — which hid the actual back-and-forth: an agent's
                        // report is a reply to the run just before it, not a document filed
                        // somewhere else. Interleaving them by timestamp turns the page into one
                        // timeline that reads the way the conversation actually happened.
                        Timeline(
                            runs = runList,
                            comments = current.comments,
                            requesters = bringIntoViewRequesters,
                            onOpenRun = onOpenRun,
                        )
                    }

                    Spacer(Modifier.height(20.dp))
                    AppTextField(
                        label = "Новый комментарий",
                        value = comment,
                        onValueChange = { comment = it },
                        placeholder = "Написать…",
                        enabled = !busy,
                        imeAction = ImeAction.Done,
                        // Comments here are replies to an agent's report, not one-liners.
                        minLines = 3,
                    )
                    Spacer(Modifier.height(12.dp))
                    AppButton(
                        text = "Отправить",
                        onClick = ::submitComment,
                        enabled = !busy && comment.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

private fun currentRun(detail: TaskDetailDto?, runs: List<RunDto>?): RunDto? =
    runs?.firstOrNull { it.status in ACTIVE_RUN_STATES } ?: detail?.latestRun

@Composable
private fun TaskSummary(task: TaskDto) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TaskStatusBadge(task.status)
            Text(
                text = if (task.runCount == 1) "1 запуск" else "${task.runCount} запусков",
                style = AppTheme.Label,
                color = AppTheme.Muted,
            )
        }
        val description = task.description?.takeIf { it.isNotBlank() }
        if (description != null) {
            Spacer(Modifier.height(12.dp))
            Text(text = description, style = AppTheme.Body, color = AppTheme.Foreground)
        }
        if (task.tags.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text(text = task.tags.joinToString(" · "), style = AppTheme.Label, color = AppTheme.Muted)
        }
    }
}

/**
 * The links a reader sees before scrolling down into the task's history at all — one per run,
 * newest first — so opening a task with a long history does not mean hunting through it by hand to
 * find a particular run's card.
 */
@Composable
private fun RunQuickLinks(
    runs: List<RunDto>,
    requesters: Map<String, BringIntoViewRequester>,
    scope: CoroutineScope,
) {
    SectionTitle("Перейти к запуску")
    Spacer(Modifier.height(8.dp))
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        runs.forEachIndexed { index, run ->
            val number = runs.size - index
            Text(
                text = "Запуск #$number",
                style = AppTheme.Label,
                color = AppTheme.Primary,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .border(1.dp, AppTheme.Border, RoundedCornerShape(999.dp))
                    .clickable {
                        scope.launch { requesters[run.id]?.bringIntoView() }
                    }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

/** One entry of the merged timeline below: either a run's card or a comment bubble, in time order. */
private sealed interface TimelineEntry {
    val sortKey: String

    data class Run(val run: RunDto, val number: Int) : TimelineEntry {
        override val sortKey: String = run.startedAt ?: run.finishedAt ?: ""
    }

    data class Comment(val comment: CommentDto) : TimelineEntry {
        override val sortKey: String = comment.createdAt ?: ""
    }
}

/**
 * Runs and comments merged into a single feed, oldest first, so a run's card sits next to the
 * agent report or human reply that actually followed it. `sortKey` is the raw ISO-8601 timestamp:
 * lexical order on that string is chronological order, which is enough to interleave the two kinds
 * without parsing either into a real timestamp.
 */
@Composable
private fun Timeline(
    runs: List<RunDto>,
    comments: List<CommentDto>,
    requesters: Map<String, BringIntoViewRequester>,
    onOpenRun: (run: RunDto, number: Int) -> Unit,
) {
    val entries = remember(runs, comments) {
        val runEntries = runs.mapIndexed { index, run -> TimelineEntry.Run(run, number = runs.size - index) }
        val commentEntries = comments.map { TimelineEntry.Comment(it) }
        (runEntries + commentEntries).sortedBy { it.sortKey }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        entries.forEach { entry ->
            when (entry) {
                is TimelineEntry.Run -> RunTimelineRow(
                    run = entry.run,
                    number = entry.number,
                    requester = requesters[entry.run.id],
                    onClick = { onOpenRun(entry.run, entry.number) },
                )
                is TimelineEntry.Comment -> CommentCard(entry.comment)
            }
        }
    }
}

@Composable
private fun RunTimelineRow(
    run: RunDto,
    number: Int,
    requester: BringIntoViewRequester?,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (requester != null) Modifier.bringIntoViewRequester(requester) else Modifier)
            .clip(RoundedCornerShape(AppTheme.Radius))
            .clickable(onClick = onClick)
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            // Soft, barely-there pastel blue: enough to set a run's card apart from the neutral
            // surfaces around it without competing with the status badge for attention.
            .background(AppTheme.RunCard, RoundedCornerShape(AppTheme.Radius))
            .padding(14.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = "Запуск #$number", style = AppTheme.Label, color = AppTheme.Foreground)
                val timestamp = formatTimestamp(run.startedAt)
                if (timestamp != null) {
                    Text(text = " · $timestamp", style = AppTheme.Label, color = AppTheme.Muted)
                }
            }
            val summary = run.resultSummary?.takeIf { it.isNotBlank() }
            if (summary != null) {
                Spacer(Modifier.height(4.dp))
                Text(text = summary, style = AppTheme.Label, color = AppTheme.Muted, maxLines = 1)
            }
        }
        Spacer(Modifier.width(12.dp))
        RunStatusBadge(run.status)
    }
}

@Composable
private fun CommentCard(comment: CommentDto) {
    // The author kind is the one thing a reader scans for, so it gets the accent colour rather
    // than the body text: agent reports and human replies must not look alike.
    val (kindLabel, kindColor) = when (comment.authorKind) {
        "agent" -> "агент" to AppTheme.Primary
        "system" -> "система" to AppTheme.Muted
        else -> "человек" to AppTheme.Foreground
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Background, RoundedCornerShape(AppTheme.Radius))
            .padding(14.dp),
    ) {
        // Who wrote it, and when — a reply from a person should read like one, not like an
        // unlabelled paragraph the reader has to guess the source and age of.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val author = comment.authorName?.takeIf { it.isNotBlank() }
                Text(text = author ?: kindLabel, style = AppTheme.Label, color = AppTheme.Foreground)
                if (author != null) {
                    Text(text = " · $kindLabel", style = AppTheme.Label, color = kindColor)
                }
            }
            val timestamp = formatTimestamp(comment.createdAt)
            if (timestamp != null) {
                Text(text = timestamp, style = AppTheme.Label, color = AppTheme.Muted)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(text = comment.body, style = AppTheme.Body, color = AppTheme.Foreground)
    }
}
