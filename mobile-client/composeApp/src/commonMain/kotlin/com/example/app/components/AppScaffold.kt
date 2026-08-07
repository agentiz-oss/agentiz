package com.example.app.components

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.composeunstyled.Text
import com.example.app.BuildInfo
import com.example.app.platform.hapticActionComplete
import com.example.app.theme.AppTheme
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** One row of the slide-in menu. [danger] marks the destructive entry, i.e. signing out. */
data class MenuEntry(
    val label: String,
    val onClick: () -> Unit,
    val enabled: Boolean = true,
    val danger: Boolean = false,
)

/** How far in from the left edge a drag may start while the drawer is closed. */
private val EdgeSwipeWidth = 24.dp

/**
 * How far the screen travels — and therefore how much menu is uncovered. A fixed width, not a
 * measured one: the menu is not composed while the drawer is closed, so the first frame of an edge
 * swipe needs a travel distance that already exists.
 */
private val DrawerWidth = 280.dp

/**
 * How far the pushed-back screen shrinks, which is what makes it read as a card lifted off the
 * menu. Kept shallow: the inset this leaves at the top and bottom grows twice as fast as the number
 * suggests, and anything deeper reads as the screen falling away rather than sliding aside.
 */
private const val PushedScale = 0.94f

/** Corner radius of the screen at full push; interpolated from square as it lifts. */
private val PushedCorner = 24.dp

/** Drop shadow under the pushed-back screen, so it sits visibly above the menu. */
private val ShadowElevation = 16.dp

/** Fling speed, in px/s, past which the drawer opens or closes regardless of how far it travelled. */
private const val FlingVelocity = 400f

@Composable
private fun rememberDrawerState(): DrawerState {
    val scope = rememberCoroutineScope()
    // Converted here rather than measured from the panel: the drawer is not composed while closed,
    // so the very first frame of an edge swipe needs a width that already exists.
    val widthPx = with(LocalDensity.current) { DrawerWidth.toPx() }
    // Seeded at construction so the width is right on the first frame — a burger tap that lands
    // before any effect has run must still animate the full distance.
    val state = remember(scope) { DrawerState(scope, widthPx) }
    // Only a later *change* is an effect: writing state straight from composition would mutate a
    // snapshot that may yet be discarded.
    SideEffect { state.onWidthChanged(widthPx) }
    return state
}

/**
 * How far the screen has been pushed aside, in pixels, from fully-closed (0f) to fully-open
 * ([width]).
 *
 * This offset is the single source of truth for the whole effect — the card's travel, its scale,
 * its corners and the menu's fade all derive from it. Dragging writes to it directly so the screen
 * tracks the finger 1:1, and the open/close animations write to the same value, so a gesture can
 * interrupt an animation mid-flight without the two fighting over the position.
 */
