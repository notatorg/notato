package dev.notato.android.internal

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.sqrt

/**
 * Tells when the device is shaken: a jolt of more than [THRESHOLD_G] times gravity, at most once a second. It listens
 * only between [start] and [stop]; the controller listens while Notato is on and the app is in the foreground.
 */
internal class ShakeDetector(private val context: Context, private val onShake: () -> Unit) : SensorEventListener {
    private var sensors: SensorManager? = null
    private var lastShake = 0L

    /** Listening now: [start] was called, and the device has an accelerometer. */
    val isListening: Boolean get() = sensors != null

    fun start() {
        if (sensors != null) return
        val manager = context.getSystemService(SensorManager::class.java) ?: return
        val accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        manager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI)
        sensors = manager
    }

    fun stop() {
        sensors?.unregisterListener(this)
        sensors = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        val (x, y, z) = event.values
        val force = sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH
        val now = SystemClock.uptimeMillis()
        if (force > THRESHOLD_G && now - lastShake > MIN_GAP_MS) {
            lastShake = now
            onShake()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        /** How hard a shake is, in multiples of gravity: a phone picked up or put down stays well under it. */
        const val THRESHOLD_G = 2.7f

        /** One shake is several jolts: those within this long of the first are the same shake. */
        const val MIN_GAP_MS = 1000L
    }
}
