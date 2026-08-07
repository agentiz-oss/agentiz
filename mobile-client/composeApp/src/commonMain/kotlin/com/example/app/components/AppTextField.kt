package com.example.app.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.theme.AppTheme

/**
 * A labelled input built on the foundation [BasicTextField] primitive and styled to match the
 * app's monochrome, rounded look. Kept intentionally minimal — a bordered box, a muted placeholder
 * and an optional password mask — so it works identically on every target. Password fields get a
 * trailing eye button that reveals the typed value.
 *
 * Focus is shown the way shadcn/Radix does it: the border darkens to [AppTheme.Ring] and a soft
 * halo of the same hue is drawn just outside it. Both are animated so the field does not blink
 * between states, and the halo is laid out as permanent padding so gaining focus never reflows the
 * form around it.
 *
 * Passing [minLines] greater than 1 makes the field a soft-wrapping multi-line box that grows with
 * its content up to [maxLines], after which it scrolls internally.
 */
@Composable
fun AppTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    isPassword: Boolean = false,
    enabled: Boolean = true,
    imeAction: ImeAction = ImeAction.Next,
    minLines: Int = 1,
    maxLines: Int = if (minLines > 1) 8 else 1,
) {
    var passwordVisible by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val masked = isPassword && !passwordVisible
    val multiline = minLines > 1

    // Focus is only worth showing while the field can actually take input; a disabled field that
    // still held focus would otherwise keep a ring it cannot act on.
    val ringVisible = focused && enabled
    val borderColor by animateColorAsState(
        targetValue = if (ringVisible) AppTheme.Ring else AppTheme.Border,
        animationSpec = tween(durationMillis = 150),
    )
    val haloColor by animateColorAsState(
        targetValue = if (ringVisible) AppTheme.RingHalo else Color.Transparent,
        animationSpec = tween(durationMillis = 150),
    )
    val shape = RoundedCornerShape(AppTheme.Radius)

    Column(modifier = modifier.fillMaxWidth()) {
        Text(text = label, style = AppTheme.Label, color = AppTheme.Foreground)
        Spacer(Modifier.height(8.dp))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = !multiline,
            minLines = minLines,
            maxLines = maxLines,
            textStyle = AppTheme.Body.copy(color = AppTheme.Foreground),
            cursorBrush = SolidColor(AppTheme.Primary),
            visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (isPassword) KeyboardType.Password else KeyboardType.Text,
                imeAction = imeAction,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { focused = it.isFocused },
            decorationBox = { innerTextField ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        // The halo sits outside the field's own border. Reserving its width as
                        // padding at every state — transparent when unfocused — keeps the field
                        // the same size focused or not, so focusing one never nudges the others.
                        .border(AppTheme.RingWidth, haloColor, RingShape)
                        .padding(AppTheme.RingWidth)
                        .border(1.dp, borderColor, shape)
                        .background(AppTheme.Background, shape)
                        // The trailing button carries its own padding, so it only needs enough
                        // room here to sit on the same optical margin as the text.
                        .padding(start = 16.dp, end = if (isPassword) 4.dp else 16.dp),
                    // A grown multi-line box keeps its eye/placeholder aligned to the first line
                    // rather than drifting to the middle of the block.
                    verticalAlignment = if (multiline) Alignment.Top else Alignment.CenterVertically,
                ) {
                    Box(
                        // The vertical padding lives on the text rather than the row so the
                        // button can use the field's full height as its touch target.
                        modifier = Modifier.weight(1f).padding(vertical = 14.dp),
                    ) {
                        if (value.isEmpty() && placeholder.isNotEmpty()) {
                            Text(text = placeholder, style = AppTheme.Body, color = AppTheme.Muted)
                        }
                        innerTextField()
                    }
                    if (isPassword) {
                        PasswordVisibilityToggle(
                            visible = passwordVisible,
                            enabled = enabled,
                            onToggle = { passwordVisible = !passwordVisible },
                        )
                    }
                }
            },
        )
    }
}

/**
 * The halo's shape. It is drawn [AppTheme.RingWidth] outside the field, so its corners have to be
 * that much rounder than the field's own to stay concentric with them.
 */
private val RingShape = RoundedCornerShape(AppTheme.Radius + AppTheme.RingWidth)

/**
 * The eye button shown at the end of a password field. Shows a plain eye while the value is
 * masked ("tap to reveal") and a struck-through one while it is readable ("tap to hide").
 */
@Composable
private fun PasswordVisibilityToggle(
    visible: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(44.dp)
            // Clipped first so the hover and press highlight stays a disc inside the field
            // instead of a square running into its rounded border.
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onToggle)
            .semantics {
                contentDescription = if (visible) "Скрыть пароль" else "Показать пароль"
            },
        contentAlignment = Alignment.Center,
    ) {
        EyeIcon(
            crossedOut = visible,
            // The field's own fill, which is what the crossed-out slash carves its gap out of.
            background = AppTheme.Background,
            tint = when {
                !enabled -> AppTheme.Disabled
                visible -> AppTheme.Foreground
                else -> AppTheme.Muted
            },
        )
    }
}
