// swift-tools-version: 6.0
// The Swift SDK lives in sdks/swift. This manifest is at the repository root because SwiftPM only finds a package
// there: apps add https://github.com/notatorg/notato and get the `Notato` library, at the version of the release tag.
import PackageDescription

let package = Package(
    name: "Notato",
    // macOS is listed only so the model, client and selectors can be tested with `swift test` on a Mac;
    // the overlay is UIKit and SwiftUI on iOS and Mac Catalyst.
    platforms: [.iOS(.v17), .macCatalyst(.v17), .macOS(.v14)],
    products: [
        .library(name: "Notato", targets: ["Notato"]),
    ],
    targets: [
        // The potato on the folded toolbar and in the menu, at 2x and 3x (`sips -Z` from the repository's assets/notato.png).
        .target(name: "Notato", path: "sdks/swift/Sources/Notato", resources: [.process("Resources")]),
        .testTarget(name: "NotatoTests", dependencies: ["Notato"], path: "sdks/swift/Tests/NotatoTests"),
    ]
)
