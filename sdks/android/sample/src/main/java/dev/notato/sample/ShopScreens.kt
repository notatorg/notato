package dev.notato.sample

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

private val Muted = Color(0xFF6B7280)
private val Stock = Color(0xFFEA580C)

@Composable
fun ShopScreen(onOpen: (Product) -> Unit) {
    LazyColumn(
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            Text("Kit for the hills", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
        }
        item { Text("${products.size} products · free delivery over £50", color = Muted) }
        item { SaleBanner() }
        items(products, key = { it.id }) { product -> ProductRow(product, onClick = { onOpen(product) }) }
    }
}

@Composable
private fun SaleBanner() {
    // Pale text on a pale background: a contrast bug to try Notato on.
    Text(
        "Autumn sale: 20% off jackets this week",
        color = Color(0xFFFCD34D),
        modifier = Modifier.fillMaxWidth().background(Color(0xFFFEF3C7), RoundedCornerShape(12.dp)).padding(14.dp),
    )
}

@Composable
private fun ProductRow(product: Product, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, Color(0x22000000), RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(14.dp),
    ) {
        Initials(product, 48)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(product.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Text(product.blurb, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(product.stock, color = Stock, fontSize = 13.sp)
        }
        Text(product.price, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
    }
}

@Composable
private fun Initials(product: Product, size: Int) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.size(size.dp).background(product.color, RoundedCornerShape((size / 4).dp)),
    ) {
        Text(product.initials, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size / 2.6).sp)
    }
}

@Composable
fun ProductScreen(product: Product, onBack: () -> Unit) {
    var size by rememberSaveable { mutableStateOf("M") }
    var added by rememberSaveable { mutableStateOf(false) }
    var guide by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        TextButton(onClick = onBack) { Text("‹ Shop") }
        Initials(product, 96)
        Spacer(Modifier.height(16.dp))
        Text(product.name, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
        Text(product.price, style = MaterialTheme.typography.titleLarge)
        Text(product.stock, color = Stock)
        Spacer(Modifier.height(12.dp))
        Text(product.blurb)
        Spacer(Modifier.height(20.dp))
        Text("Size", fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in listOf("S", "M", "L", "XL")) {
                FilterChip(selected = size == option, onClick = { size = option }, label = { Text(option) })
            }
        }
        TextButton(onClick = { guide = true }) { Text("Size guide") }
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = { added = true },
            enabled = product.inStock,
            modifier = Modifier.fillMaxWidth().testTag("add_to_basket"),
        ) {
            Text(if (added) "Added to basket" else "Add to basket")
        }
    }
    if (guide) SizeGuideDialog(onDismiss = { guide = false })
}

/** A full-screen dialog: a window of its own, which Notato's overlay moves into while it shows. */
@Composable
private fun SizeGuideDialog(onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(24.dp)) {
                Text("Size guide", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                Spacer(Modifier.height(16.dp))
                for ((label, chest) in listOf("S" to "86–91 cm", "M" to "96–101 cm", "L" to "106–111 cm", "XL" to "116–121 cm")) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Text(label, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text(chest)
                    }
                    HorizontalDivider()
                }
                Spacer(Modifier.height(24.dp))
                Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Close") }
            }
        }
    }
}
