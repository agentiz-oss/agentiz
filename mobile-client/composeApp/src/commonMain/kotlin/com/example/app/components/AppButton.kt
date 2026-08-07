package com.example.app.components

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.composeunstyled.Button
import com.composeunstyled.Text
import com.example.app.theme.AppTheme

/**
 * A large primary button built on the Compose Unstyled [Button] primitive and
 * styled to match the app's monochrome, rounded, SaaS-style look.
 */
@Composable
fun AppButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        // Compose Unstyled's Button has no disabled state of its own, so gate the click here and
        // dim the surface to signal it.
        onClick = { if (enabled) onClick() },
        modifier = modifier,
        shape = RoundedCornerShape(AppTheme.Radius),
        backgroundColor = if (enabled) AppTheme.Primary else AppTheme.Disabled,
        contentColor = AppTheme.PrimaryForeground,
        contentPadding = PaddingValues(horizontal = 40.dp, vertical = 18.dp),
    ) {
        Text(
            text = text,
            style = AppTheme.ButtonLabel,
        )
    }
}
