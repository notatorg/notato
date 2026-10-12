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

@Suite("NOTATO_ENABLED and NOTATO_SERVER")
@MainActor
struct LaunchEnvironmentTests {
    @Test(arguments: ["true", "TRUE", "1", "yes", "Yes", "on", " on ", "on\n"])
    func theseSwitchNotatoOn(value: String) {
        #expect(LaunchEnvironment(["NOTATO_ENABLED": value]).enabled == true)
    }

    @Test(arguments: ["false", "False", "0", "no", "NO", "off", "\toff "])
    func theseSwitchNotatoOff(value: String) {
        #expect(LaunchEnvironment(["NOTATO_ENABLED": value]).enabled == false)
    }

    @Test(arguments: ["", "   ", "maybe", "2", "-1", "enabled", "truee", "o n"])
    func anythingElseIsAsIfItWereNotSet(value: String) {
        #expect(LaunchEnvironment(["NOTATO_ENABLED": value]).enabled == nil)
        var off = NotatoConfiguration(project: "shop-ios")
        off.enabled = false
        #expect(LaunchEnvironment(["NOTATO_ENABLED": value]).applied(to: off).enabled == false)
        #expect(NotatoConfiguration.from(["Project": "shop-ios", "Enabled": false], environment: ["NOTATO_ENABLED": value])?.enabled == false,
                "it does not clear Enabled in Info.plist either")
    }

    @Test func aBlankServerIsAsIfItWereNotSet() {
        #expect(LaunchEnvironment([:]) == LaunchEnvironment(["NOTATO_SERVER": ""]))
        #expect(LaunchEnvironment(["NOTATO_SERVER": "  \n"]).server == nil)
        #expect(LaunchEnvironment(["NOTATO_SERVER": " http://localhost:4791 "]).server == URL(string: "http://localhost:4791"))
        // An empty Server in Info.plist is "no server"; an empty NOTATO_SERVER leaves it, or any other, as it is.
        let plist = NotatoConfiguration.from(["Project": "shop-ios", "Server": "https://notato.example"], environment: ["NOTATO_SERVER": ""])
        #expect(plist?.resolvedServer == URL(string: "https://notato.example"))
        #expect(NotatoConfiguration.from(["Project": "shop-ios", "Server": ""], environment: ["NOTATO_SERVER": " "])?.resolvedServer == nil)
        #expect(Notato(configuration: NotatoConfiguration(project: "shop-ios"), environment: ["NOTATO_SERVER": ""]).server == NotatoConfiguration.defaultServer)
    }

    @Test func theEnvironmentWinsOverAConfigurationMadeInCode() {
        var configuration = NotatoConfiguration(project: "shop-ios", server: URL(string: "https://notato.example"))
        configuration.enabled = false
        let notato = Notato(configuration: configuration, environment: ["NOTATO_ENABLED": "on", "NOTATO_SERVER": "http://localhost:4791"])
        #expect(notato.configuration?.enabled == true)
        #expect(notato.server == URL(string: "http://localhost:4791"))
        #expect(notato.enabledAtStart)

        var noServer = NotatoConfiguration(project: "shop-ios", mode: .test)
        noServer.noServer = true
        #expect(Notato(configuration: noServer, environment: ["NOTATO_SERVER": "http://localhost:4791"]).server == URL(string: "http://localhost:4791"),
                "a server given for the launch wins over none")
        #expect(Notato(configuration: configuration, environment: ["NOTATO_ENABLED": "off"]).enabledAtStart == false)
        #expect(Notato(configuration: configuration).enabledAtStart == false, "unset, the configuration decides")
    }

    @Test func notatoEnabledWinsOverTheOnOrOffRememberedFromAnEarlierLaunch() {
        let configuration = NotatoConfiguration(project: "shop-ios")
        let on = Notato(configuration: configuration, environment: ["NOTATO_ENABLED": "true"])
        on.state.enabled = false
        #expect(on.enabledAtStart)
        let off = Notato(configuration: configuration, environment: ["NOTATO_ENABLED": "false"])
        off.state.enabled = true
        #expect(!off.enabledAtStart)

        // Unset, or not a word it reads: what was remembered decides, as before.
        for environment in [[:], ["NOTATO_ENABLED": "maybe"]] {
            let notato = Notato(configuration: configuration, environment: environment)
            notato.state.enabled = false
            #expect(!notato.enabledAtStart, "\(environment)")
        }

        // Switched off during the launch: remembered as before, and the next launch with the variable is on again.
        on.disable()
        #expect(on.state.enabled == false)
        #expect(on.enabledAtStart)

        // Reset: back to the variable when it is set, else to the configuration.
        on.state.reset()
        #expect(on.enabledAtStart)
        let unset = Notato(configuration: configuration, environment: [:])
        unset.state.enabled = false
        unset.state.reset()
        #expect(unset.enabledAtStart == configuration.enabled)
    }

    @Test func aServerFromTheEnvironmentIsTheConfiguredOneForTheToken() {
        var configuration = NotatoConfiguration(project: "shop-ios", server: URL(string: "https://notato.example"))
        configuration.token = "notato_secret"
        let notato = Notato(configuration: configuration, environment: ["NOTATO_SERVER": "https://shared.notato.example"])
        #expect(notato.client(for: URL(string: "https://shared.notato.example")!).token == "notato_secret")
        #expect(notato.client(for: URL(string: "https://notato.example")!).token == nil, "only to the one server, the launch's")
        #expect(notato.client(for: URL(string: "http://typed.example:4747")!).token == nil, "a server typed into Settings gets none")
    }
}
