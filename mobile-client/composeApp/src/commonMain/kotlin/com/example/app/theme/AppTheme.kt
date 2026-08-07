package com.example.app.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Minimal, monochrome design tokens inspired by shadcn/ui, Radix and Tailwind:
 * a white surface, near-black text and a single black primary accent.
 */
@Immutable
object AppTheme {
    val Background: Color = Color(0xFFFFFFFF)
    val Foreground: Color = Color(0xFF09090B)
    val Primary: Color = Color(0xFF18181B)
    val PrimaryForeground: Color = Color(0xFFFAFAFA)
    val Muted: Color = Color(0xFF71717A)
    val Border: Color = Color(0xFFE4E4E7)
    val Surface: Color = Color(0xFFFAFAFA)

    /**
     * The backdrop the slide-out menu sits on. A touch darker than [Surface] so the white screen
     * pushed on top of it reads as a card lifted off the page, and so the rounded corners of that
     * card have something to show against.
     */
    val MenuBackground: Color = Color(0xFFF4F4F5)
    val Danger: Color = Color(0xFFDC2626)
    val Disabled: Color = Color(0xFFA1A1AA)

    /**
     * Fill for a run's card in the history list — a pastel blue so faint it reads as a tint rather
     * than a colour, just enough to set "запуск" cards apart from the neutral surfaces around them.
     */
    val RunCard: Color = Color(0xFFF2F7FE)

    /**
     * The colour a focused control's border takes, and the halo drawn around it. Mirrors shadcn's
     * `focus-visible:ring-ring` — the ring is the same hue as the border it replaces, drawn at low
     * opacity so it reads as a glow rather than a second frame.
     */
    val Ring: Color = Color(0xFF18181B)
    val RingHalo: Color = Color(0x2918181B)

    /** Width of the halo outside a focused control's own 1.dp border — shadcn's `ring-[3px]`. */
    val RingWidth: Dp = 3.dp

    val Radius: Dp = 12.dp

    val Title: TextStyle = TextStyle(
        fontSize = 34.sp,
        lineHeight = 40.sp,
        fontWeight = FontWeight.SemiBold,
    )

    val Subtitle: TextStyle = TextStyle(
        fontSize = 20.sp,
        lineHeight = 28.sp,
        fontWeight = FontWeight.SemiBold,
    )

    val Body: TextStyle = TextStyle(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.Normal,
    )

    val Label: TextStyle = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Medium,
    )

    val ButtonLabel: TextStyle = TextStyle(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.Medium,
    )
}
