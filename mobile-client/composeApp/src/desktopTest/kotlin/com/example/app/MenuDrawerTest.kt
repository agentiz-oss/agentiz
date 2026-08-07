package com.example.app

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.v2.runComposeUiTest
import com.example.app.data.Session
import com.example.app.data.UserDto
import com.example.app.data.saveSession
import com.example.app.data.useInMemorySessionStorageForTesting
import kotlin.test.BeforeTest
import kotlin.test.Test

/**
 * The drawer is opened and closed by dragging as well as by tapping, and it carries the build stamp
 * that a bug report gets quoted from.
 */
class MenuDrawerTest {

    @BeforeTest
    fun isolateSessionStorage() = useInMemorySessionStorageForTesting()

    private fun signIn() = saveSession(
        Session(
            serverUrl = "https://example.invalid",
            token = "token-123",
            user = UserDto(login = "admin", fullName = "Тест Тестов"),
        ),
    )

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun swipingInFromTheLeftEdgeOpensTheDrawer() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        // "Меню" is the drawer's own heading, so it exists only while the drawer does.
        onNodeWithText("Меню").assertDoesNotExist()

        onRoot().performTouchInput {
            // Starting hard against the left edge: that strip is the only part of a closed screen
            // that belongs to the drawer.
            swipeRight(startX = 1f, endX = centerX)
        }
        waitForIdle()

        onNodeWithText("Меню").assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun swipingBackLeftClosesTheDrawer() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()
        onNodeWithText("Меню").assertIsDisplayed()

        onRoot().performTouchInput { swipeLeft() }
        waitForIdle()

        onNodeWithText("Меню").assertDoesNotExist()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun aHalfOpenDrawerSettlesBackClosed() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        // A short, slow drag that neither crosses the halfway mark nor flicks: the drawer should
        // fall back rather than stay stranded part-way out.
        onRoot().performTouchInput {
            down(Offset(1f, centerY))
            moveTo(Offset(24f, centerY))
            up()
        }
        waitForIdle()

        onNodeWithText("Меню").assertDoesNotExist()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theDrawerShowsTheVersionAndCommitItWasBuiltFrom() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()

        onNodeWithText("Версия ${BuildInfo.VERSION}").assertIsDisplayed()
        // Substring match: the stamp appends a "*" when the tree was dirty at build time.
        onNodeWithText(BuildInfo.COMMIT, substring = true).assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theFooterCogOpensSettingsAndClosesTheDrawer() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()

        onNodeWithContentDescription("Настройки").performClick()
        waitForIdle()

        onNodeWithText("Настройки появятся позже").assertIsDisplayed()
        // The drawer let go on the way through, rather than being left over the page it opened.
        onNodeWithText("Меню").assertDoesNotExist()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theFooterPersonOpensTheProfileWhereSigningOutLives() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()

        onNodeWithContentDescription("Профиль").performClick()
        waitForIdle()

        onNodeWithText("Тест Тестов").assertIsDisplayed()
        onNodeWithText("Выйти").assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun agentMenuItemOpensTheDashboardScreen() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()
        onNodeWithText("Агент").performClick()
        waitForIdle()

        onNodeWithText("Диалог с агентом").assertIsDisplayed()
        onNodeWithText("Меню").assertDoesNotExist()
        onNodeWithContentDescription("Назад").assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun backFromSettingsReturnsToTheScreenItWasOpenedFrom() = runComposeUiTest {
        signIn()
        setContent { App() }
        waitForIdle()

        onNodeWithContentDescription("Открыть меню").performClick()
        waitForIdle()
        onNodeWithContentDescription("Настройки").performClick()
        waitForIdle()

        onNodeWithContentDescription("Назад").performClick()
        waitForIdle()

        onNodeWithText("Проекты").assertIsDisplayed()
    }
}
