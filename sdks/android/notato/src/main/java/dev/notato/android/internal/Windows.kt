package dev.notato.android.internal

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.core.graphics.createBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import java.lang.reflect.Field
import java.util.WeakHashMap
import kotlin.coroutines.resume

/**
 * The app's window as it was on screen, without Notato's overlay. A full-resolution picture is several megabytes, so it
 * is recycled as soon as the note's screenshots are made from it, not left for the collector. Main thread only.
 */
internal class CapturedScreen(val bitmap: Bitmap, val density: Float) {
    private var users = 0
    private var released = false

    /**
     * Runs [block] with the picture, or gives null when it is gone already. One released while [block] runs (the
     * composer closed while its note is being made) is recycled once [block] is done with it.
     */
    suspend fun <T> use(block: suspend (Bitmap) -> T): T? {
        if (released || bitmap.isRecycled) return null
        users++
        try {
            return block(bitmap)
        } finally {
            if (--users == 0 && released) recycle()
        }
    }

    /** Done with: recycled now, or when the last [use] of it ends. */
    fun release() {
        released = true
        if (users == 0) recycle()
    }

    private fun recycle() {
        if (!bitmap.isRecycled) bitmap.recycle()
    }
}

/**
 * Hides a view while any capture needs it hidden. Captures overlap (two agent requests, or a tap during one), so each
 * one hides and shows it again, and it comes back, as it was before the first, only when the last one is done.
 * Main thread only.
 */
internal class Hider<T : Any>(private val visibility: (T) -> Int, private val setVisibility: (T, Int) -> Unit) {
    private class Held(var count: Int, val was: Int)

    private val held = WeakHashMap<T, Held>()

    fun hide(target: T) {
        val entry = held.getOrPut(target) { Held(0, visibility(target)) }
        if (entry.count++ == 0) setVisibility(target, View.INVISIBLE)
    }

    fun show(target: T) {
        val entry = held[target] ?: return
        if (--entry.count > 0) return
        held.remove(target)
        setVisibility(target, entry.was)
    }
}

/**
 * Which of the app's windows Notato's overlay belongs in. A dialog is a window of its own on Android, so while a
 * full-screen one shows (a Compose `Dialog` with platform width off, a bottom sheet, a full-screen DialogFragment) the
 * overlay moves into it. Small dialogs are left alone: an overlay inside one would be clipped to its size.
 */
internal object Windows {
    /**
     * Before Android 10, the window manager's own list, through reflection as UI test tools read it: looked up once,
     * not four times a second. Null when it cannot be read.
     */
    private val legacyViews: Pair<Any, Field>? by lazy { windowManagerViews() }

    @SuppressLint("PrivateApi") // Espresso and Layout Inspector read it too; without it, dialogs are simply not covered.
    private fun windowManagerViews(): Pair<Any, Field>? = try {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val instance = global.getMethod("getInstance").invoke(null)
        instance?.let { it to global.getDeclaredField("mViews").apply { isAccessible = true } }
    } catch (_: Throwable) {
        null
    }

    /** Every window root view of this process, oldest first. */
    private fun roots(): List<View> = try {
        if (Build.VERSION.SDK_INT >= 29) {
            WindowInspector.getGlobalWindowViews()
        } else {
            val (instance, field) = legacyViews ?: return emptyList()
            @Suppress("UNCHECKED_CAST")
            (field.get(instance) as? List<View>)?.toList() ?: emptyList()
        }
    } catch (_: Throwable) {
        emptyList()
    }

    /** The top window that covers the activity: its decor view, which the overlay is added to. */
    fun top(activity: Activity): ViewGroup? {
        val base = activity.window?.decorView as? ViewGroup ?: return null
        val candidates = roots().filter { root ->
            root !== base && root.isShown && root.isAttachedToWindow && root is ViewGroup &&
                root.context.let { context -> generateSequence(context) { (it as? ContextWrapper)?.baseContext }.any { it === activity } } &&
                (root.layoutParams as? WindowManager.LayoutParams)?.type.let { it == WindowManager.LayoutParams.TYPE_APPLICATION || it == WindowManager.LayoutParams.TYPE_BASE_APPLICATION } &&
                root.width >= base.width * 0.9f && root.height >= base.height * 0.6f
        }
        return (candidates.lastOrNull() as? ViewGroup) ?: base
    }

    /** Waits for a frame to be drawn. */
    private suspend fun nextFrame() = suspendCancellableCoroutine { continuation ->
        val callback = Choreographer.FrameCallback { continuation.resume(Unit) }
        Choreographer.getInstance().postFrameCallback(callback)
        continuation.invokeOnCancellation { Choreographer.getInstance().removeFrameCallback(callback) }
    }

    private val overlays = Hider<View>({ it.visibility }, { view, value -> view.visibility = value })

    /**
     * A picture of [root]'s window. The overlay is in the same window, so it is hidden for the frames in which the
     * window is copied.
     */
    suspend fun capture(activity: Activity, root: View, overlay: View?): CapturedScreen? {
        if (root.width == 0 || root.height == 0) return null
        val bitmap = createBitmap(root.width, root.height)
        overlay?.let { overlays.hide(it) }
        try {
            nextFrame()
            nextFrame()
            val copied = when {
                Build.VERSION.SDK_INT >= 34 && root !== activity.window.decorView -> copy(PixelCopy.Request.Builder.ofWindow(root).setDestinationBitmap(bitmap).build())
                Build.VERSION.SDK_INT >= 26 && root === activity.window.decorView -> copy(activity, bitmap)
                else -> false
            }
            if (!copied) root.draw(Canvas(bitmap))
        } catch (error: CancellationException) {
            bitmap.recycle()
            throw error
        } catch (_: Throwable) {
            runCatching { root.draw(Canvas(bitmap)) }.getOrElse {
                bitmap.recycle()
                return null
            }
        } finally {
            overlay?.let { overlays.show(it) }
        }
        return CapturedScreen(bitmap, root.resources.displayMetrics.density)
    }

    private suspend fun copy(activity: Activity, bitmap: Bitmap): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        return suspendCancellableCoroutine { continuation ->
            PixelCopy.request(activity.window, bitmap, { result -> continuation.resume(result == PixelCopy.SUCCESS) }, Handler(Looper.getMainLooper()))
        }
    }

    private suspend fun copy(request: PixelCopy.Request): Boolean {
        if (Build.VERSION.SDK_INT < 34) return false
        return suspendCancellableCoroutine { continuation ->
            PixelCopy.request(request, { it.run() }) { result -> continuation.resume(result.status == PixelCopy.SUCCESS) }
        }
    }
}

/**
 * Takes the picture first and reads the screen after it, so what the reading says to cover (private elements, secure
 * and masked fields) is where it was in the picture. Read the other way round, a field that moved or appeared between
 * the two would be in the picture uncovered.
 */
internal suspend fun <P, S> captureThenScan(capture: suspend () -> P?, scan: () -> S): Pair<P?, S> {
    val picture = capture()
    return picture to scan()
}
