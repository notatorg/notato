package dev.notato.android.internal

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/** What a person chose on the device, kept in SharedPreferences: each unset value falls back to the configuration. */
internal class RuntimeState(private val store: Store) {
    /** Where the choices live: SharedPreferences, or memory alone when the app asked for nothing to be remembered. */
    interface Store {
        fun get(key: String): String?
        fun set(key: String, value: String?)
    }

    class Memory : Store {
        private val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private class Preferences(private val prefs: SharedPreferences) : Store {
        override fun get(key: String): String? = prefs.getString(key, null)
        override fun set(key: String, value: String?) = prefs.edit { if (value == null) remove(key) else putString(key, value) }
    }

    constructor(context: Context, remember: Boolean) :
        this(if (remember) Preferences(context.getSharedPreferences("notato", Context.MODE_PRIVATE)) else Memory())

    private fun get(key: String): String? = store.get(key)
    private fun set(key: String, value: String?) = store.set(key, value)

    private fun bool(key: String) = get(key)?.let { it == "1" }
    private fun setBool(key: String, value: Boolean?) = set(key, value?.let { if (it) "1" else "0" })

    var enabled: Boolean?
        get() = bool("enabled")
        set(value) = setBool("enabled", value)
    var toolbarVisible: Boolean?
        get() = bool("toolbar")
        set(value) = setBool("toolbar", value)
    var screenshots: Boolean?
        get() = bool("screenshots")
        set(value) = setBool("screenshots", value)
    var pinsVisible: Boolean?
        get() = bool("pins")
        set(value) = setBool("pins", value)
    var author: String?
        get() = get("author")
        set(value) = set("author", value?.trim()?.ifEmpty { null })
    var server: String?
        get() = get("server")
        set(value) = set("server", value?.trim()?.trimEnd('/')?.ifEmpty { null })

    /** Where the toolbar was dragged to, as fractions of the window so it survives rotation. */
    var toolbarPosition: Pair<Float, Float>?
        get() = get("toolbar.position")?.split(",")?.takeIf { it.size == 2 }?.let { (x, y) ->
            val fx = x.toFloatOrNull() ?: return null
            val fy = y.toFloatOrNull() ?: return null
            fx.coerceIn(0f, 1f) to fy.coerceIn(0f, 1f)
        }
        set(value) = set("toolbar.position", value?.let { "${it.first},${it.second}" })

    /** Whether the toolbar was left folded into its round button, kept next to its place. Unset is open. */
    var toolbarCollapsed: Boolean
        get() = bool("toolbar.collapsed") ?: false
        set(value) = setBool("toolbar.collapsed", value.takeIf { it })

    fun reset() {
        for (key in listOf("enabled", "toolbar", "screenshots", "pins", "author", "server", "toolbar.position", "toolbar.collapsed")) set(key, null)
    }
}