private class DrawerState(
    private val scope: kotlinx.coroutines.CoroutineScope,
    initialWidth: Float,
) {
    /**
     * Plain state, not an `Animatable`: a drag has to write the new position on the very frame the
     * pointer event arrives. `Animatable.snapTo` is suspending, so routing finger deltas through it
     * would defer each one to a coroutine, and the panel would trail the finger by a frame.
     */
    var offsetPx by mutableFloatStateOf(0f)
        private set

    /** Panel width in px — the distance a full open or close travels. */
    var width by mutableFloatStateOf(initialWidth)
        private set

    /** 0f closed, 1f fully open. Drives the scale, the corners, the fade and who owns a gesture. */
    val progress: Float get() = if (width <= 0f) 0f else (offsetPx / width).coerceIn(0f, 1f)

    /** The running open/close animation, cancelled the moment a finger touches the panel. */
    private var settleJob: Job? = null

    /**
     * The pixel width can change under the drawer when the window moves to a display of a different
     * density. Rescaling by the old-to-new ratio keeps a drawer that was open *stay* open across
     * that change instead of jumping to a stale pixel position.
     */
    fun onWidthChanged(newWidth: Float) {
        if (newWidth <= 0f || newWidth == width) return
        val previous = width
        if (previous > 0f) offsetPx = offsetPx / previous * newWidth
        width = newWidth
    }

    fun open() = animateTo(width)

    fun close() = animateTo(0f)

    private fun animateTo(target: Float) {
        settleJob?.cancel()
        // Width comes from density, so it is only ever zero in a degenerate composition; guarded
        // rather than assumed so an open() there cannot strand the panel at a nonsense offset.
        if (width <= 0f && target != 0f) return
        // Already there — a burger tap on an open drawer, or a settle that picks the end the panel
        // is resting on. Animating zero distance would still fire a tick for a panel that never
        // moved, so leave without one.
        if (offsetPx == target) return
        settleJob = scope.launch {
            animate(
                initialValue = offsetPx,
                targetValue = target,
                animationSpec = tween(if (target > offsetPx) 220 else 180),
            ) { value, _ -> offsetPx = value }
            // Only on a run that reached its target: a gesture grabbing the panel mid-slide cancels
            // this coroutine, and the throw skips the tick. That is what makes the haptic mean "the
            // drawer has settled" rather than "an animation stopped existing".
            hapticActionComplete()
        }
    }

    /**
     * Takes over from whatever animation was running, so grabbing a drawer mid-slide hands it
     * straight to the finger instead of letting the two write competing positions.
     */
    fun onDragStarted() {
        settleJob?.cancel()
        settleJob = null
    }

    /** Moves the panel by one finger delta, clamped so it can never overshoot either end. */
    fun drag(delta: Float) {
        if (width <= 0f) return
        offsetPx = (offsetPx + delta).coerceIn(0f, width)
    }

    /**
     * Decides where the panel lands when the finger lifts: a decisive flick wins outright,
     * otherwise it settles to whichever end it is nearer.
     */
    fun settle(velocity: Float) {
        val target = when {
            velocity > FlingVelocity -> width
            velocity < -FlingVelocity -> 0f
            progress > 0.5f -> width
            else -> 0f
        }
        // A finger that carried the panel the whole way and let go on the end stop has nothing left
        // to animate, so animateTo returns without a tick — but the drawer did just come to rest at
        // an end, which is exactly what the haptic marks. Fire it here instead.
        if (offsetPx == target) {
            hapticActionComplete()
            return
        }
        animateTo(target)
    }
}

/**
 * The frame every signed-in screen sits in: a fixed top bar with a burger on the left, and the
 * screen's own content below it. Navigation and signing out live in the drawer the burger opens,
 * so no screen has to spend its header on them.
 *
 * The drawer does not slide over the screen — it lies *underneath* it. Opening pushes the whole
 * screen right and scales it down to reveal the menu already sitting there, so the two feel like
 * one stack of cards rather than a panel flying in.
 */
@Composable
fun AppScaffold(
    title: String,
    subtitle: String? = null,
    menu: List<MenuEntry>,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
    onBack: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val drawer = rememberDrawerState()

    Box(
        modifier = Modifier
            .fillMaxSize()
            // The backdrop the menu sits on. It shows through the rounded corners of the
            // pushed-back screen, so it is a shade darker than the card itself.
            .background(AppTheme.MenuBackground),
    ) {
        // Drawn first, so it is genuinely behind the screen rather than over it. Its own insets:
        // the frame can no longer pad for everyone now that the two layers move independently.
        MenuPanel(
            drawer = drawer,
            entries = menu,
            onOpenSettings = onOpenSettings,
            onOpenProfile = onOpenProfile,
        )

        ContentSheet(drawer = drawer) {
            // Native and DOM WebViews are separate platform layers and cannot inherit the card's
            // graphicsLayer transform. Give them the drawer state so they can be hidden before
            // they obscure the menu.
            CompositionLocalProvider(LocalDrawerProgress provides drawer.progress) {
                Column(modifier = Modifier.fillMaxSize()) {
                    TopBar(
                        title = title,
                        subtitle = subtitle,
                        onBack = onBack,
                        onOpenMenu = { drawer.open() },
                    )
                    // weight, not fillMaxSize: the content takes the height the bar leaves rather than
                    // the whole frame, which keeps a scrolling list from running under the bar.
                    Box(modifier = Modifier.fillMaxWidth().weight(1f)) { content() }
                }
            }
        }

        // Last, so it sits above the card it drives — and outside it, so the card's scale cannot
        // distort the finger deltas.
        DrawerGestureSurface(drawer = drawer)
    }
}

/**
 * The screen itself, as a card that slides and shrinks to uncover the menu. Purely presentational —
 * the gestures that move it belong to [DrawerGestureSurface], which sits outside this layer.
 */
