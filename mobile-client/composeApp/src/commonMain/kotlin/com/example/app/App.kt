package com.example.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.example.app.components.MenuEntry
import com.example.app.data.ProjectDto
import com.example.app.data.Session
import com.example.app.data.clearSession
import com.example.app.data.loadSession
import com.example.app.data.saveSession
import com.example.app.screens.LoginScreen
import com.example.app.screens.AgentDashboardScreen
import com.example.app.screens.ProfileScreen
import com.example.app.screens.ProjectsScreen
import com.example.app.screens.RunDetailScreen
import com.example.app.screens.SettingsScreen
import com.example.app.screens.TaskDetailScreen
import com.example.app.screens.TasksScreen

/**
 * Where the user is once they are signed in. A sealed hierarchy rather than a string route: the
 * screens below need the project and task they were opened with, and carrying them in the
 * destination keeps each screen a pure function of where the user navigated.
 */
private sealed interface Destination {
    data object Projects : Destination
    data class Tasks(val project: ProjectDto) : Destination
    data class Task(val project: ProjectDto, val taskId: String) : Destination

    /**
     * One run's own page, opened from its card in the task's history. [runNumber] is only along
     * for the title — the run itself is looked up by [runId] — so it is nullable for the sake of
     * any future entry point that would not have it on hand.
     */
    data class Run(val project: ProjectDto, val taskId: String, val runId: String, val runNumber: Int?) : Destination
    data class Agent(val from: Destination) : Destination

    /**
     * The two pages behind the drawer's footer icons. Each carries where it was opened from so
     * back returns there rather than dumping the user on the project list — they are reachable
     * from anywhere, so there is no one place "back" could otherwise mean.
     */
    data class Settings(val from: Destination) : Destination
    data class Profile(val from: Destination) : Destination
}

/**
 * The project a destination is "in", if any. Settings and Profile inherit it from wherever they
 * were opened, so the drawer keeps offering the project you were last looking at.
 *
 * Non-recursive by construction: neither wrapper is ever built around another, since both are only
 * ever opened from a content screen.
 */
private fun Destination.project(): ProjectDto? = when (this) {
    is Destination.Projects -> null
    is Destination.Tasks -> project
    is Destination.Task -> project
    is Destination.Run -> project
    is Destination.Agent -> from.project()
    is Destination.Settings -> from.project()
    is Destination.Profile -> from.project()
}

/**
 * Root of the app: a single source of truth for whether someone is signed in, and where they are.
 * No session shows the login screen; a session shows their projects, and from there the tasks of a
 * project and one task's run result and discussion.
 *
 * The session is read back from storage as the app starts, so a relaunch lands where the user left
 * off rather than on the login screen; signing out is what clears it again.
 */
@Composable
fun App() {
    // Restored once, at the first composition, rather than in an effect: doing it here means the
    // very first frame is already the right screen, with no login flash before it.
    var session by remember { mutableStateOf(loadSession()) }
    var destination by remember { mutableStateOf<Destination>(Destination.Projects) }

    fun logout() {
        clearSession()
        session = null
        destination = Destination.Projects
    }

    val current = session
    if (current == null) {
        LoginScreen(onLoggedIn = {
            saveSession(it)
            session = it
            destination = Destination.Projects
        })
        return
    }

    fun openAgent() {
        destination = Destination.Agent(destination)
    }

    /**
     * The drawer's contents. Built here rather than inside each screen because the menu is about
     * the session, not the page: it is the same list everywhere, with the entry for wherever you
     * already are disabled.
     */
    val menu = buildList {
        add(
            MenuEntry(
                label = "Проекты",
                onClick = { destination = Destination.Projects },
                enabled = destination !is Destination.Projects,
            ),
        )
        // Only meaningful once a project has been opened — from the project list there is no
        // "current project" to go back up to. Settings and Profile are not places a project is
        // open *in*, but they were opened from somewhere that might have had one, so the entry
        // follows the destination they came from.
        val project = destination.project()
        if (project != null) {
            add(
                MenuEntry(
                    label = "Задачи: ${project.name}",
                    onClick = { destination = Destination.Tasks(project) },
                    enabled = destination !is Destination.Tasks,
                ),
            )
        }
        add(
            MenuEntry(
                label = "Агент",
                onClick = ::openAgent,
                enabled = destination !is Destination.Agent,
            ),
        )
        // No "Выйти" here any more: signing out lives on the profile page behind the drawer's
        // person icon, where a mis-tap while flicking through the menu cannot reach it.
    }

    val userLabel = current.user.fullName?.takeIf { it.isNotBlank() } ?: current.user.login

    // Captured once so every screen opens the two footer pages the same way, each remembering the
    // destination it was opened from.
    val openSettings = { destination = Destination.Settings(destination) }
    val openProfile = { destination = Destination.Profile(destination) }

    when (val where = destination) {
        is Destination.Projects -> ProjectsScreen(
            session = current,
            menu = menu,
            userLabel = userLabel,
            onOpenProject = { destination = Destination.Tasks(it) },
            onOpenSettings = openSettings,
            onOpenProfile = openProfile,
        )

        is Destination.Tasks -> TasksScreen(
            session = current,
            project = where.project,
            menu = menu,
            onOpenTask = { destination = Destination.Task(where.project, it.id) },
            onBack = { destination = Destination.Projects },
            onOpenSettings = openSettings,
            onOpenProfile = openProfile,
        )

        is Destination.Task -> TaskDetailScreen(
            session = current,
            taskId = where.taskId,
            menu = menu,
            onBack = { destination = Destination.Tasks(where.project) },
            onOpenSettings = openSettings,
            onOpenProfile = openProfile,
            onOpenRun = { run, number ->
                destination = Destination.Run(where.project, where.taskId, run.id, number)
            },
        )

        is Destination.Run -> RunDetailScreen(
            session = current,
            taskId = where.taskId,
            runId = where.runId,
            runNumber = where.runNumber,
            menu = menu,
            onBack = { destination = Destination.Task(where.project, where.taskId) },
            onOpenSettings = openSettings,
            onOpenProfile = openProfile,
        )

        is Destination.Agent -> AgentDashboardScreen(
            session = current,
            menu = menu,
            onBack = { destination = where.from },
            onOpenSettings = { destination = Destination.Settings(where) },
            onOpenProfile = { destination = Destination.Profile(where) },
        )

        // The footer icon for the page you are already on is left inert rather than pushing a
        // second copy of it — tapping "Настройки" from settings should do nothing, not deepen the
        // back stack by one indistinguishable screen.
        is Destination.Settings -> SettingsScreen(
            menu = menu,
            onBack = { destination = where.from },
            onOpenSettings = {},
            onOpenProfile = { destination = Destination.Profile(where.from) },
        )

        is Destination.Profile -> ProfileScreen(
            session = current,
            menu = menu,
            onLogout = ::logout,
            onBack = { destination = where.from },
            onOpenSettings = { destination = Destination.Settings(where.from) },
            onOpenProfile = {},
        )
    }
}
