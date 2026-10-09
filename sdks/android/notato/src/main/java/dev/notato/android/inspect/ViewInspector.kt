package dev.notato.android.inspect

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContextWrapper
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.AbsListView
import android.widget.CheckBox
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import dev.notato.android.R
import dev.notato.android.model.ComponentInfo
import java.lang.ref.WeakReference
import java.util.Locale

/** What a provider is told about the View that holds what it describes. */
public class HostInfo(
    /** The screen the host view is on: a Fragment or an Activity. */
    public val screen: String?,
    /** The Activity, then any Fragments, outermost first. */
    public val components: List<String>,
    /** The views around the host, outermost first. */
    public val ancestors: List<String>,
    /** The screen's density: pixels per dp. */
    public val density: Float,
    /** How private the host view is (`Notato.mask` on it or a view around it): what it holds is at least this private. */
    public val privacy: Privacy = Privacy.DEFAULT,
    /**
     * A reading for the pins, taken whenever the screen has settled: each element need say only what a selector looks
     * at (its role, control, id, words, place and privacy), not its styles or where it is written.
     */
    public val lite: Boolean = false,
    /**
     * Whether the window has been still for a moment. While it keeps drawing (a list scrolling), [ElementProvider.screenOf]
     * may answer from what it worked out last rather than work it out again on the main thread mid-scroll.
     */
    public val settled: Boolean = true,
)

/**
 * Sees into a view the View tree cannot: `notato-compose` registers one for Compose. Bounds are in window pixels, the
 * same space as [View.getLocationInWindow].
 */
public interface ElementProvider {
    /** Whether [view] is one this provider sees into (a `ComposeView`): the View tree stops there and asks it. */
    public fun handles(view: View): Boolean

    /** Every element inside [view], in drawing order. */
    public fun elements(view: View, host: HostInfo, maskInputs: Boolean): List<ScreenElement>

    /** The elements at a point inside [view], innermost first. */
    public fun chainAt(view: View, x: Float, y: Float, host: HostInfo, maskInputs: Boolean): List<ScreenElement>

    /** The screen [view] shows (`ProductListScreen`), for the route, or null when the provider cannot tell. */
    public fun screenOf(view: View, host: HostInfo): String? = null

    /**
     * Where the live object behind one of this provider's elements ([ScreenElement.ref]) is now, in window pixels:
     * asked on every frame while a pin follows it, so it must be cheap. Null when [ref] is not one of this provider's,
     * or what it points at has gone or now shows something else (a list row reused for another item).
     */
    public fun boundsOf(ref: WeakReference<Any>): Box? = null
}

/**
 * One reading of the screen: what it works out once and uses for every view in it (the Fragments each view is in, from
 * the views around it). A [lite] reading is for the pins: it describes only what a selector looks at.
 */
internal class Reading(val lite: Boolean = false) {
    val fragments = HashMap<View, List<String>>()
}

/** Reads the View tree: what is at a point, and how to describe a view so the agent can find it in the code. */
internal object ViewInspector {
    val providers = mutableListOf<ElementProvider>()

    /** Views Notato itself added (its overlay): never picked. */
    const val OWN_TAG = "notato.own"

    /** Views that are only framework plumbing around the app's content: looked through when describing. */
    private val plumbing = setOf(
        "DecorView", "LinearLayout", "FrameLayout", "ContentFrameLayout", "ActionBarOverlayLayout", "FitWindowsLinearLayout",
        "FitWindowsFrameLayout", "ActionBarContainer", "ViewStub", "FragmentContainerView", "CoordinatorLayout", "ComposeView",
        "AndroidComposeView",
    )

    private fun isOwn(view: View) = view.tag == OWN_TAG

    /** The mark `Notato.mask` left on a view: true (private), false (not private) or null. */
    fun markOf(view: View): Boolean? = view.getTag(R.id.notato_mask) as? Boolean

    /** What `Notato.mask` says about a view, from its own mark and those of the views it sits in. */
    fun privacyOf(view: View): Privacy = Privacy.of(generateSequence(view) { it.parent as? View }.map(::markOf))

