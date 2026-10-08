package dev.notato.android.internal

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Universally unique, lexicographically sortable ids: 48 bits of milliseconds and 80 random bits, in Crockford base32. */
internal object Ulid {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()

    fun make(millis: Long = System.currentTimeMillis()): String {
        val bytes = ByteArray(16)
        var ms = millis
        for (i in 5 downTo 0) {
            bytes[i] = (ms and 0xFF).toByte()
            ms = ms shr 8
        }
        val tail = ByteArray(10).also { random.nextBytes(it) }
        tail.copyInto(bytes, 6)
        var value = BigInteger(1, bytes)
        val out = CharArray(26)
        val mask = BigInteger.valueOf(31)
        for (i in 25 downTo 0) {
            out[i] = ALPHABET[value.and(mask).toInt()]
            value = value.shiftRight(5)
        }
        return String(out)
    }
}

internal object Time {
    fun iso(date: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(date)
}

internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
