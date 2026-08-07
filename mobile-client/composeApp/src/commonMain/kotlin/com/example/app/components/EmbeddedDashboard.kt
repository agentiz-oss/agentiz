package com.example.app.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier

/**
 * How far the application's drawer is open. Platform web surfaces are hosted outside Compose's
 * regular render layer, so they use this to get out of the way while the drawer is visible.
 */
val LocalDrawerProgress = compositionLocalOf { 0f }

/** Platform web surface used to show the Agentiz dashboard on the Assistant screen. */
@Composable
expect fun EmbeddedDashboard(url: String, modifier: Modifier = Modifier)
