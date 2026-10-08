import SwiftUI
import Notato

@main
struct ShopSampleApp: App {
    init() {
        #if DEBUG
        // Reads the "Notato" dictionary in Info.plist, with NOTATO_* environment variables over it.
        // Leave this out of a build (it is behind DEBUG here) to ship nothing of Notato in it.
        Notato.start()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            Tab("Shop", systemImage: "bag") { NavigationStack { ProductList() } }
            Tab("Account", systemImage: "person") { NavigationStack { AccountView() } }
            Tab("Feedback", systemImage: "bubble.left.and.text.bubble.right") { NavigationStack { FeedbackView() } }
        }
    }
}
