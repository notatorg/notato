package dev.notato.android.compose

import org.junit.Assert.assertEquals
import org.junit.Test

class PackageHashTest {
    @Test
    fun hashesPackagesAsTheComposeCompilerDoes() {
        // Values read from Compose's source information on a device (Compose 1.10, Kotlin 2.2).
        assertEquals(1842882507, NotatoCompose.packageHash("androidx.compose.material3"))
        assertEquals(1137893036, NotatoCompose.packageHash("androidx.compose.ui.platform"))
        assertEquals(245627794, NotatoCompose.packageHash("androidx.compose.foundation.lazy"))
        // The sample's package, worked out the same way (not yet read from a device).
        assertEquals(529027530, NotatoCompose.packageHash("dev.notato.sample"))
    }
}
