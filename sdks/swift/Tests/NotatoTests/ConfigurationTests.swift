import Foundation
import Testing
@testable import Notato

@Suite("Configuration")
struct ConfigurationTests {
    @Test func configurationReadsLooseValuesAndTheEnvironmentWins() {
        let configuration = NotatoConfiguration.from(
            ["Project": "shop-ios", "Mode": "Agent", "Server": "https://notato.example.com", "Enabled": false, "ToolbarPosition": "topLeading"],
            environment: ["NOTATO_SERVER": "http://localhost:4790", "NOTATO_MASK_INPUTS": "false"])
        #expect(configuration?.project == "shop-ios")
        #expect(configuration?.mode == .agent)
        #expect(configuration?.resolvedServer?.absoluteString == "http://localhost:4790")
        #expect(configuration?.enabled == false)
        #expect(configuration?.toolbarPosition == .topLeading)
        #expect(configuration?.resolvedMaskInputs == false)
        #expect(NotatoConfiguration.from(["Mode": "dev"]) == nil, "no project, no configuration")
    }

    @Test func modesDefaultTheServerAndMasking() {
        #expect(NotatoConfiguration(project: "a").resolvedServer == NotatoConfiguration.defaultServer)
        #expect(NotatoConfiguration(project: "a", mode: .test).resolvedServer == nil)
        #expect(NotatoConfiguration(project: "a", mode: .test).resolvedMaskInputs)
        #expect(NotatoConfiguration(project: "has spaces").problem != nil)
        var noServer = NotatoConfiguration(project: "a")
        noServer.noServer = true
        #expect(noServer.resolvedServer == nil)
    }

    @Test func projectIdsAreCheckedAsTheServerChecksThem() {
        for bad in [".", "..", "...", "café", "a/b", "has spaces", String(repeating: "a", count: 129)] {
            #expect(NotatoConfiguration(project: bad).problem != nil, "\(bad)")
        }
        for good in ["shop-ios", "a.b", "..a", "team@shop_2"] {
            #expect(NotatoConfiguration(project: good).problem == nil, "\(good)")
        }
    }

    @Test(arguments: ["inf", "-inf", "nan", "1e300", "-5", "20"])
    func aLogLimitThatIsNotANumberOfLinesDoesNotCrash(value: String) {
        let configuration = NotatoConfiguration.from(["Project": "a"], environment: ["NOTATO_LOG_LIMIT": value])
        let limit = configuration?.logLimit ?? -1
        #expect((0...10_000).contains(limit))
        if value == "20" { #expect(limit == 20) }
        if value == "inf" || value == "nan" { #expect(limit == 50, "left at the default") }
    }
}
