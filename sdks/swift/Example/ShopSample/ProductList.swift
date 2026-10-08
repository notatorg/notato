import SwiftUI
import Notato

struct ProductList: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Kit for the hills").font(.largeTitle.bold())
                Text("\(Catalog.products.count) products · free delivery over £50").foregroundStyle(.secondary)
                Text("Autumn sale: 20% off jackets this week")
                    .font(.footnote)
                    // Pale on pale: something to annotate.
                    .foregroundStyle(Color(red: 0.99, green: 0.9, blue: 0.54))
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(red: 1, green: 0.95, blue: 0.78), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("PromoBanner")
                    .notato("PromoBanner")
                ForEach(Catalog.products) { product in
                    NavigationLink(value: product) { ProductCard(product: product) }
                        .buttonStyle(.plain)
                }
            }
            .padding()
        }
        .navigationTitle("Shop")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Product.self) { ProductDetail(product: $0) }
        .notatoScreen()
    }
}

struct ProductCard: View {
    let product: Product

    var body: some View {
        HStack(spacing: 12) {
            Text(product.initials)
                .font(.title3.bold()).foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(product.color, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(product.name).font(.headline)
                Text(product.tagline).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Text(product.stockText).font(.caption).foregroundStyle(.orange)
            }
            Spacer()
            Text(product.priceText).font(.headline)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).stroke(Color.secondary.opacity(0.3)))
        .notato("ProductCard")
    }
}
