package com.example.app.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.example.app.platform.hapticActionComplete
import com.example.app.theme.AppTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min

/** How far the finger must travel before a release fires a refresh. */
private val TriggerDistance = 72.dp

/** Where the spinner rests while a refresh is in flight — just under the top edge of the content. */
private val RestingOffset = 56.dp

/** Diameter of the spinner arc. */
private val IndicatorSize = 22.dp

/**
 * Past the trigger point the drag keeps moving but with sharply diminishing returns, so a long pull
 * feels like stretching rubber rather than like the gesture having no end to its travel.
 */
private const val OverdragResistance = 0.4f

/**
 * How long the pulled-open state stays up once a refresh starts, however fast the server answers.
 * A cached response can land in a few frames, and closing that quickly reads as the gesture having
 * failed rather than as the list having reloaded. The floor never truncates a slower request — it
 * only sets the shortest refresh the user can be shown.
 */
private const val MinimumVisibleDuration = 2_000L

/**
 * Wraps a scrollable with the standard pull-down-to-refresh gesture: drag down at the top of the
 * list, release past the threshold, and [onRefresh] runs while a spinner holds below the top bar.
 * When the caller flips [refreshing] back to false the indicator retracts and the screen returns to
 * its resting state.
 *
 * Written by hand rather than taken from material3: this project depends on foundation and
 * compose-unstyled only, and pulling in a whole Material theme for one spinner would drag its type
 * and colour system along with it.
 *
 * The whole content area travels with the finger, the way the gesture behaves in most apps — the
 * page peels down off the top bar and the spinner rides in the gap it opens. The list is moved at
 * placement time, so its scroll position and item bounds are unaffected by the trip.
 */
@Composable
fun PullToRefresh(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val scope = rememberCoroutineScope()
    val currentOnRefresh by rememberUpdatedState(onRefresh)

    val density = LocalDensity.current
    val triggerPx = with(density) { TriggerDistance.toPx() }
    val restingPx = with(density) { RestingOffset.toPx() }

    // Drag distance in pixels. An Animatable rather than plain state so the snap back to zero and
    // the settle onto the resting offset are animations the next gesture can interrupt mid-flight.
    val offset = remember { Animatable(0f) }

    // Whether this gesture already asked for a refresh, so wobbling back and forth across the
    // threshold before lifting the finger cannot fire two requests.
    var fired by remember { mutableStateOf(false) }

    // Held open until the minimum has elapsed even after `refreshing` goes false. A request that
    // answers in 80ms would otherwise flash the indicator and snap shut, which reads as a glitch
    // rather than as a refresh — see [MinimumVisibleDuration].
    var holding by remember { mutableStateOf(false) }
    val open = refreshing || holding

    // The gesture reads the combined flag, not `refreshing`: while the minimum is still being paid
    // out the indicator is up and a second pull must not start another request behind it.
    val currentOpen by rememberUpdatedState(open)

    // Crossing the threshold ticks once — the confirmation that releasing now will do something.
    LaunchedEffect(triggerPx) {
        snapshotFlow { offset.value >= triggerPx }
            .collect { crossed -> if (crossed && !currentOpen) hapticActionComplete() }
    }

    // One effect owns the whole open/close cycle, so the two animations can never run against each
    // other over the same [offset]. It is keyed on `open`, whose rising edge is the release itself
    // — keying on `refreshing` would restart the body when a fast request completes and cancel the
    // very delay that is meant to outlive it.
    LaunchedEffect(open) {
        if (open) {
            offset.animateTo(restingPx, tween(durationMillis = 180))
            delay(MinimumVisibleDuration)
            // The minimum is paid; from here `refreshing` alone decides. A request still in flight
            // keeps `open` true through its own flag and this effect simply idles, and the falling
            // edge that eventually follows re-enters the body below.
            holding = false
        } else {
            fired = false
            if (offset.value != 0f) offset.animateTo(0f, tween(durationMillis = 260))
        }
    }

    val connection = remember(enabled, triggerPx) {
        object : NestedScrollConnection {
            /**
             * Upward drags are taken before the list sees them, but only to pay back distance the
             * indicator is currently holding — otherwise the list would stay pinned open while the
             * user tries to scroll away from the top.
             */
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (!enabled || currentOpen || source != NestedScrollSource.UserInput) return Offset.Zero
                if (available.y >= 0f || offset.value <= 0f) return Offset.Zero
                val consumed = -min(abs(available.y), offset.value)
                scope.launch { offset.snapTo((offset.value + consumed).coerceAtLeast(0f)) }
                return Offset(0f, consumed)
            }

            /**
             * Downward drag the list did not use means it is already at the top; that leftover is
             * what draws the indicator out.
             */
            override fun onPostScroll(
                consumed: Offset,
                available: Offset,
                source: NestedScrollSource,
            ): Offset {
                if (!enabled || currentOpen || source != NestedScrollSource.UserInput) return Offset.Zero
                if (available.y <= 0f) return Offset.Zero
                val resistance = if (offset.value >= triggerPx) OverdragResistance else 1f
                scope.launch { offset.snapTo(offset.value + available.y * resistance) }
                return Offset(0f, available.y)
            }

            /**
             * Release. Past the threshold this hands off to the caller and leaves the indicator up;
             * short of it the indicator retracts. Either way the fling is swallowed, so the list
             * does not lurch as the finger leaves the screen.
             */
            override suspend fun onPreFling(available: Velocity): Velocity {
                if (offset.value <= 0f) return Velocity.Zero
                if (!currentOpen && !fired && offset.value >= triggerPx) {
                    fired = true
                    // Held from the release rather than from the first `refreshing = true`: the
                    // caller may set that flag a frame or two later, and the minimum should cover
                    // the whole visible refresh, not just the part the caller knows about.
                    holding = true
                    currentOnRefresh()
                } else if (!currentOpen) {
                    offset.animateTo(0f, tween(durationMillis = 220))
                }
                return Velocity(0f, available.y)
            }
        }
    }

    Box(modifier = modifier.nestedScroll(connection)) {
        // The indicator sits behind the content and is revealed by it rather than drawn over it,
        // so the page reads as a sheet being peeled down off whatever is underneath.
        RefreshIndicator(
            offsetPx = offset.value,
            triggerPx = triggerPx,
            refreshing = open,
            modifier = Modifier.align(Alignment.TopCenter),
        )
        Box(modifier = Modifier.offsetPx(offset.value)) { content() }
    }
}

