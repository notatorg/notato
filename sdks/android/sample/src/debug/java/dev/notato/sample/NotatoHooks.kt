package dev.notato.sample

import android.view.View
import androidx.compose.ui.Modifier
import dev.notato.android.Notato
import dev.notato.android.compose.notatoMask

// What the app's own code asks of Notato. Notato is in debug builds only (debugImplementation), so these are here, in
// src/debug; src/release has the same names doing nothing, and the release build has no Notato at all.

/** Personal details: covered in Notato's screenshots, and none of their text is in any note. */
fun Modifier.notatoPrivate(): Modifier = notatoMask()

/** The same for a View. */
fun notatoPrivate(view: View) = Notato.mask(view)
