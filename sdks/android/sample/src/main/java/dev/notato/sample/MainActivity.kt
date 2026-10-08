package dev.notato.sample

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            ShopTheme {
                SampleRoot()
            }
        }
    }
}

@Composable
fun ShopTheme(content: @Composable () -> Unit) {
    val accent = Color(0xFF2563EB)
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFF60A5FA)) else lightColorScheme(primary = accent),
        content = content,
    )
}

private enum class Tab(val glyph: String) { Shop("◆"), Account("●"), Feedback("✎") }

@Composable
private fun SampleRoot() {
    var tab by rememberSaveable { mutableStateOf(Tab.Shop) }
    var productId by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(enabled = productId != null) { productId = null }
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (item in Tab.entries) {
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { tab = item },
                        icon = { Text(item.glyph, fontSize = 18.sp) },
                        label = { Text(item.name) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.Shop -> {
                    val product = products.firstOrNull { it.id == productId }
                    if (product == null) ShopScreen(onOpen = { productId = it.id }) else ProductScreen(product, onBack = { productId = null })
                }
                Tab.Account -> AccountScreen()
                Tab.Feedback -> FeedbackScreen()
            }
        }
    }
}

@Composable
private fun AccountScreen() {
    val context = LocalContext.current
    Column(Modifier.padding(20.dp)) {
        Text("Account", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(16.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                // Personal details: covered in Notato's screenshots, and neither is in any note's text or selector.
                Column(Modifier.notatoPrivate()) {
                    Text("Ada Lovelace", style = MaterialTheme.typography.titleMedium)
                    Text("ada@example.com", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(12.dp))
                // The details screen is built with Views and a Fragment, to show Notato in both kinds of UI.
                Button(onClick = { context.startActivity(Intent(context, AccountActivity::class.java)) }) {
                    Text("Edit account details")
                }
            }
        }
    }
}
