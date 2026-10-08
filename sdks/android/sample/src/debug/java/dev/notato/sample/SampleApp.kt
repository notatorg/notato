package dev.notato.sample

import android.app.Application
import dev.notato.android.Notato
import dev.notato.android.NotatoConfig
import dev.notato.android.NotatoMode

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Notes go to `notato dev` on the computer: `adb reverse tcp:4747 tcp:4747` makes it localhost on the device.
        // `adb shell setprop debug.notato.server http://localhost:4790` points a build elsewhere without rebuilding it.
        Notato.start(
            this,
            NotatoConfig(
                project = "android-sample",
                mode = NotatoMode.DEV,
                appName = "Notato Android sample",
            ),
        )
    }
}
