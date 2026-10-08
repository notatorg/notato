package dev.notato.sample

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** The release build's Feedback tab: Notato is in debug builds only (see src/debug/FeedbackScreen.kt). */
@Composable
fun FeedbackScreen() {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Feedback", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        Text("Notato is in debug builds only: this release build has none of it.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
