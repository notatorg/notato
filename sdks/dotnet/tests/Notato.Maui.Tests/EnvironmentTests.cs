using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Notato.Maui.Runtime;

namespace Notato.Maui.Tests;

/// <summary>NOTATO_ENABLED and NOTATO_SERVER, as Aspire or a launch profile sets them.</summary>
public class EnvironmentTests
{
    private const string Tunnel = "https://abc123xy-4747.uks1.devtunnels.ms";
    private static readonly DeviceAccess Recorded = new(Tunnel, "notato_device_device-token-0123456789", "http://localhost:4747");

    [Theory]
    [InlineData("true", true)]
    [InlineData("1", true)]
    [InlineData("yes", true)]
    [InlineData(" On ", true)]
    [InlineData("TRUE", true)]
    [InlineData("false", false)]
    [InlineData("0", false)]
    [InlineData("no", false)]
    [InlineData("OFF", false)]
    [InlineData("", null)]
    [InlineData("maybe", null)]
    [InlineData(null, null)]
    public void The_switch_reads_on_and_off_and_nothing_else(string? value, bool? expected) =>
        Assert.Equal(expected, EnvironmentSettings.ParseSwitch(value));

    [Fact]
    public void The_variables_win_over_the_options()
    {
        NotatoOptions options = new() { Project = "shop-app", Enabled = true, Server = "https://notato.example.com" };
        EnvironmentSettings.Apply(options, Read(new() { ["NOTATO_ENABLED"] = "false", ["NOTATO_SERVER"] = " http://localhost:4800/ " }));
        Assert.False(options.Enabled);
        Assert.True(options.EnabledByEnvironment);
        Assert.Equal("http://localhost:4800", options.ResolveServer(null, reachesLoopback: true));
    }

    [Fact]
    public void Unset_empty_or_unreadable_variables_leave_the_options_alone()
    {
        NotatoOptions options = new() { Project = "shop-app", Enabled = false, Server = "https://notato.example.com" };
        EnvironmentSettings.Apply(options, Read(new() { ["NOTATO_ENABLED"] = "perhaps", ["NOTATO_SERVER"] = "  " }));
        Assert.False(options.Enabled);
        Assert.False(options.EnabledByEnvironment);
        Assert.Equal("https://notato.example.com", options.Server);

        EnvironmentSettings.Apply(options, Read([]));
        Assert.Equal("https://notato.example.com", options.Server);
    }

    [Fact]
    public void A_localhost_server_from_a_device_that_cannot_reach_it_is_the_tunnel_the_build_recorded_for_it()
    {
        NotatoOptions options = new() { Project = "shop-app", Server = "http://localhost:4747" };
        Assert.Equal(Tunnel, options.ResolveServer(Recorded, reachesLoopback: false));
        Assert.Equal("http://localhost:4747", options.ResolveServer(Recorded, reachesLoopback: true));
        // The tunnel goes to that one server only: another port, or no tunnel recorded, is left as it was given.
        Assert.Equal("http://localhost:4800", new NotatoOptions { Server = "http://localhost:4800" }.ResolveServer(Recorded, reachesLoopback: false));
        Assert.Equal("http://localhost:4747", options.ResolveServer(Recorded with { Tunnel = null }, reachesLoopback: false));
        // And its device token goes with it.
        Assert.Equal("notato_device_device-token-0123456789", options.TokenFor(Tunnel, Recorded, reachesLoopback: false));
    }

    [Fact]
    public void The_environment_wins_over_the_choice_remembered_on_the_device()
    {
        NotatoOptions options = Options(byEnvironment: true);
        ChangingOptions monitor = new(options);
        NotatoController controller = new(monitor, NullLogger<NotatoController>.Instance);
        controller.Start();
        Assert.True(controller.IsEnabled);

        // Switched off by hand, it stays off for the session…
        controller.Disable();
        Assert.False(controller.IsEnabled);

        // …and when the options are read again (as at the next launch), the environment decides again.
        monitor.Change(options);
        Assert.True(controller.IsEnabled);
    }

    [Fact]
    public void Without_the_environment_the_choice_remembered_on_the_device_wins()
    {
        NotatoOptions options = Options(byEnvironment: false);
        ChangingOptions monitor = new(options);
        NotatoController controller = new(monitor, NullLogger<NotatoController>.Instance);
        controller.Start();
        controller.Disable();

        monitor.Change(options);
        Assert.False(controller.IsEnabled);
    }

    private static Func<string, string?> Read(Dictionary<string, string?> variables) => name => variables.GetValueOrDefault(name);

    private static NotatoOptions Options(bool byEnvironment) => new()
    {
        Project = "env-test",
        Server = "",
        Enabled = true,
        EnabledByEnvironment = byEnvironment,
        RememberRuntimeState = false,
        CaptureLogs = false,
        ShakeToToggle = false,
    };

    /// <summary>Options that can be changed under the controller, as a reloaded configuration would.</summary>
    private sealed class ChangingOptions(NotatoOptions value) : IOptionsMonitor<NotatoOptions>
    {
        private readonly List<Action<NotatoOptions, string?>> _listeners = [];

        public NotatoOptions CurrentValue { get; private set; } = value;

        public NotatoOptions Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<NotatoOptions, string?> listener)
        {
            _listeners.Add(listener);
            return null;
        }

        public void Change(NotatoOptions options)
        {
            CurrentValue = options;
            foreach (Action<NotatoOptions, string?> listener in _listeners)
            {
                listener(options, null);
            }
        }
    }
}
