package dev.notato.android.internal

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import androidx.core.graphics.createBitmap
import androidx.core.graphics.toColorInt
import dev.notato.android.inspect.Box
import dev.notato.android.model.AssetRef
import dev.notato.android.model.Screenshots
import dev.notato.android.overlay.Ui
import java.io.ByteArrayOutputStream

/** The two pictures a note carries: the window with the target outlined, and a crop around it, as PNG bytes by asset id. */
internal class ComposedScreenshots(val refs: Screenshots, val assets: Map<String, ByteArray>)

/** Draws the outline, the pin number and the masks onto a captured window, and cuts the crop. */
internal object ScreenshotComposer {
    private val outline = "#ef4444".toColorInt()
    private val mask = "#9ca3af".toColorInt()
    private const val CROP_PADDING_DP = 24f

    /** [targets] and [masks] are in window pixels, the capture's own space. */
    fun compose(screen: CapturedScreen, targets: List<Box>, pin: Int?, masks: List<Box>, maxScale: Double): ComposedScreenshots {
        val source = screen.bitmap
        // Stored at no more than maxScale pixels per dp: a 3.5x phone does not need a 3.5x picture to be read.
        val factor = minOf(1.0, maxScale / screen.density).toFloat()
        val width = (source.width * factor).toInt().coerceAtLeast(1)
        val height = (source.height * factor).toInt().coerceAtLeast(1)
        val dp = screen.density * factor

        fun RectF.scaled() = RectF(left * factor, top * factor, right * factor, bottom * factor)
        fun Box.rect() = RectF(left, top, right, bottom).scaled()
        val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = outline
            style = Paint.Style.STROKE
            strokeWidth = 2f * dp
        }
        val maskPaint = Paint().apply { color = mask }

        // The window with the masks and the outline: the crop is cut from it before the pin is drawn on, so one
        // picture of the window's size is made, not two.
        val full = createBitmap(width, height)
        val canvas = Canvas(full).apply {
            drawBitmap(source, null, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG))
            for (m in masks) drawRect(m.rect(), maskPaint)
            for (t in targets) drawRect(t.rect().apply { inset(dp, dp) }, strokePaint)
        }
        var crop: Bitmap? = null
        if (targets.isNotEmpty()) {
            val union = targets.drop(1).fold(targets.first()) { acc, b -> acc.union(b) }.rect()
            val pad = CROP_PADDING_DP * dp
            val area = Rect(
                (union.left - pad).toInt().coerceAtLeast(0), (union.top - pad).toInt().coerceAtLeast(0),
                (union.right + pad).toInt().coerceAtMost(width), (union.bottom + pad).toInt().coerceAtMost(height),
            )
            // A copy of that part (the picture is mutable, so never the picture itself): the pin drawn next is not in it.
            if (area.width() >= 4 && area.height() >= 4) crop = Bitmap.createBitmap(full, area.left, area.top, area.width(), area.height())
        }
        if (pin != null && targets.isNotEmpty()) drawPin(canvas, targets.first().rect(), pin, dp)
        val fullBytes = png(full)
        full.recycle()
        var refs = Screenshots(AssetRef(sha256(fullBytes), "image/png", width, height))
        val assets = linkedMapOf(refs.full.id to fullBytes)
        if (crop != null) {
            val cropBytes = png(crop)
            refs = refs.copy(crop = AssetRef(sha256(cropBytes), "image/png", crop.width, crop.height))
            assets[refs.crop!!.id] = cropBytes
            crop.recycle()
        }
        return ComposedScreenshots(refs, assets)
    }

    private fun drawPin(canvas: Canvas, target: RectF, number: Int, dp: Float) {
        val radius = 12 * dp
        val cx = target.right - 2 * dp
        val cy = maxOf(radius, target.top)
        // An open pin's colour, as the overlay and the board draw it.
        canvas.drawCircle(cx, cy, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Ui.ACCENT })
        canvas.drawCircle(cx, cy, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = 2 * dp
        })
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 12 * dp
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
        }
        canvas.drawText(number.toString(), cx, cy - (text.descent() + text.ascent()) / 2, text)
    }

    private fun png(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
}
