package dev.notato.android.inspect

import dev.notato.android.model.ComponentInfo
import dev.notato.android.model.SourceLocation
import java.lang.ref.WeakReference

/** A rectangle in window pixels. Plain numbers so the selector code can be tested without Android. */
public data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    public val width: Float get() = right - left
    public val height: Float get() = bottom - top
    public val area: Float get() = width.coerceAtLeast(0f) * height.coerceAtLeast(0f)

    /** Whether the point is inside it (its left and top edges included, its right and bottom not). */
    public fun contains(x: Float, y: Float): Boolean = x >= left && x < right && y >= top && y < bottom

    /** Whether [other] is inside it, give or take a pixel. */
    public fun contains(other: Box): Boolean = other.left >= left - 1 && other.top >= top - 1 && other.right <= right + 1 && other.bottom <= bottom + 1

    /** The smallest box around both. */
    public fun union(other: Box): Box = Box(minOf(left, other.left), minOf(top, other.top), maxOf(right, other.right), maxOf(bottom, other.bottom))
}

/**
 * How private an element is, from `Notato.mask` on a View or `Modifier.notatoMask` on a composable, on it or on
 * anything it sits in. A private container makes everything in it private, and that wins over a field inside it marked
 * not private. Providers use it so every kind of element follows the same rules.
 */
public enum class Privacy {
    /** Not marked: a secure field is masked, and a text field is when `maskInputs` is on. */
    DEFAULT,

    /** Marked private, or inside something that is: covered in screenshots, and none of its text is recorded. */
    PRIVATE,

    /** Marked not private (a search box): a text field shown, and its value recorded, even when `maskInputs` is on. */
    SHOWN;

    /** The privacy of something inside an element of this privacy, with its own [mark] (null when it has none). */
    public fun withMark(mark: Boolean?): Privacy = when {
        this == PRIVATE || mark == true -> PRIVATE
        mark == false -> SHOWN
        else -> this
    }

    /**
     * Whether an element is covered in screenshots and its own text (a field's value) left out of notes. A private
     * element's label and content description are left out too; a masked field's label (its hint) is not.
     */
    public fun hides(isTextInput: Boolean, isSecure: Boolean, maskInputs: Boolean): Boolean = when {
        this == PRIVATE || isSecure -> true
        isTextInput -> maskInputs && this != SHOWN
        else -> false
    }

    public companion object {
        /** From the marks on an element and on what it sits in, innermost first (null where there is none). */
        public fun of(marks: Sequence<Boolean?>): Privacy {
            var shown = false
            for (mark in marks) {
                if (mark == true) return PRIVATE
                if (mark == false) shown = true
            }
            return if (shown) SHOWN else DEFAULT
        }
    }
}

/**
 * Something on screen Notato can point at: a View, a composable (from its semantics), or just a spot. Providers (the
 * `notato-compose` artifact) add elements for what the View tree cannot see into.
 */
public class ScreenElement(
    /** `view`, `compose` or `area`. */
    public val kind: String,
    /** `button`, `text`, `heading`, `textbox`, `img`, `switch`, `checkbox`, `slider`, `list`, … or null. */
    public val role: String?,
    /** What a screen reader says for it: the content description, else the text. */
    public val label: String?,
    /** The text it shows. */
    public val text: String?,
    /** The view's resource id name (`sign_in`), or the composable's test tag. */
    public val identifier: String?,
    /** The view's class (`MaterialButton`) or the composable (`Text`, `Button`). */
    public val control: String,
    public val bounds: Box,
    public val isTextInput: Boolean = false,
    public val isSecure: Boolean = false,
    /** Where it is written, when known. */
    public val source: SourceLocation? = null,
    public val component: ComponentInfo? = null,
    /** What it sits in, outermost first. */
    public val ancestors: List<String>? = null,
    public val styles: Map<String, String>? = null,
    /** The screen it is on: a Fragment, an Activity, a screen composable. */
    public val screen: String? = null,
    /** The live object behind it (a View), so a pin can follow it. */
    public val ref: WeakReference<Any>? = null,
    /**
     * Private ([Privacy.PRIVATE]): marked with `Notato.mask` or `Modifier.notatoMask`, or inside something that is.
     * Covered in screenshots, and no text, label or content description of it is recorded or used in its selector.
     */
    public val isMasked: Boolean = false,
    /**
     * Marked not private ([Privacy.SHOWN]): a text field shown, and its value recorded, even when `maskInputs` is on.
     * Never set with [isMasked]; a secure field is masked regardless.
     */
    public val isUnmasked: Boolean = false,
) {
    /** What it says, for selectors and the note: the text, else the label. Never anything for a private element. */
    public val words: String? get() = if (isMasked) null else (text ?: label)?.trim()?.ifEmpty { null }

    public val privacy: Privacy get() = when {
        isMasked -> Privacy.PRIVATE
        isUnmasked -> Privacy.SHOWN
        else -> Privacy.DEFAULT
    }

    /** Whether it is covered in screenshots: private, a secure field, or a text field when [maskInputs] is on (unless [isUnmasked]). */
    public fun isCovered(maskInputs: Boolean): Boolean = privacy.hides(isTextInput, isSecure, maskInputs)

    override fun toString(): String = "$control${identifier?.let { "#$it" } ?: ""}${words?.let { " \"$it\"" } ?: ""} $bounds"
}

