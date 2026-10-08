package dev.notato.android.overlay

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser
import androidx.core.graphics.withTranslation

/**
 * The toolbar's and sheets' small icons: SVG path data in a 24 box, stroked round, as in the design. The dots (the
 * menu's three, the grip's six) are filled circles.
 */
internal enum class Icon(private val data: String? = null) {
    CROSSHAIR("M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 1.5V6M12 18v4.5M1.5 12H6M18 12h4.5"),
    MORE,
    GRIP,
    CLOSE("M6 6l12 12M18 6 6 18"),
    UP("M12 19V5M5 12l7-7 7 7"),
    EYE("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"),
    EYE_OFF("M2 2l20 20M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 1 0 4.2 4.2"),
    LIST("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"),
    PACKAGE("M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"),
    TRASH("M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"),
    SLIDERS("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"),
    MINIMIZE("M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"),
    POWER("M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"),
    CHEVRON_LEFT("M15 6l-6 6 6 6"),
    CHEVRON_RIGHT("M9 6l6 6-6 6"),

    /** People only, and asides: kept between people. */
    USERS("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"),

    /** Settings' Screenshots. */
    CAMERA("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3zM9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0"),
    ;

    /** Parsed once, the first time it is drawn. */
    val path: Path? by lazy { data?.let { PathParser.createPathFromPathData(it) } }
}

/** Draws an [Icon] in [color], [strokeWidth] in the icon's 24 box. */
internal class IconDrawable(private val shape: Icon, color: Int, private val strokeWidth: Float = 2f) : Drawable() {
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val s = minOf(b.width(), b.height()) / 24f
        stroke.strokeWidth = strokeWidth
        canvas.withTranslation(b.left + (b.width() - 24 * s) / 2, b.top + (b.height() - 24 * s) / 2) {
            scale(s, s)
            when (shape) {
                Icon.MORE -> for (x in listOf(5f, 12f, 19f)) drawCircle(x, 12f, 1.8f, fill)
                Icon.GRIP -> for (y in listOf(6f, 12f, 18f)) {
                    drawCircle(9f, y, 1.6f, fill)
                    drawCircle(15f, y, 1.6f, fill)
                }
                else -> shape.path?.let { drawPath(it, stroke) }
            }
        }
    }

    override fun setAlpha(alpha: Int) {
        stroke.alpha = alpha
        fill.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        stroke.colorFilter = colorFilter
        fill.colorFilter = colorFilter
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