/**
 * The spinner: an arc that fills in as the drag approaches the threshold and, once the request is
 * running, spins. Drawn with the same stroke-only vocabulary as the icon pack so it reads as part
 * of the set.
 */
@Composable
private fun RefreshIndicator(
    offsetPx: Float,
    triggerPx: Float,
    refreshing: Boolean,
    modifier: Modifier = Modifier,
) {
    if (offsetPx <= 0.5f) return

    // Progress saturates at the threshold: beyond it the arc is a closed ring and only the position
    // keeps responding, which is what signals that the gesture is ready to be released.
    val progress = (offsetPx / triggerPx).coerceIn(0f, 1f)

    val spin by rememberInfiniteTransition(label = "refresh-spin").animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(durationMillis = 900, easing = LinearEasing)),
        label = "refresh-spin-angle",
    )

    // Centred in the gap the content has opened above it, so the spinner stays put relative to the
    // space it lives in instead of racing the page down the screen.
    val indicatorPx = with(LocalDensity.current) { IndicatorSize.toPx() }
    val y = ((offsetPx - indicatorPx) / 2f).coerceAtLeast(0f)

    Box(
        modifier = modifier.offsetPx(y).size(IndicatorSize),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(IndicatorSize)) {
            val stroke = size.minDimension * 0.11f
            val inset = stroke / 2f
            drawArc(
                color = if (refreshing || progress >= 1f) AppTheme.Primary else AppTheme.Muted,
                startAngle = if (refreshing) spin else -90f,
                sweepAngle = if (refreshing) 90f else 300f * progress,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = Size(size.width - stroke, size.height - stroke),
                style = Stroke(width = stroke, cap = StrokeCap.Round),
                alpha = if (refreshing) 1f else progress,
            )
        }
    }
}

/** Vertical offset in raw pixels — the drag distance is a float, not a rounded dp. */
private fun Modifier.offsetPx(y: Float): Modifier = this.layout { measurable, constraints ->
    val placeable = measurable.measure(constraints)
    layout(placeable.width, placeable.height) { placeable.placeRelative(0, y.toInt()) }
}
