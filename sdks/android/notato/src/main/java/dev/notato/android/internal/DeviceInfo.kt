package dev.notato.android.internal

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import dev.notato.android.inspect.ScreenElement
import kotlinx.serialization.Serializable
import java.util.Locale

/** A note's `context.android`: the screen it was made on, and the device. */
@Serializable
internal data class AndroidContext(
    val screen: String? = null,
    val components: List<String>? = null,
    val activity: String? = null,
    val composable: String? = null,
    val device: String,
    val android: String,
    val sdk: Int,
    val emulator: Boolean,
    val orientation: String,
    val nightMode: Boolean,
    val fontScale: Float,
    val density: Float,
    val locale: String,
    val packageName: String,
)

/** The app and the device, as notes describe them. */
internal object DeviceInfo {
    /** Whether this is an emulator, as its build fingerprint, model or hardware says. */
    val isEmulator: Boolean by lazy {
        Build.FINGERPRINT.contains("generic") || Build.FINGERPRINT.contains("emulator") || Build.MODEL.contains("sdk_gphone") ||
            Build.HARDWARE.contains("ranchu")
    }

    /** The app's name as the launcher shows it. */
    fun appLabel(context: Context): String = context.applicationInfo.loadLabel(context.packageManager).toString()

    /** The app's version name and code, `1.4 (27)`; null when it cannot be read. */
    fun appVersion(context: Context): String? = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        "${info.versionName} ($code)"
    }.getOrNull()

    /** A note's `environment.userAgent`: the app, the Android version and the device. */
    fun userAgent(appName: String, appVersion: String?): String =
        "$appName/${appVersion ?: ""} (Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL}${if (isEmulator) "; emulator" else ""}) Android View"

    /** What a note made on [element] in [activity] says about where it was made. */
    fun context(activity: Activity, element: ScreenElement): AndroidContext {
        val configuration = activity.resources.configuration
        return AndroidContext(
            screen = element.screen,
            components = element.component?.path,
            activity = activity.javaClass.name,
            composable = element.component?.name?.takeIf { element.kind == "compose" },
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
            android = Build.VERSION.RELEASE,
            sdk = Build.VERSION.SDK_INT,
            emulator = isEmulator,
            orientation = if (configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait",
            nightMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES,
            fontScale = configuration.fontScale,
            density = activity.resources.displayMetrics.density,
            locale = Locale.getDefault().toLanguageTag(),
            packageName = activity.packageName,
        )
    }
}
