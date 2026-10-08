package dev.notato.sample

import androidx.compose.ui.graphics.Color

data class Product(
    val id: String,
    val name: String,
    val blurb: String,
    val price: String,
    val stock: String,
    val color: Color,
) {
    val inStock: Boolean get() = stock != "Out of stock"
    val initials: String get() = name.split(" ").take(2).joinToString("") { it.take(1) }.uppercase()
}

val products = listOf(
    Product("trail-runner", "Trail Runner", "Light shoes for long days on rough ground, with a rock plate.", "£89.00", "In stock", Color(0xFF2563EB)),
    Product("summit-jacket", "Summit Jacket", "Waterproof shell that packs into its own pocket.", "£179.00", "Only 3 left", Color(0xFFDB2777)),
    Product("camp-mug", "Camp Mug", "Enamel steel, holds a proper amount of tea.", "£14.50", "In stock", Color(0xFF16A34A)),
    Product("headlamp", "Headlamp 400", "400 lumens, red night mode, USB-C charging.", "£39.99", "Out of stock", Color(0xFFD97706)),
    Product("dry-bag", "Dry Bag 20L", "Roll-top bag that keeps the rain out of your spare layers.", "£24.00", "In stock", Color(0xFF7C3AED)),
    Product("wool-socks", "Wool Socks", "Merino blend, cushioned where it counts.", "£12.00", "In stock", Color(0xFF0D9488)),
)
