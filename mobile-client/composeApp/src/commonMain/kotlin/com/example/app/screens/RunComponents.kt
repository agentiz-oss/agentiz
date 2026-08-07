package com.example.app.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.data.LogEntryDto
import com.example.app.data.RunDto
import com.example.app.data.StageDto
import com.example.app.theme.AppTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pipeline states a run can still be in — shared between the task screen (which needs to know
 * whether *some* run is active to keep polling and offer "Остановить") and the run's own detail
 * page (which polls the same way while looking at just one).
 */
internal val ACTIVE_RUN_STATES = setOf("pending", "running")

internal val prettyJson = Json { prettyPrint = true }

/** The full record of one pipeline run: its stages, its log trace and the worker's final answer. */
@Composable
internal fun RunResult(run: RunDto) {
    SectionTitle("Результат запуска")
    Spacer(Modifier.height(12.dp))
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppTheme.Border, RoundedCornerShape(AppTheme.Radius))
            .background(AppTheme.Surface, RoundedCornerShape(AppTheme.Radius))
            .padding(16.dp),
    ) {
        RunStatusBadge(run.status)

        run.stages.forEach { stage ->
            Spacer(Modifier.height(12.dp))
            StageRow(stage)
        }

        if (run.logs.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SectionTitle("Лог выполнения")
            Spacer(Modifier.height(8.dp))
            // Keep the process trace selectable: workers can emit details that need to be copied
            // into an issue or a reply. SelectionContainer provides the native copy action on
            // touch devices and Cmd/Ctrl+C support on desktop.
            SelectionContainer {
                Column(
                    // A trace of a few hundred debug lines would otherwise push the rest of the page
                    // out of reach. Capped and given its own scroll, the log stays inspectable
                    // without becoming the whole page; heightIn means a short log still shrinks.
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 260.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    run.logs.forEach { LogLine(it) }
                }
            }
        }

        val summary = run.resultSummary?.takeIf { it.isNotBlank() }
        if (summary != null) {
            Spacer(Modifier.height(16.dp))
            SectionTitle("Итог воркера")
            Spacer(Modifier.height(8.dp))
            Text(text = summary, style = AppTheme.Body, color = AppTheme.Foreground)
        }

        run.workerResult?.let { result ->
            Spacer(Modifier.height(16.dp))
            SectionTitle("Полный ответ воркера")
            Spacer(Modifier.height(8.dp))
            // Worker result schemas may evolve independently. Display the complete JSON that the
            // server persisted rather than silently dropping fields the client does not know yet.
            SelectionContainer {
                Text(
                    text = prettyJson.encodeToString(result),
                    style = AppTheme.Label,
                    color = AppTheme.Foreground,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 360.dp)
                        .verticalScroll(rememberScrollState()),
                )
            }
        }
        val failure = run.errorMessage?.takeIf { it.isNotBlank() }
        if (failure != null) {
            Spacer(Modifier.height(12.dp))
            Text(text = failure, style = AppTheme.Body, color = AppTheme.Danger)
        }
    }
}

@Composable
private fun StageRow(stage: StageDto) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stage.role,
                style = AppTheme.Label,
                color = AppTheme.Foreground,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            Text(
                text = when (stage.status) {
                    "pending" -> "ждёт"
                    "running" -> "идёт"
                    "succeeded" -> "готово"
                    "failed" -> "ошибка"
                    "skipped" -> "пропущено"
                    else -> stage.status
                },
                style = AppTheme.Label,
                color = if (stage.status == "failed") AppTheme.Danger else AppTheme.Muted,
            )
        }

        val response = (stage.output as? JsonObject)
            ?.get("agentResponse")
            ?.jsonPrimitive
            ?.contentOrNull
            ?.takeIf { it.isNotBlank() }
        if (response != null) {
            Spacer(Modifier.height(6.dp))
            Text(text = response, style = AppTheme.Body, color = AppTheme.Foreground)
        } else if (stage.output != null) {
            Spacer(Modifier.height(6.dp))
            SelectionContainer {
                Text(
                    text = prettyJson.encodeToString(stage.output),
                    style = AppTheme.Label,
                    color = AppTheme.Muted,
                )
            }
        }
    }
}

/** One line of the run's process trace — every level, so the "thinking" behind a run is visible. */
@Composable
private fun LogLine(log: LogEntryDto) {
    val color = when (log.level) {
        "error" -> AppTheme.Danger
        "warn" -> AppTheme.Muted
        "debug" -> AppTheme.Muted
        else -> AppTheme.Foreground
    }
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = "[${log.level}]",
            style = AppTheme.Label,
            color = color,
            modifier = Modifier.padding(end = 8.dp),
        )
        Text(
            text = if (log.stageRole != null) "${log.stageRole}: ${log.message}" else log.message,
            style = AppTheme.Label,
            color = color,
        )
    }
}

@Composable
internal fun RunStatusBadge(status: String) {
    val (label, color) = when (status) {
        "pending" -> "в очереди" to AppTheme.Muted
        "running" -> "выполняется" to AppTheme.Muted
        "succeeded" -> "успешно" to AppTheme.Primary
        "failed" -> "ошибка" to AppTheme.Danger
        "cancelled" -> "отменён" to AppTheme.Disabled
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

@Composable
internal fun SectionTitle(text: String) {
    Text(text = text, style = AppTheme.Label, color = AppTheme.Muted)
}

/**
 * `createdAt`/`startedAt` come from the server as ISO-8601 UTC (`2026-08-05T14:32:10Z`); this turns
 * that into `05.08.2026 14:32` for display without pulling in a datetime dependency for one field.
 * Lexical ISO-8601 order is chronological order, which the timeline below also relies on to sort
 * runs and comments against each other without parsing either into a real timestamp.
 */
internal fun formatTimestamp(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    val datePart = iso.substringBefore('T', missingDelimiterValue = "")
    val timePart = iso.substringAfter('T', missingDelimiterValue = "")
    val dateBits = datePart.split('-')
    if (dateBits.size != 3) return null
    val (year, month, day) = dateBits
    val time = timePart.take(5)
    return "$day.$month.$year $time"
}
