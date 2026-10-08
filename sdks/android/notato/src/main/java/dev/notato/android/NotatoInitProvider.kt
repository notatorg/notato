package dev.notato.android

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/**
 * Starts Notato before `Application.onCreate` when the manifest has `notato.project` meta-data, so an app can take
 * Notato with no code: add it as a `debugImplementation` dependency and the meta-data. Apps that start it in code are
 * unaffected (with no `notato.project` this does nothing).
 */
internal class NotatoInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val app = context?.applicationContext as? Application ?: return false
        if (!Notato.isStarted && Notato.manifestConfig(app) != null) Notato.start(app)
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
