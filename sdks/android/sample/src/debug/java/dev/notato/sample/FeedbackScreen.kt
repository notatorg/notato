package dev.notato.sample

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.notato.android.AnnotateOptions
import dev.notato.android.Notato
import dev.notato.android.model.NoteIntent
import kotlinx.coroutines.launch

/** Notato's API at runtime: turning it on and off, the toolbar, notes made from code, and packaging. */
@Composable
fun FeedbackScreen() {
    val state by Notato.state.collectAsState()
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "Feedback",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.testTag("feedback_title").semantics { heading() },
        )
        Text("Point at anything in this app and leave a note for your coding agent.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))

        Toggle("Notato on", state.isEnabled, enabled = true) { Notato.setEnabled(it) }
        Toggle("Show the toolbar", state.isToolbarVisible, enabled = state.isEnabled) { if (it) Notato.showToolbar() else Notato.hideToolbar() }

        Text(
            "Server: ${state.connection.name.lowercase()}" + (state.connectionDetail?.let { " · $it" } ?: ""),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("connection"),
        )
        Text("${state.annotations.size} note(s) · ${state.pendingCount} not sent yet", style = MaterialTheme.typography.bodySmall)

        Button(onClick = { Notato.startAnnotating() }, enabled = state.isEnabled, modifier = Modifier.fillMaxWidth()) {
            Text("Annotate something")
        }
        OutlinedButton(
            enabled = state.isEnabled,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                scope.launch {
                    message = try {
                        val note = Notato.annotate("#feedback_title", "Made from code: this heading could say what the screen is for.", AnnotateOptions(intent = NoteIntent.CHANGE))
                        "Made a note on the heading (${note.id.takeLast(6)})"
                    } catch (error: Exception) {
                        error.message
                    }
                }
            },
        ) { Text("Annotate the heading from code") }
        OutlinedButton(
            enabled = state.isEnabled,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                scope.launch {
                    message = try {
                        "Packaged ${Notato.packageNotes(upload = false).name}"
                    } catch (error: Exception) {
                        error.message
                    }
                }
            },
        ) { Text("Package notes as a zip") }
        TextButton(onClick = { Notato.resetRuntimeState() }) { Text("Reset Notato's runtime settings") }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("message")) }

        if (state.annotations.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text("Latest notes", style = MaterialTheme.typography.titleMedium)
            for (note in state.annotations.sortedByDescending { it.createdAt }.take(8)) {
                val about = listOfNotNull(note.status.replace('_', ' '), "People only".takeIf { note.peopleOnly == true }, note.comment)
                Text(about.joinToString(" · "), maxLines = 2)
            }
        }
    }
}

@Composable
private fun Toggle(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}
