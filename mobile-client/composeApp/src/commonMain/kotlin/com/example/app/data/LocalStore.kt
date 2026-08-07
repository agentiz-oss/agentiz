package com.example.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What gets cached for one task: its detail plus the comment count at the time it was cached. That
 * count is the nonce — a fresh fetch that comes back with the same count changed nothing worth
 * repainting for, while a different count means new comments (or a finished run's report, which
 * arrives as one) actually landed and the cache is worth replacing.
 */
@Serializable
data class CachedTaskDetail(
    val detail: TaskDetailDto,
    val commentNonce: Int = detail.comments.size,
)

/**
 * Typed cache of everything the app already showed once: project and task lists, a task's detail,
 * and individual runs. Backed by [LocalCache], so it survives restarts on every target without a
 * real database.
 *
 * A run in a terminal state (`succeeded`, `failed`, `cancelled` — everything but `pending` and
 * `running`) is immutable on the server: its log, stages and worker result never change again. So
 * once cached, it is never worth re-downloading — [screens.RunDetailScreen] uses [loadRun] to skip
 * the network entirely for a run it already knows is terminal.
 */
object LocalStore {
    private val json = Json { ignoreUnknownKeys = true }

    fun loadProjects(): List<ProjectDto>? = decode(LocalCache.get("projects"))
    fun saveProjects(projects: List<ProjectDto>) = encode("projects", projects)

    fun loadTasks(projectId: String): List<TaskDto>? = decode(LocalCache.get("tasks:$projectId"))
    fun saveTasks(projectId: String, tasks: List<TaskDto>) = encode("tasks:$projectId", tasks)

    fun loadTaskDetail(taskId: String): CachedTaskDetail? = decode(LocalCache.get("task:$taskId"))

    /** Also returns the saved [CachedTaskDetail], so a caller can read the nonce it just wrote. */
    fun saveTaskDetail(taskId: String, detail: TaskDetailDto): CachedTaskDetail {
        val cached = CachedTaskDetail(detail)
        encode("task:$taskId", cached)
        return cached
    }

    fun loadRuns(taskId: String): List<RunDto>? = decode(LocalCache.get("runs:$taskId"))
    fun saveRuns(taskId: String, runs: List<RunDto>) = encode("runs:$taskId", runs)

    fun loadRun(runId: String): RunDto? = decode(LocalCache.get("run:$runId"))
    fun saveRun(run: RunDto) = encode("run:${run.id}", run)

    private inline fun <reified T> decode(raw: String?): T? {
        if (raw == null) return null
        return try {
            json.decodeFromString<T>(raw)
        } catch (_: Throwable) {
            // An older build's shape, a truncated write — treat like a cache miss rather than
            // crashing the screen that asked for it.
            null
        }
    }

    private inline fun <reified T> encode(key: String, value: T) {
        try {
            LocalCache.put(key, json.encodeToString(value))
        } catch (_: Throwable) {
            // Caching is a convenience; a full disk or disabled storage must not take the fetch
            // itself down with it.
        }
    }
}