@Composable
private fun ContentSheet(drawer: DrawerState, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .graphicsLayer {
                val p = drawer.progress
                translationX = drawer.offsetPx
                // Shrink towards the left edge so the card pivots around the point the finger is
                // pulling from; scaling about the centre would make it drift away from the touch.
                val scale = 1f - (1f - PushedScale) * p
                scaleX = scale
                scaleY = scale
                transformOrigin = TransformOrigin(0f, 0.5f)
                // Corners round off only as the card lifts: a full-screen sheet with rounded
                // corners would show slivers of backdrop at rest.
                shape = RoundedCornerShape(PushedCorner * p)
                clip = true
                shadowElevation = ShadowElevation.toPx() * p
            }
            .background(AppTheme.Background),
    ) {
        // Padded here, not on the frame: the card is what the user reads, and it is the thing that
        // has to clear the status bar and the home indicator.
        Box(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            content()
        }
    }
}

/**
 * The invisible surface that owns every drawer gesture: a strip down the left edge while closed,
 * the whole screen once open.
 *
 * Deliberately a sibling of the card rather than a child of it. `draggable` reports deltas in the
 * coordinate space of its own layer, so a grab area living inside the scaled card would report
 * movement divided by that scale — at 0.88 the drawer would run about 1.14x ahead of the finger
 * instead of tracking it. Out here the space is the screen's, and a pixel of finger is a pixel of
 * travel.
 */
@Composable
private fun BoxScope.DrawerGestureSurface(drawer: DrawerState) {
    val open = drawer.progress > 0f
    Box(
        modifier = Modifier
            .align(Alignment.CenterStart)
            .fillMaxHeight()
            // Tracks the card: starts where the card starts and stops where it ends, so the strip
            // of menu uncovered to its left keeps receiving its own taps.
            .offset { IntOffset(drawer.offsetPx.roundToInt(), 0) }
            .then(
                // The card is drawn at PushedScale, so that fraction of the screen is exactly how
                // much of it the finger can still reach.
                if (open) {
                    Modifier.fillMaxWidth(PushedScale)
                } else {
                    Modifier.width(EdgeSwipeWidth)
                },
            )
            .draggable(
                orientation = Orientation.Horizontal,
                state = rememberDraggableState { delta -> drawer.drag(delta) },
                onDragStarted = { drawer.onDragStarted() },
                onDragStopped = { velocity -> drawer.settle(velocity) },
            )
            // Once open this also swallows taps meant for the pushed-aside screen and turns them
            // into a dismissal — the card doubles as its own scrim.
            .then(
                if (open) {
                    Modifier.clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = { drawer.close() },
                    )
                } else {
                    Modifier
                },
            ),
    )
}

/**
 * The left-edge grab area that opens the drawer by drag.
 *
 * It stays composed for the whole gesture and only stops *listening* once the panel is fully out —
 * removing the modifier the moment the offset left zero would cancel the very drag that was opening
 * it. Past that point the scrim and the panel own the gesture, and a catcher still live underneath
 * would steal the drag meant to push the panel back.
 */
@Composable
private fun BoxScope.EdgeSwipeCatcher(drawer: DrawerState) {
    Box(
        modifier = Modifier
            .align(Alignment.CenterStart)
            .fillMaxHeight()
            .width(EdgeSwipeWidth)
            .draggable(
                orientation = Orientation.Horizontal,
                enabled = drawer.progress < 1f,
                state = rememberDraggableState { delta -> drawer.drag(delta) },
                onDragStarted = { drawer.onDragStarted() },
                onDragStopped = { velocity -> drawer.settle(velocity) },
            ),
    )
}

@Composable
private fun TopBar(
    title: String,
    subtitle: String?,
    onBack: (() -> Unit)?,
    onOpenMenu: () -> Unit,
) {
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(AppTheme.Background)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onOpenMenu,
                label = "Открыть меню",
            ) { tint -> BurgerIcon(tint) }

            Column(
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
            ) {
                Text(
                    text = title,
                    style = AppTheme.Subtitle,
                    color = AppTheme.Foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = AppTheme.Label,
                        color = AppTheme.Muted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            // Back is the screen's own affordance, not the menu's, so it stays on the bar — but
            // only where there is somewhere to go back to.
            if (onBack != null) {
                IconButton(onClick = onBack, label = "Назад") { tint ->
                    BackIcon(tint)
                }
            }
        }
        Divider()
    }
}

