package dev.notato.sample

import android.view.View
import androidx.compose.ui.Modifier

// Release builds have no Notato (it is a debugImplementation dependency): the same names as src/debug, doing nothing.

fun Modifier.notatoPrivate(): Modifier = this

@Suppress("UNUSED_PARAMETER")
fun notatoPrivate(view: View) = Unit
