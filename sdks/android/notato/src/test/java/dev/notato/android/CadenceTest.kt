package dev.notato.android

import dev.notato.android.internal.Cadence
import dev.notato.android.internal.PendingShot
import dev.notato.android.internal.Shot
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the route and the pins are worked out again while the window draws, and the picture Send waits for. */
class CadenceTest {
    /** A window drawing a frame every 16ms from [from] to [to], and asked every 250ms (the tick) what is due. */
    private fun scroll(cadence: Cadence, from: Long, to: Long, start: Long = 0): Pair<List<Long>, Long> {
        val due = mutableListOf<Long>()
        var frames = start
        var lastFrameAt = 0L
        var now = from
        while (now <= to) {
            frames += 15
            lastFrameAt = now
            if (cadence.due(frames, lastFrameAt, now)) due += now
            now += 250
        }
        return due to frames
    }

    @Test
    fun aScrollIsReadAtMostEveryTwoSecondsThenOnceWhenItStops() {
        val cadence = Cadence()
        assertTrue(cadence.due(frames = 1, lastFrameAt = 0, now = 1000)) // the first time
        val (during, frames) = scroll(cadence, from = 1250, to = 4250, start = 1)
        // Three seconds of scrolling: the screen is read two seconds in, not on every tick.
        assertEquals(listOf(3250L), during)
        assertTrue(cadence.pending(frames))
        // It stops: still a quarter of a second later, it is read once more, and that is the last.
        assertFalse(cadence.due(frames, lastFrameAt = 4250, now = 4400))
        assertTrue(cadence.due(frames, lastFrameAt = 4250, now = 4500))
        assertTrue(cadence.settled)
        assertFalse(cadence.pending(frames))
        assertFalse(cadence.due(frames, lastFrameAt = 4250, now = 9000))
    }

    @Test
    fun aScrollAfterALongStillIsNotReadAsItStarts() {
        val cadence = Cadence()
        cadence.due(frames = 1, lastFrameAt = 0, now = 1000)
        // A minute later a scroll starts: two seconds of it go by before the screen is read mid-scroll.
        val (during, _) = scroll(cadence, from = 61_000, to = 63_500, start = 1)
        assertEquals(listOf(63_000L), during)
    }

    @Test
    fun readWhileDrawingItIsReadAgainOnceStillEvenWithNoFrameSince() {
        val cadence = Cadence()
        cadence.due(frames = 1, lastFrameAt = 0, now = 1000)
        assertFalse(cadence.due(frames = 20, lastFrameAt = 1000, now = 1000))
        // Read at the slow interval just as the last frame of a scroll was drawn.
        assertTrue(cadence.due(frames = 50, lastFrameAt = 2990, now = 3000))
        assertFalse(cadence.settled)
        assertTrue(cadence.pending(50))
        assertTrue(cadence.due(frames = 50, lastFrameAt = 2990, now = 3250))
        assertFalse(cadence.pending(50))
    }

    @Test
    fun aChangeIsReadAtOnceEvenMidScroll() {
        val cadence = Cadence()
        cadence.due(frames = 1, lastFrameAt = 0, now = 1000)
        assertFalse(cadence.due(frames = 9, lastFrameAt = 1100, now = 1100))
        assertTrue(cadence.due(frames = 9, lastFrameAt = 1100, now = 1100, changed = true))
    }

    @Test
    fun aStillWindowCostsNothing() {
        val cadence = Cadence()
        cadence.due(frames = 1, lastFrameAt = 0, now = 1000)
        assertFalse(cadence.pending(1))
        assertFalse((1..100).any { cadence.due(frames = 1, lastFrameAt = 0, now = 1000L + it * 250) })
    }

    @Test
    fun sendWaitsForThePictureTakenAfterTheComposerOpened() = runBlocking {
        val pending = PendingShot()
        val sent = async(start = CoroutineStart.UNDISPATCHED) { pending.await() }
        yield()
        assertFalse(sent.isCompleted)
        val shot = Shot(null, emptyList())
        pending.complete(shot)
        assertSame(shot, sent.await())
        // One taken already (a note made from code) is there at once.
        assertSame(shot, PendingShot.of(shot).await())
    }
}