/**
 * The menu, lying still underneath the screen. Unlike a conventional drawer it never moves: the
 * screen is what slides off it, so the entries stay put while the card uncovers them.
 *
 * A fully-closed menu is not composed at all — its rows would otherwise be read out by a screen
 * reader and matched by `onNodeWithText` while nobody can see them.
 */
@Composable
private fun BoxScope.MenuPanel(
    drawer: DrawerState,
    entries: List<MenuEntry>,
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    if (drawer.progress <= 0f) return

    Column(
        modifier = Modifier
            .align(Alignment.CenterStart)
            .fillMaxHeight()
            // Only ever as wide as the screen travels, so no entry can hide under the card.
            .width(DrawerWidth)
            // Fades and settles the last few pixels into place, so the entries do not appear
            // fully-formed the instant the card starts to move.
            .graphicsLayer { alpha = drawer.progress }
            // Its own insets: with the two layers moving independently the frame can no longer
            // pad for both at once.
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                // Its own scroll: a menu that grows past a short window must not clip its last
                // entry, which on this app is the one that signs you out.
                .verticalScroll(rememberScrollState())
                .padding(vertical = 8.dp),
        ) {
            // No close button: the pushed-aside screen is always on show and always dismisses on
            // tap, so a second way out would only crowd the header.
            Text(
                text = "Меню",
                style = AppTheme.Title,
                color = AppTheme.Foreground,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
            Spacer(Modifier.height(8.dp))

            entries.forEach { entry ->
                MenuRow(entry = entry, onDismiss = { drawer.close() })
            }
        }

        // Pinned to the bottom of the panel rather than to the end of the scrolling list: the
        // build stamp is a footer, and a footer that scrolls away is one you have to hunt for.
        Divider()
        FooterActions(
            onOpenSettings = onOpenSettings,
            onOpenProfile = onOpenProfile,
            onDismiss = { drawer.close() },
        )
        BuildStamp()
    }
}

/**
 * Settings and account, as icons rather than another two rows of the list above.
 *
 * They sit here because neither is a place you go the way "Проекты" is — one is the app's own
 * configuration and the other is who you are signed in as, and both are what you reach for *after*
 * scanning the list rather than while scanning it. Icons keep them available without lengthening
 * the thing you flick through.
 */
@Composable
private fun FooterActions(
    onOpenSettings: () -> Unit,
    onOpenProfile: () -> Unit,
    onDismiss: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
            onClick = {
                // Closed before navigating, exactly as the rows above do: a drawer left standing
                // over the screen it just opened has to be dismissed by hand.
                onDismiss()
                onOpenSettings()
            },
            label = "Настройки",
        ) { tint -> SettingsIcon(tint) }

        IconButton(
            onClick = {
                onDismiss()
                onOpenProfile()
            },
            label = "Профиль",
        ) { tint -> PersonIcon(tint) }
    }
}

/** Which build this is — the first thing to ask for when a bug report comes in. */
@Composable
private fun BuildStamp() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
        Text(
            text = "Версия ${BuildInfo.VERSION}",
            style = AppTheme.Label,
            color = AppTheme.Muted,
        )
        Text(
            text = BuildInfo.COMMIT + if (BuildInfo.DIRTY) "*" else "",
            style = AppTheme.Label,
            color = AppTheme.Muted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MenuRow(entry: MenuEntry, onDismiss: () -> Unit) {
    val color = when {
        !entry.enabled -> AppTheme.Disabled
        entry.danger -> AppTheme.Danger
        else -> AppTheme.Foreground
    }
    Text(
        text = entry.label,
        style = AppTheme.Body,
        color = color,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(AppTheme.Radius))
            .clickable(enabled = entry.enabled, role = Role.Button) {
                // Closing before acting: every entry either navigates or signs out, and a drawer
                // still standing over the new screen would have to be dismissed by hand.
                onDismiss()
                entry.onClick()
            }
            .padding(horizontal = 12.dp, vertical = 14.dp),
    )
}

/** A 44.dp round tap target — the platform minimum — wrapping a hand-drawn glyph. */
@Composable
private fun IconButton(
    onClick: () -> Unit,
    label: String,
    enabled: Boolean = true,
    icon: @Composable (Color) -> Unit,
) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        icon(if (enabled) AppTheme.Foreground else AppTheme.Disabled)
    }
}

@Composable
private fun Divider() {
    Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(AppTheme.Border))
}
