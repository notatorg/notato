using Notato.Maui.Net;
using Notato.Maui.Runtime;
using System.Reflection;
using System.Text;

namespace Notato.Maui.Tests;

/// <summary>A phone reaching `notato dev --tunnel` through the dev tunnel the build recorded.</summary>
public class DeviceAccessTests
{
    private const string Tunnel = "https://abc123xy-4748.uks1.devtunnels.ms";
    private static readonly DeviceAccess Recorded = new(Tunnel, "pfd_device-token-0123456789", "http://localhost:4748");

    [Fact]
    public void Reads_what_the_build_recorded()
    {
        DeviceAccess? found = DeviceAccess.FromMetadata(
        [
            new AssemblyMetadataAttribute("Notato.ProjectPath", "src/App"),
            new AssemblyMetadataAttribute(DeviceAccess.TunnelKey, Tunnel + "/"),
            new AssemblyMetadataAttribute(DeviceAccess.TokenKey, "pfd_device-token-0123456789"),
            new AssemblyMetadataAttribute(DeviceAccess.LocalKey, "http://localhost:4748"),
        ]);
        Assert.Equal(Recorded, found);
        Assert.Null(DeviceAccess.FromMetadata([new AssemblyMetadataAttribute("Notato.ProjectPath", "src/App")]));
    }

    [Fact]
    public void A_phone_uses_the_tunnel_and_the_simulator_uses_localhost()
    {
        NotatoOptions options = new() { Project = "shop-app" };
        Assert.Equal(Tunnel, options.ResolveServer(Recorded, reachesLoopback: false));
        Assert.Equal("http://localhost:4748", options.ResolveServer(Recorded, reachesLoopback: true));
        // Built without a tunnel running: the local server, as before (adb reverse on Android).
        Assert.Equal("http://localhost:4748", options.ResolveServer(Recorded with { Tunnel = null }, reachesLoopback: false));
        Assert.Equal(NotatoOptions.DefaultServer, options.ResolveServer(null, reachesLoopback: false));
    }

    [Fact]
    public void A_configured_server_wins_and_test_mode_still_has_none()
    {
        Assert.Equal("https://notato.example.com", new NotatoOptions { Server = "https://notato.example.com/" }.ResolveServer(Recorded, false));
        Assert.Null(new NotatoOptions { Server = "" }.ResolveServer(Recorded, false));
        Assert.Null(new NotatoOptions { Mode = NotatoMode.Test }.ResolveServer(Recorded, false));
    }

    [Fact]
    public void The_device_token_goes_to_its_own_tunnel_only()
    {
        NotatoOptions options = new();
        Assert.Equal("pfd_device-token-0123456789", options.TokenFor(Tunnel, Recorded, reachesLoopback: false));
        Assert.Equal("pfd_device-token-0123456789", options.TokenFor(Tunnel + "/", Recorded, reachesLoopback: false));
        Assert.Null(options.TokenFor("http://localhost:4748", Recorded, reachesLoopback: false));
        Assert.Null(options.TokenFor("https://someone-else.uks1.devtunnels.ms", Recorded, reachesLoopback: false));
        // A phone with no server configured uses the tunnel: a configured token goes there, and wins.
        Assert.Equal("pft_shared", new NotatoOptions { Token = "pft_shared" }.TokenFor(Tunnel, Recorded, reachesLoopback: false));
    }

    [Fact]
    public void The_configured_token_goes_only_to_the_configured_servers_origin()
    {
        NotatoOptions options = new() { Server = "https://notato.example.com/team", Token = "pft_shared" };
        Assert.Equal("pft_shared", options.TokenFor("https://notato.example.com", null, reachesLoopback: false));
        Assert.Equal("pft_shared", options.TokenFor("https://NOTATO.example.com:443/", null, reachesLoopback: false));
        // Typed into the settings sheet: another host, another port or plain http gets nothing.
        Assert.Null(options.TokenFor("https://notato.example.com.evil.test", null, reachesLoopback: false));
        Assert.Null(options.TokenFor("https://notato.example.com:8443", null, reachesLoopback: false));
        Assert.Null(options.TokenFor("http://notato.example.com", null, reachesLoopback: false));
        Assert.Null(options.TokenFor("http://localhost:4747", null, reachesLoopback: false));
        Assert.Null(options.TokenFor(null, null, reachesLoopback: false));
        // No server configured in dev mode: the default one is the configured one.
        Assert.Equal("pft_shared", new NotatoOptions { Token = "pft_shared" }.TokenFor(NotatoOptions.DefaultServer, null, reachesLoopback: true));
        // Test mode without a server: there is no configured server for it to go to.
        Assert.Null(new NotatoOptions { Mode = NotatoMode.Test, Token = "pft_shared" }.TokenFor("https://notato.example.com", null, reachesLoopback: false));
    }

    [Fact]
    public async Task A_server_typed_into_the_settings_is_sent_no_token()
    {
        HttpRequestMessage? seen = null;
        HttpClient http = new(new Capture(r => seen = r));
        NotatoOptions options = new() { Server = "https://notato.example.com", Token = "pft_shared" };

        const string typed = "https://elsewhere.example.org";
        await new NotatoClient(http, typed, options.TokenFor(typed, null, reachesLoopback: false)).GetConfigAsync(CancellationToken.None);
        Assert.Null(seen!.Headers.Authorization);

        await new NotatoClient(http, "https://notato.example.com", options.TokenFor("https://notato.example.com", null, reachesLoopback: false)).GetConfigAsync(CancellationToken.None);
        Assert.Equal("Bearer pft_shared", seen.Headers.Authorization!.ToString());
    }

    [Fact]
    public async Task Requests_to_a_dev_tunnel_skip_its_browser_warning_page()
    {
        HttpRequestMessage? seen = null;
        HttpClient http = new(new Capture(r => seen = r));
        await new NotatoClient(http, Tunnel, "pfd_device-token-0123456789").GetConfigAsync(CancellationToken.None);
        Assert.Equal("true", seen!.Headers.GetValues("X-Tunnel-Skip-AntiPhishing-Page").Single());
        Assert.Equal("Bearer pfd_device-token-0123456789", seen.Headers.Authorization!.ToString());

        await new NotatoClient(http, "http://localhost:4748", null).GetConfigAsync(CancellationToken.None);
        Assert.False(seen.Headers.Contains("X-Tunnel-Skip-AntiPhishing-Page"));
    }

    private sealed class Capture(Action<HttpRequestMessage> onRequest) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            onRequest(request);
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"screenshots\":true}", Encoding.UTF8, "application/json"),
            });
        }
    }
}
