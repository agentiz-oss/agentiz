package com.example.app.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The app's icon pack, drawn by hand. The project pulls in no icon dependency, and at this handful
 * of shapes a few line calls cost far less than one — but drawing them ad hoc is what made the
 * earlier glyphs disagree with each other, so they all share the geometry below instead.
 *
 * Every icon is authored on a 24-unit square in fractional coordinates, stroked at one ratio with
 * round caps and joins, and sized by the call site rather than by itself. That is the whole style:
 * outline only, no fills, nothing that needs a second colour to read.
 */

/** The nominal box an icon is drawn in. Call sites override it; the proportions never change. */
val IconSize: Dp = 20.dp

/** Stroke width as a fraction of the box, so a glyph keeps its weight at any size. */
private const val StrokeRatio = 0.085f

/**
 * Sets up one icon's canvas and hands the body a scope where coordinates are fractions of the box
 * and the stroke is already the right weight. Keeping this in one place is what makes a burger and
 * a cog look like they came from the same pack.
 */
@Composable
private fun Icon(
    size: Dp,
    body: DrawScope.(IconScope) -> Unit,
) {
    Canvas(modifier = Modifier.size(size)) {
        body(IconScope(this.size.width, this.size.height))
    }
}

/**
 * Fractional coordinates for an icon body: [x] and [y] map 0f..1f onto the box, so a glyph is
 * written once and scales to whatever size it is asked for.
 */
private class IconScope(val w: Float, val h: Float) {
    fun x(fraction: Float) = w * fraction

    fun y(fraction: Float) = h * fraction

    fun at(xf: Float, yf: Float) = Offset(x(xf), y(yf))

    /** The shared stroke weight — every glyph in the pack draws with this and nothing else. */
    val strokeWidth: Float get() = w * StrokeRatio

    val stroke: Stroke
        get() = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round)
}

/** A straight run between two fractional points, in the pack's weight. */
private fun DrawScope.line(s: IconScope, tint: Color, x1: Float, y1: Float, x2: Float, y2: Float) {
    drawLine(tint, s.at(x1, y1), s.at(x2, y2), s.strokeWidth, StrokeCap.Round)
}

/** An outlined circle centred on a fractional point. */
private fun DrawScope.circle(s: IconScope, tint: Color, cx: Float, cy: Float, r: Float) {
    drawCircle(tint, radius = s.w * r, center = s.at(cx, cy), style = s.stroke)
}

/** The burger that opens the menu: three evenly spaced rules. */
@Composable
fun BurgerIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        listOf(0.26f, 0.5f, 0.74f).forEach { y ->
            line(s, tint, 0.14f, y, 0.86f, y)
        }
    }
}

/** An X, for dismissing. */
@Composable
fun CloseIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        line(s, tint, 0.2f, 0.2f, 0.8f, 0.8f)
        line(s, tint, 0.8f, 0.2f, 0.2f, 0.8f)
    }
}

/** A left-pointing chevron for the back affordance. */
@Composable
fun BackIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        val path = Path().apply {
            moveTo(s.x(0.62f), s.y(0.2f))
            lineTo(s.x(0.32f), s.y(0.5f))
            lineTo(s.x(0.62f), s.y(0.8f))
        }
        drawPath(path, tint, style = s.stroke)
    }
}

/** A right-pointing chevron — the mirror of [BackIcon], for rows that open something. */
@Composable
fun ForwardIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        val path = Path().apply {
            moveTo(s.x(0.38f), s.y(0.2f))
            lineTo(s.x(0.68f), s.y(0.5f))
            lineTo(s.x(0.38f), s.y(0.8f))
        }
        drawPath(path, tint, style = s.stroke)
    }
}

/**
 * A cog for settings: a ring with eight teeth struck through it.
 *
 * The teeth are radial stubs rather than a toothed outline — at 20.dp a true gear profile turns to
 * mush, while stubs stay legible down to the smallest size the pack is used at.
 */
@Composable
fun SettingsIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        circle(s, tint, 0.5f, 0.5f, 0.17f)

        val inner = 0.26f
        val outer = 0.4f
        repeat(8) { i ->
            // Eight spokes at 45° each, started at 22.5° so no tooth sits on the vertical axis —
            // one straight up reads as a stray mark rather than as part of the ring.
            val angle = (i * 45f + 22.5f) * (kotlin.math.PI.toFloat() / 180f)
            val dx = kotlin.math.cos(angle)
            val dy = kotlin.math.sin(angle)
            line(
                s, tint,
                0.5f + dx * inner, 0.5f + dy * inner,
                0.5f + dx * outer, 0.5f + dy * outer,
            )
        }
    }
}