    /** Whether a view is an element of its own: not plumbing, unless it has an id or is marked private (to be covered). */
    private fun listed(view: View) = controlName(view) !in plumbing || idName(view) != null || markOf(view) == true

    /** Pixels as sp, through Android 14's non-linear font scaling where there is one. */
    private fun spOf(px: Float, view: View): Float = if (Build.VERSION.SDK_INT >= 34) {
        android.util.TypedValue.deriveDimension(android.util.TypedValue.COMPLEX_UNIT_SP, px, view.resources.displayMetrics)
    } else {
        px / android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, 1f, view.resources.displayMetrics)
    }

    fun windowBox(view: View): Box {
        val location = IntArray(2)
        view.getLocationInWindow(location)
        return Box(location[0].toFloat(), location[1].toFloat(), (location[0] + view.width).toFloat(), (location[1] + view.height).toFloat())
    }

    private fun visibleBox(view: View): Box? {
        if (!view.isShown || view.width == 0 || view.height == 0 || view.alpha < 0.01f) return null
        val rect = Rect()
        if (!view.getGlobalVisibleRect(rect) || rect.isEmpty) return null
        // Global coordinates are the root view's, which is the window's for an app window.
        val rootLocation = IntArray(2).also { view.rootView.getLocationInWindow(it) }
        return Box((rect.left + rootLocation[0]).toFloat(), (rect.top + rootLocation[1]).toFloat(), (rect.right + rootLocation[0]).toFloat(), (rect.bottom + rootLocation[1]).toFloat())
    }

    /** Children in the order they are drawn, the topmost (highest z, then last) first. */
    private fun topmostFirst(group: ViewGroup): List<View> =
        (0 until group.childCount).map { group.getChildAt(it) }
            .withIndex()
            .sortedWith(compareByDescending<IndexedValue<View>> { it.value.z }.thenByDescending { it.index })
            .map { it.value }

    // ---- what is where ----------------------------------------------------------------------------------------------

    /** The views (and provider elements) at a point of [root]'s window, innermost first. */
    fun chainAt(root: View, x: Float, y: Float, maskInputs: Boolean): List<ScreenElement> {
        val reading = Reading()
        val views = mutableListOf<View>()
        var current: View? = root
        var provided: List<ScreenElement> = emptyList()
        while (current != null) {
            views += current
            val provider = providers.firstOrNull { it.handles(current!!) }
            if (provider != null) {
                provided = runCatching { provider.chainAt(current, x, y, hostInfo(current, reading), maskInputs) }.getOrDefault(emptyList())
                break
            }
            val group = current as? ViewGroup ?: break
            current = topmostFirst(group).firstOrNull { child -> !isOwn(child) && visibleBox(child)?.contains(x, y) == true }
        }
        return provided + views.asReversed().filter { it !== root && listed(it) }.map { describe(it, maskInputs, reading) }
    }

    /**
     * For the route: what the innermost of the app's views at a point of [root]'s window is in, as describing it would
     * say (the Fragments after its Activity, when it has both) and its screen (its Fragment, else its Activity). Nothing
     * is described, so it is cheap enough to ask whenever the screen may have changed.
     */
    fun screenAt(root: View, x: Float, y: Float): Pair<List<String>, String?> {
        var current: View? = root
        var innermost: View? = null
        while (current != null) {
            if (current !== root && listed(current)) innermost = current
            if (providers.any { it.handles(current!!) }) break
            val group = current as? ViewGroup ?: break
            current = topmostFirst(group).firstOrNull { child -> !isOwn(child) && visibleBox(child)?.contains(x, y) == true }
        }
        val view = innermost ?: return emptyList<String>() to null
        val fragments = fragmentsOf(view)
        val activity = activityOf(view)?.javaClass?.simpleName
        val components = listOfNotNull(activity) + fragments
        val screen = fragments.lastOrNull() ?: activity
        return (if (screen != null && components.size >= 2) components.drop(1) else emptyList()) to screen
    }

    /**
     * The screen a provider's view shows, from the largest such view on screen (a ComposeView). Not [settled] (the
     * window is still drawing), a provider may answer from what it worked out last.
     */
    fun providedScreen(root: View, settled: Boolean = true): String? {
        var best: Pair<Float, String>? = null
        fun visit(view: View) {
            if (isOwn(view)) return
            val box = visibleBox(view) ?: return
            val provider = providers.firstOrNull { it.handles(view) }
            if (provider != null) {
                val screen = runCatching { provider.screenOf(view, hostInfo(view, settled = settled)) }.getOrNull()
                if (screen != null && (best == null || box.area > best!!.first)) best = box.area to screen
                return
            }
            if (view is ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
        }
        visit(root)
        return best?.second
    }

    /**
     * Every element in [root]'s window, in drawing order, for selectors and pins. [lite] is for the pins, read twice a
     * second: each element says only what a selector looks at (its kind, role, control, id, words and place), not its
     * styles, layout file, ancestors or screen.
     */
    fun elements(root: View, maskInputs: Boolean, lite: Boolean = false): List<ScreenElement> {
        val reading = Reading(lite)
        val out = mutableListOf<ScreenElement>()
        fun visit(view: View) {
            if (isOwn(view) || visibleBox(view) == null) return
            val provider = providers.firstOrNull { it.handles(view) }
            if (view !== root && (view.javaClass.simpleName !in plumbing || view.id != View.NO_ID || markOf(view) == true)) out += describe(view, maskInputs, reading)
            if (provider != null) {
                out += runCatching { provider.elements(view, hostInfo(view, reading), maskInputs) }.getOrDefault(emptyList())
                return
            }
            if (view is ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
        }
        visit(root)
        return out
    }

    // ---- describing a view ---------------------------------------------------------------------------------------

    fun idName(view: View): String? {
        if (view.id == View.NO_ID || view.id ushr 24 == 0) return null // no id, or one made at runtime
        return runCatching { view.resources.getResourceEntryName(view.id) }.getOrNull()
    }

    fun controlName(view: View): String {
        var type: Class<*> = view.javaClass
        while (type.simpleName.isEmpty() || type.isAnonymousClass) type = type.superclass ?: break
        return type.simpleName
    }

    /** Input types that hold a password, as class and variation together. */
    private val passwordTypes = setOf(
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        // Shown for now (an eye toggled), but a password all the same.
        InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
        InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
    )

    /**
     * Whether an input type is a password's. A variation means something only with its class: the number password's
     * bits are also a text field's URI and a date field's date.
     */
    fun isPasswordType(inputType: Int): Boolean =
        (inputType and (InputType.TYPE_MASK_CLASS or InputType.TYPE_MASK_VARIATION)) in passwordTypes

    private fun isSecure(view: View): Boolean {
        val text = view as? TextView ?: return false
        return text.transformationMethod is PasswordTransformationMethod || isPasswordType(text.inputType)
    }

    private fun roleOf(view: View): String? = when {
        view is Switch || view.javaClass.simpleName.contains("Switch") -> "switch"
        view is CheckBox -> "checkbox"
        view is RadioButton -> "radio"
        view is CompoundButton -> "switch"
        view is EditText -> "textbox"
        view is android.widget.Button || view is ImageButton -> "button"
        view is TextView && Build.VERSION.SDK_INT >= 28 && view.isAccessibilityHeading -> "heading"
        view is TextView -> "text"
        view is ImageView -> "img"
        view is SeekBar -> "slider"
        view is ProgressBar -> "progressbar"
        view is AbsListView || view.javaClass.simpleName == "RecyclerView" -> "list"
        view is WebView -> "document"
        view.isClickable -> "button"
        else -> null
    }

    /** Runs of white space, made into one space: compiled once, not for every view of every reading. */
    private val spaces = Regex("\\s+")

    private fun clip(text: CharSequence?, max: Int = 200): String? {
        val one = text?.toString()?.replace(spaces, " ")?.trim(' ')?.ifEmpty { null } ?: return null
        return if (one.length > max) one.take(max - 1) + "…" else one
    }

    /** A container's text is the text inside it, the way a web page's text content reads: never fields' or private views'. */
    private fun textInside(view: View): String? {
        val parts = mutableListOf<String>()
        fun visit(v: View) {
            if (!v.isShown || markOf(v) == true || parts.sumOf { it.length } > 200) return
            if (v is TextView && v !is EditText) clip(v.text)?.let { parts += it }
            if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i))
        }
        visit(view)
        return clip(parts.joinToString(" "))
    }

    fun activityOf(view: View): Activity? {
        var context = view.context
        while (context is ContextWrapper) {
            if (context is Activity) return context
            context = context.baseContext
        }
        return null
    }

    /**
     * The id AndroidX Fragment tags each Fragment's view with (what `FragmentManager.findFragment` reads), looked up by
     * name once: 0 when the app has no Fragments. Reading the tag needs no reflection, and no exception is thrown (as
     * `findFragment` throws one) for every view that is in no Fragment.
     */
    private var fragmentTagId: Int? = null

    @SuppressLint("DiscouragedApi") // Once per process; the library cannot name another library's id at compile time.
    private fun fragmentTag(view: View): Int = fragmentTagId ?: runCatching {
        // In the app's own resource table, which is where Notato's ids are too (whatever the application id).
        val resources = view.resources
        resources.getIdentifier("fragment_container_view_tag", "id", resources.getResourcePackageName(R.id.notato_mask))
    }.getOrDefault(0).also { fragmentTagId = it }

    /**
     * The Fragments a view is in, outermost first: each Fragment's view carries its Fragment in a tag, so they are read
     * from the view and the views around it. [cache] keeps what was found for each view on the way up, so a reading of
     * the whole screen walks each Fragment's views once.
     */
    fun fragmentsOf(view: View, cache: MutableMap<View, List<String>>? = null): List<String> {
        val tag = fragmentTag(view)
        if (tag == 0) return emptyList()
        val path = ArrayList<View>()
        var names: List<String> = emptyList()
        var current: View? = view
        while (current != null) {
            val known = cache?.get(current)
            if (known != null) {
                names = known
                break
            }
            path += current
            current = current.parent as? View
        }
        for (v in path.asReversed()) {
            v.getTag(tag)?.let { fragment -> names = names + fragment.javaClass.simpleName }
            cache?.put(v, names)
        }
        return names
    }

    /** What a provider is told about [view], the View it reads into; [reading] shares what is worked out once per reading. */
    fun hostInfo(view: View, reading: Reading? = null, settled: Boolean = true): HostInfo {
        val density = view.resources.displayMetrics.density
        // The pins need only how private the view is: not where it is, nor what is around it.
        if (reading?.lite == true) return HostInfo(null, emptyList(), emptyList(), density, privacyOf(view), lite = true)
        val fragments = fragmentsOf(view, reading?.fragments)
        val activity = activityOf(view)?.javaClass?.simpleName
        val components = listOfNotNull(activity) + fragments
        return HostInfo(fragments.lastOrNull() ?: activity, components, ancestorsOf(view), density, privacyOf(view), settled = settled)
    }

    private fun shortName(view: View) = controlName(view) + (idName(view)?.let { "#$it" } ?: "")

    private fun ancestorsOf(view: View, limit: Int = 6): List<String> {
        val names = mutableListOf<String>()
        var parent = view.parent as? View
        while (parent != null && names.size < limit) {
            if (controlName(parent) !in plumbing || idName(parent) != null) names.add(0, shortName(parent))
            parent = parent.parent as? View
        }
        return names
    }

    private fun hex(color: Int): String {
        val alpha = color ushr 24
        val rgb = String.format(Locale.US, "#%06x", color and 0xFFFFFF)
        return if (alpha == 0xFF) rgb else rgb + String.format(Locale.US, "%02x", alpha)
    }

    private fun stylesOf(view: View): Map<String, String> {
        val density = view.resources.displayMetrics.density
        // In dp, to a tenth, as Compose elements give them: "48dp", "9.9dp".
        fun dp(px: Number): String {
            val tenths = Math.round(px.toFloat() / density * 10)
            return if (tenths % 10 == 0) "${tenths / 10}dp" else String.format(Locale.US, "%.1fdp", tenths / 10f)
        }
        val styles = linkedMapOf("width" to dp(view.width), "height" to dp(view.height))
        if (view.paddingLeft or view.paddingTop or view.paddingRight or view.paddingBottom != 0) {
            styles["padding"] = "${dp(view.paddingTop)} ${dp(view.paddingRight)} ${dp(view.paddingBottom)} ${dp(view.paddingLeft)}"
        }
        (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { m ->
            if (m.leftMargin or m.topMargin or m.rightMargin or m.bottomMargin != 0) {
                styles["margin"] = "${dp(m.topMargin)} ${dp(m.rightMargin)} ${dp(m.bottomMargin)} ${dp(m.leftMargin)}"
            }
        }
        (view.background as? ColorDrawable)?.color?.takeIf { it ushr 24 != 0 }?.let { styles["background"] = hex(it) }
        view.backgroundTintList?.defaultColor?.let { styles["background-tint"] = hex(it) }
        if (view.alpha < 1f) styles["alpha"] = String.format(Locale.US, "%.2f", view.alpha)
        if (view.elevation > 0f) styles["elevation"] = dp(view.elevation)
        if (!view.isEnabled) styles["enabled"] = "false"
        if (view is TextView) {
            styles["color"] = hex(view.currentTextColor)
            styles["font-size"] = String.format(Locale.US, "%.1fsp", spOf(view.textSize, view))
            val style = view.typeface?.style ?: Typeface.NORMAL
            if (style and Typeface.BOLD != 0) styles["font-weight"] = "bold"
            if (style and Typeface.ITALIC != 0) styles["font-style"] = "italic"
            if (view.maxLines in 1 until Int.MAX_VALUE) styles["max-lines"] = view.maxLines.toString()
        }
        return styles
    }

    /** The layout file a view was inflated from: known when view attribute inspection is on (see the README). */
    private fun layoutOf(view: View): String? {
        if (Build.VERSION.SDK_INT < 29) return null
        var v: View? = view
        while (v != null) {
            val id = v.sourceLayoutResId
            if (id != 0) return runCatching { "res/layout/${v.resources.getResourceEntryName(id)}.xml" }.getOrNull()
            v = v.parent as? View
        }
        return null
    }

    /** Describes one view: what it is, what it says (unless it is private), where it is and what it is in. */
    fun describe(view: View, maskInputs: Boolean, reading: Reading = Reading()): ScreenElement {
        val lite = reading.lite
        val info = hostInfo(view, reading)
        val privacy = info.privacy
        // A private view says nothing: no text, hint or content description, and none of the text inside it.
        val hidden = privacy == Privacy.PRIVATE
        val secure = isSecure(view)
        val input = view is EditText
        val ownText = (view as? TextView)?.takeUnless { privacy.hides(input, secure, maskInputs) }?.let { clip(it.text) }
        val hint = (view as? TextView)?.hint?.takeUnless { hidden }?.let { clip(it) }
        val description = view.contentDescription?.takeUnless { hidden }?.let { clip(it) }
        val text = ownText ?: if (!hidden && view is ViewGroup && (view.isClickable || idName(view) != null)) textInside(view) else null
        val layout = if (lite) null else layoutOf(view)
        return ScreenElement(
            kind = "view",
            role = roleOf(view),
            label = description ?: (if (input) hint else null) ?: ownText,
            text = text,
            identifier = idName(view),
            control = controlName(view),
            bounds = windowBox(view),
            isTextInput = input,
            isSecure = secure,
            source = null,
            component = info.screen?.let { ComponentInfo(it, layout, info.components.takeIf { c -> c.size >= 2 }) },
            ancestors = info.ancestors.ifEmpty { null },
            styles = if (lite) null else stylesOf(view),
            screen = info.screen,
            // Kept in a reading for the pins too: a pin follows its view from frame to frame through it.
            ref = WeakReference(view),
            isMasked = hidden,
            isUnmasked = privacy == Privacy.SHOWN,
        )
    }
}
