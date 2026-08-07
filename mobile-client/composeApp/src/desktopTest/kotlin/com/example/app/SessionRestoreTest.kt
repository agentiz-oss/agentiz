package com.example.app

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import com.example.app.data.Session
import com.example.app.data.UserDto
import com.example.app.data.loadSession
import com.example.app.data.saveSession
import com.example.app.data.useInMemorySessionStorageForTesting
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The "keep me signed in" behaviour: a saved session is what the app starts from, and signing out
 * through the burger menu is what takes it away again.
 */
class SessionRestoreTest {

    @BeforeTest
    fun isolateSessionStorage() = useInMemorySessionStorageForTesting()

    private fun session() = Session(
        serverUrl = "https://example.invalid",
        token = "token-123",
        user = UserDto(login = "admin", fullName = "Тест Тестов"),
    )

    @Test
    fun savedSessionRoundTrips() {
        assertNull(loadSession(), "storage should start empty")

        saveSession(session())

        val restored = loadSession()
        assertEquals("token-123", restored?.token)
        assertEquals("admin", restored?.user?.login)
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun startsSignedInWhenASessionWasSaved() = runComposeUiTest {
        saveSession(session())

        setContent { App() }
        waitForIdle()

        // Past the login screen: the projects screen and its chrome, not the credential form.
        onNodeWithText("Проекты").assertIsDisplayed()
        onNodeWithContentDescription("Открыть меню").assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun loggingOutThroughTheProfilePageClearsTheStoredSession() = runComposeUiTest {
        saveSession(session())

        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()

        // Signing out is no longer a row in the menu: it sits on the profile page, behind the
        // person icon in the drawer's footer.
        onNodeWithContentDescription("Профиль").performClick()
        waitForIdle()

        onNodeWithText("Выйти").performClick()
        waitForIdle()

        // Back on the login screen, and nothing left to restore on the next launch.
        onNodeWithText("Войти").assertIsDisplayed()
        assertNull(loadSession())
    }
}