/**
 * Selectors for Android, written like CSS so they read at a glance and an agent can write one:
 * `LoginFragment #sign_in`, `ProductList button:text("Add to cart")`.
 *
 * - `#sign_in`: the view's resource id name, or the composable's test tag.
 * - `button`: the role, or the control (`MaterialButton`, `Text`), ignoring case (`*` for any).
 * - `:text("Add to cart")`: its text or label contains this, ignoring case.
 * - `:nth(2)`: the second match on screen, in drawing order.
 * - A leading capitalised word is the screen: a hint for people, ignored when matching.
 */
internal object Selectors {
    data class Parsed(val screen: String?, val type: String?, val id: String?, val text: String?, val nth: Int?)

    class SelectorException(message: String) : IllegalArgumentException(message)

    private fun quote(text: String) = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    private val plain = Regex("^[A-Za-z_][\\w.-]*$")

    /**
     * Whether two descriptions are of the same thing on screen. Picking and listing describe the screen separately, so
     * the element picked is an equal description, not the same object, as the one in the list.
     */
    fun same(a: ScreenElement, b: ScreenElement): Boolean = a === b ||
        (a.kind == b.kind && a.bounds == b.bounds && a.identifier == b.identifier && a.words == b.words && a.role == b.role)

    /**
     * The shortest selector that finds only this element among [all], with the screen in front when known. A private
     * element has no words, so its selector is its id, else its role and place (`text:nth(3)`), never its text.
     */
    fun make(element: ScreenElement, all: List<ScreenElement>, screen: String?): String {
        val prefix = screen?.let { "$it " } ?: ""
        val id = element.identifier
        if (!id.isNullOrEmpty() && all.none { !same(it, element) && it.identifier == id }) {
            return prefix + "#" + (if (plain.matches(id)) id else quote(id))
        }
        var base = element.role ?: element.control.lowercase()
        element.words?.let { base += ":text(${quote(it.take(60))})" }
        val parsed = runCatching { parse(base) }.getOrNull()
        val matching = parsed?.let { p -> all.filter { matches(it, p) } } ?: emptyList()
        if (matching.size > 1) {
            val index = matching.indexOfFirst { same(it, element) }
            if (index >= 0) base += ":nth(${index + 1})"
        }
        return prefix + base
    }

    /** Whether [element] is one [selector] finds, `nth` aside. */
    fun matches(element: ScreenElement, selector: Parsed): Boolean {
        selector.type?.let { type ->
            if (type != "*" && !type.equals(element.role, ignoreCase = true) && !type.equals(element.control, ignoreCase = true)) return false
        }
        if (selector.id != null && element.identifier != selector.id) return false
        if (selector.text != null) {
            val own = element.words ?: return false
            if (!own.contains(selector.text, ignoreCase = true) && !(element.label?.contains(selector.text, ignoreCase = true) ?: false)) return false
        }
        return true
    }

    /** The elements a selector finds, in drawing order (`nth` applied). */
    fun query(selector: String, elements: List<ScreenElement>): List<ScreenElement> = query(parse(selector), elements)

    /** The elements a parsed selector finds, in drawing order (`nth` applied). */
    fun query(selector: Parsed, elements: List<ScreenElement>): List<ScreenElement> {
        val found = elements.filter { matches(it, selector) }
        val nth = selector.nth ?: return found
        return if (nth <= found.size) listOf(found[nth - 1]) else emptyList()
    }

    /** Reads a selector; throws [SelectorException], saying what is wrong, when it cannot. */
    fun parse(raw: String): Parsed {
        var s = raw.trim()
        fun fail(why: String): Nothing = throw SelectorException("selector \"$raw\": $why")
        var screen: String? = null
        var type: String? = null
        var id: String? = null
        var text: String? = null
        var nth: Int? = null

        val space = s.indexOf(' ')
        if (space > 0 && s[0].isUpperCase() && s.substring(0, space).none { it in "#:\"" }) {
            screen = s.substring(0, space)
            s = s.substring(space).trimStart()
        }
        if (s.isEmpty()) fail("nothing to match after the screen")
        var i = 0
        fun ident(): String {
            val start = i
            while (i < s.length && (s[i].isLetterOrDigit() || s[i] in "_-.")) i++
            return s.substring(start, i)
        }
        fun quoted(): String {
            if (i >= s.length || (s[i] != '"' && s[i] != '\'')) return ident()
            val q = s[i++]
            val out = StringBuilder()
            while (i < s.length && s[i] != q) {
                if (s[i] == '\\' && i + 1 < s.length) i++
                out.append(s[i++])
            }
            if (i >= s.length) fail("unclosed quote")
            i++
            return out.toString()
        }
        if (s[0] == '*') {
            type = "*"
            i = 1
        } else if (s[0].isLetter()) {
            type = ident()
        }
        while (i < s.length) {
            when (s[i]) {
                '#' -> {
                    i++
                    id = quoted().ifEmpty { fail("# needs an id") }
                }
                ':' -> {
                    i++
                    val pseudo = ident()
                    if (i >= s.length || s[i] != '(') fail(":$pseudo needs (…)")
                    i++
                    val argument = quoted()
                    if (i >= s.length || s[i] != ')') fail("missing )")
                    i++
                    when (pseudo) {
                        "text", "has-text" -> text = argument
                        "nth", "nth-match" -> nth = argument.toIntOrNull()?.takeIf { it > 0 } ?: fail(":nth needs a positive number")
                        else -> fail(":$pseudo is not supported; use :text(\"…\") or :nth(n)")
                    }
                }
                else -> fail("unexpected \"${s[i]}\"")
            }
        }
        if (type == null && id == null && text == null) fail("expected a role, #id or :text(\"…\")")
        return Parsed(screen, type, id, text, nth)
    }
}
