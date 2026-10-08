import SwiftUI

struct Product: Identifiable, Hashable {
    let id: Int
    let name: String
    let tagline: String
    let price: Decimal
    let color: Color
    let initials: String
    let stock: Int

    var priceText: String { price.formatted(.currency(code: "GBP")) }
    var stockText: String { stock == 0 ? "Out of stock" : stock < 5 ? "Only \(stock) left" : "In stock" }
}

enum Catalog {
    static let products: [Product] = [
        Product(id: 1, name: "Trail Runner", tagline: "Light shoes for long days on rough ground", price: 89, color: .blue, initials: "TR", stock: 12),
        Product(id: 2, name: "Summit Jacket", tagline: "Waterproof shell that packs into its own pocket", price: 179, color: .pink, initials: "SJ", stock: 3),
        Product(id: 3, name: "Camp Mug", tagline: "Enamel steel, holds a proper amount of tea", price: 14.5, color: .green, initials: "CM", stock: 40),
        Product(id: 4, name: "Headlamp 400", tagline: "400 lumens, red night mode, USB-C", price: 39.99, color: .orange, initials: "HL", stock: 0),
        Product(id: 5, name: "Dry Bag 20L", tagline: "Roll-top bag that keeps the rain out", price: 24, color: .purple, initials: "DB", stock: 8),
    ]
}
