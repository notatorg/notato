import Foundation
import Testing
@testable import Notato

@Suite("Where an element is written")
struct SourcePathTests {
    @Test func sourcePathsAreGivenFromTheRepositoryRoot() {
        #expect(SourcePaths.relative("/work/repo/app/Views/List.swift", root: "/work/repo") == "app/Views/List.swift")
        let here = #filePath
        #expect(SourcePaths.relative(here, root: nil) == "sdks/swift/Tests/NotatoTests/SourcePathTests.swift")
    }
}