/** A person: a head over the shoulders arc that stands for the account. */
@Composable
fun PersonIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        circle(s, tint, 0.5f, 0.32f, 0.16f)
        // An arc, not a closed body: the open ends let the shoulders run off the bottom edge the
        // way a bust does, instead of sealing into a dome.
        val path = Path().apply {
            moveTo(s.x(0.16f), s.y(0.86f))
            quadraticTo(s.x(0.5f), s.y(0.56f), s.x(0.84f), s.y(0.86f))
        }
        drawPath(path, tint, style = s.stroke)
    }
}

/**
 * A door with an arrow leaving it: signing out. The arrow points out of the frame rather than into
 * it, which is the only thing distinguishing this from a sign-in glyph.
 */
@Composable
fun LogoutIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        // Three sides of the door — the fourth is where the arrow goes through.
        val frame = Path().apply {
            moveTo(s.x(0.54f), s.y(0.16f))
            lineTo(s.x(0.18f), s.y(0.16f))
            lineTo(s.x(0.18f), s.y(0.84f))
            lineTo(s.x(0.54f), s.y(0.84f))
        }
        drawPath(frame, tint, style = s.stroke)

        line(s, tint, 0.44f, 0.5f, 0.86f, 0.5f)
        val head = Path().apply {
            moveTo(s.x(0.7f), s.y(0.32f))
            lineTo(s.x(0.88f), s.y(0.5f))
            lineTo(s.x(0.7f), s.y(0.68f))
        }
        drawPath(head, tint, style = s.stroke)
    }
}

/**
 * An eye, for revealing a masked field. When [crossedOut] the diagonal is outlined in [background]
 * first, so the stroke stays readable where it crosses the eye beneath it.
 */
@Composable
fun EyeIcon(
    tint: Color,
    background: Color,
    crossedOut: Boolean = false,
    size: Dp = IconSize,
) {
    Icon(size) { s ->
        val outline = Path().apply {
            moveTo(s.x(0.06f), s.y(0.5f))
            quadraticTo(s.x(0.5f), s.y(0.08f), s.x(0.94f), s.y(0.5f))
            quadraticTo(s.x(0.5f), s.y(0.92f), s.x(0.06f), s.y(0.5f))
            close()
        }
        drawPath(outline, tint, style = s.stroke)
        circle(s, tint, 0.5f, 0.5f, 0.15f)

        if (crossedOut) {
            val start = s.at(0.16f, 0.84f)
            val end = s.at(0.84f, 0.16f)
            // Laid down twice: a fat pass in the field colour carves a gap out of the eye, and the
            // real stroke rides in it. Without the gap the slash disappears into the outline.
            drawLine(background, start, end, s.strokeWidth * 2.8f, StrokeCap.Round)
            drawLine(tint, start, end, s.strokeWidth, StrokeCap.Round)
        }
    }
}

/** A checkmark, for states that resolved successfully. */
@Composable
fun CheckIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        val path = Path().apply {
            moveTo(s.x(0.18f), s.y(0.52f))
            lineTo(s.x(0.42f), s.y(0.74f))
            lineTo(s.x(0.82f), s.y(0.26f))
        }
        drawPath(path, tint, style = s.stroke)
    }
}

/** A circled exclamation, for warnings and failed states. */
@Composable
fun AlertIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        circle(s, tint, 0.5f, 0.5f, 0.38f)
        line(s, tint, 0.5f, 0.28f, 0.5f, 0.56f)
        // A dot rather than a stub: at this size a short line under the stem reads as a stray
        // tick, while a filled dot stays unmistakably a full stop.
        drawCircle(tint, radius = s.strokeWidth * 0.65f, center = s.at(0.5f, 0.71f))
    }
}

/** A circular arrow, for retrying whatever just failed. */
@Composable
fun RefreshIcon(tint: Color, size: Dp = IconSize) {
    Icon(size) { s ->
        // Left open at the top right so the arrowhead has somewhere to sit — a closed ring with a
        // head stuck on it reads as a circle with a defect.
        drawArc(
            color = tint,
            startAngle = -60f,
            sweepAngle = 300f,
            useCenter = false,
            topLeft = s.at(0.16f, 0.16f),
            size = Size(s.x(0.68f), s.y(0.68f)),
            style = s.stroke,
        )
        val head = Path().apply {
            moveTo(s.x(0.62f), s.y(0.12f))
            lineTo(s.x(0.86f), s.y(0.24f))
            lineTo(s.x(0.7f), s.y(0.44f))
        }
        drawPath(head, tint, style = s.stroke)
    }
}
