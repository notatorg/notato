package dev.notato.android

import androidx.core.content.FileProvider

/** Shares packaged notes (test mode) with other apps. Its own class, so it does not clash with the app's provider. */
internal class NotatoFileProvider : FileProvider()
