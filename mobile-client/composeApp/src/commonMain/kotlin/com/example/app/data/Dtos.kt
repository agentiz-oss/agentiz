package com.example.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Body of POST /auth/login. */
@Serializable
data class LoginRequest(
    val login: String,
    val password: String,
)

/** The authenticated admin, as returned by the mobile API. `id` is ignored — the UI shows names. */
@Serializable
data class UserDto(
    val login: String,
    val fullName: String? = null,
    val email: String? = null,
)

/** Response of POST /auth/login. */
@Serializable
data class LoginResponse(
    val token: String,
    val expiresAt: String? = null,
    val user: UserDto,
)

/** An Agentiz project, reduced to what the list screen renders. Extra server fields are ignored. */
@Serializable
data class ProjectDto(
    val id: String,
    val name: String,
    val slug: String = "",
    val description: String? = null,
    val isActive: Boolean = true,
    val repoProvider: String? = null,
)

/** Envelope every collection endpoint uses: `{ "data": [ ... ] }`. */
@Serializable
data class ProjectsResponse(
    val data: List<ProjectDto> = emptyList(),
)

/** A task as the list screen renders it. */
@Serializable
data class TaskDto(
    val id: String,
    val title: String,
    val status: String = "new",
    val priority: String = "normal",
    val tags: List<String> = emptyList(),
    val externalId: String = "",
    val createdAt: String? = null,
    val description: String? = null,
    val runCount: Int = 0,
)

/** One stage of a pipeline run, in execution order. */
@Serializable
data class StageDto(
    val role: String,
    val status: String,
    val summary: String? = null,
    val output: JsonElement? = null,
    val errorMessage: String? = null,
)

/**
 * One line of the run's process trace: `debug` is the worker/harness's step-by-step "thinking",
 * `info` marks milestones, `warn`/`error` as usual. `stageRole` is null for run-level lines.
 */
@Serializable
data class LogEntryDto(
    val level: String = "info",
    val message: String = "",
    val stageRole: String? = null,
    val createdAt: String? = null,
)

/** The most recent pipeline run of a task: what it concluded and how far it got. */
@Serializable
data class RunDto(
    val id: String,
    val status: String,
    val trigger: String = "manual",
    val resultSummary: String? = null,
    val errorMessage: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    val stages: List<StageDto> = emptyList(),
    val logs: List<LogEntryDto> = emptyList(),
    /**
     * Immutable final payload accepted from the worker.  It can contain stage outputs, changed
     * files and worker-specific diagnostic data, so keep it as JSON rather than losing fields in
     * a prematurely narrow client DTO.
     */
    val workerResult: JsonElement? = null,
)

/** One-use bridge into the Adminizer Assistant WebView. */
@Serializable
data class AssistantWebviewSessionDto(
    val url: String,
    val expiresAt: String? = null,
)

/**
 * One entry of a task's discussion. `authorKind` is what the UI keys off: `system` for lifecycle
 * events, `human` for people, `agent` for a pipeline run reporting its outcome.
 */
@Serializable
data class CommentDto(
    val id: String,
    val authorKind: String = "human",
    val authorName: String? = null,
    val body: String = "",
    val runId: String? = null,
    val createdAt: String? = null,
)

/** Everything the task screen shows: the task, its latest run, and the thread. */
@Serializable
data class TaskDetailDto(
    val task: TaskDto,
    val latestRun: RunDto? = null,
    val comments: List<CommentDto> = emptyList(),
)

/** Reference to a queued run, returned by POST /tasks/{id}/run. */
@Serializable
data class RunRefDto(
    val id: String,
    val status: String,
)

@Serializable
data class TasksResponse(val data: List<TaskDto> = emptyList())

@Serializable
data class TaskResponse(val data: TaskDto)

@Serializable
data class TaskDetailResponse(val data: TaskDetailDto)

@Serializable
data class CommentResponse(val data: CommentDto)

@Serializable
data class RunRefResponse(val data: RunRefDto)

@Serializable
data class RunsResponse(val data: List<RunDto> = emptyList())

@Serializable
data class RunResponse(val data: RunDto)

/** Body of POST /projects/{id}/tasks. */
@Serializable
data class CreateTaskRequest(
    val title: String,
    val description: String? = null,
    val tags: List<String> = emptyList(),
)

/** Body of POST /tasks/{id}/comments. */
@Serializable
data class CreateCommentRequest(
    val body: String,
)

/** Error envelope every endpoint uses on failure: `{ "message": "..." }`. */
@Serializable
data class ErrorResponse(
    val message: String? = null,
)
