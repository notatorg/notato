import SwiftUI
import Notato

struct ProductDetail: View {
    let product: Product
    @State private var quantity = 1
    @State private var checkingOut = false
    @State private var added = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                RoundedRectangle(cornerRadius: 18).fill(product.color.gradient).frame(height: 180)
                    .overlay(Text(product.initials).font(.system(size: 64, weight: .bold)).foregroundStyle(.white))
                Text(product.name).font(.title.bold()).accessibilityAddTraits(.isHeader)
                Text(product.tagline)
                HStack {
                    Text(product.priceText).font(.title2.bold())
                    Text(product.stockText).font(.footnote).foregroundStyle(.orange)
                }
                Stepper("Quantity: \(quantity)", value: $quantity, in: 1...9)
                Button("Add to cart") { added = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(product.stock == 0)
                    .accessibilityIdentifier("AddToCart")
                Button("Checkout") { checkingOut = true }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("Checkout")
            }
            .padding()
        }
        .navigationTitle(product.name)
        .alert("Added", isPresented: $added) { Button("OK") {} } message: { Text("\(quantity) in your cart.") }
        // A sheet, to show that Notato stays on top of one.
        .sheet(isPresented: $checkingOut) { Checkout() }
        .notatoScreen()
    }
}

struct Checkout: View {
    @Environment(\.dismiss) private var dismiss
    @State private var card = ""
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Card") {
                    // Private in every mode: covered in screenshots, and the number is never in a note.
                    TextField("1234 5678 9012 3456", text: $card).keyboardType(.numberPad).accessibilityIdentifier("CardNumber")
                        .notatoMask()
                }
                Section("Delivery note") {
                    // Not private: shown and recorded even when inputs are masked (test and agent mode).
                    TextField("Leave it with a neighbour", text: $note, axis: .vertical).lineLimit(2...4)
                        .notatoMask(false)
                }
                Section {
                    Button("Pay now") {}.accessibilityIdentifier("PayButton")
                }
            }
            .navigationTitle("Checkout")
            .toolbar { Button("Close") { dismiss() } }
        }
        .notatoScreen()
    }
}
