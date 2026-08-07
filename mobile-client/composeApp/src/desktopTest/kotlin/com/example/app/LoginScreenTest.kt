package com.example.app

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.text.AnnotatedString
import com.example.app.data.useInMemorySessionStorageForTesting
import kotlin.test.BeforeTest
import kotlin.test.Test

class LoginScreenTest {

    /**
     * App() now restores a persisted session at startup. Without this the suite would read the
     * developer's own ~/.agentiz/session.json and open on the projects screen.
     */
    @BeforeTest
    fun isolateSessionStorage() = useInMemorySessionStorageForTesting()

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun showsLoginFormWhenSignedOut() = runComposeUiTest {
        setContent { App() }
        waitForIdle()

        // With no session the app opens on the login screen.
        onNodeWithText("Agentiz").assertIsDisplayed()
        onNodeWithText("Логин").assertIsDisplayed()
        onNodeWithText("Пароль").assertIsDisplayed()
        onNodeWithText("Войти").assertIsDisplayed()
    }

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun eyeButtonTogglesPasswordMasking() = runComposeUiTest {
        setContent { App() }
        waitForIdle()

        // Server, login and password, in the order the form declares them.
        val password = onAllNodes(hasSetTextAction())[2]
        password.performTextInput("s3cret")
        waitForIdle()
        password.assertRendersText("••••••")

        onNodeWithContentDescription("Показать пароль").performClick()
        waitForIdle()
        password.assertRendersText("s3cret")

        onNodeWithContentDescription("Скрыть пароль").performClick()
        waitForIdle()
        password.assertRendersText("••••••")
    }
}

/**
 * Asserts on what the field puts on screen rather than what it holds: a password field keeps the
 * typed value in `InputText` whether or not it is masked, and only `EditableText` shows the mask.
 */
private fun SemanticsNodeInteraction.assertRendersText(expected: String) =
    assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(expected)))
