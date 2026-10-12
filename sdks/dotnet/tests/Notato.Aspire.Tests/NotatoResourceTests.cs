using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;

namespace Notato.Aspire.Tests;

/// <summary>What <c>AddNotato</c> runs and what <c>WithReference</c> tells an app, as the app host would see them.</summary>
public sealed class NotatoResourceTests : IDisposable
{
    /// <summary>A repository with the app host in a folder of its own, as most are laid out.</summary>
    private readonly string _repository = Directory.CreateTempSubdirectory("notato-aspire-").FullName;

    private string AppHost => Path.Combine(_repository, "src", "Shop.AppHost");

    public NotatoResourceTests()
    {
        Directory.CreateDirectory(Path.Combine(_repository, ".git"));
        Directory.CreateDirectory(AppHost);
    }

    public void Dispose() => Directory.Delete(_repository, recursive: true);

    private IDistributedApplicationBuilder Builder(params string[] args) =>
        DistributedApplication.CreateBuilder(new DistributedApplicationOptions
        {
            Args = args,
            ProjectDirectory = AppHost,
            DisableDashboard = true,
        });

    /// <summary>
    /// Gives each of the resources' endpoints the address it would have once running, as this machine's processes see
    /// it: the variables wait for them (a Vite app's own <c>PORT</c> too).
    /// </summary>
    private static void Allocate(params IResource[] resources)
    {
        int next = 5100;
        foreach (EndpointAnnotation endpoint in resources.SelectMany(r => r.Annotations.OfType<EndpointAnnotation>()))
        {
            AllocatedEndpoint allocated = new(endpoint, "localhost", endpoint.Port ?? next++);
            endpoint.AllocatedEndpoint = allocated;
            endpoint.AllAllocatedEndpoints.AddOrUpdateAllocatedEndpoint(KnownNetworkIdentifiers.LocalhostNetwork, allocated);
        }
    }

    [Fact]
    public async Task Runs_the_matching_notato_with_npx_from_the_repository_root()
    {
        IDistributedApplicationBuilder builder = Builder();
        NotatoResource notato = builder.AddNotato().Resource;

        Assert.Equal("notato", notato.Name);
        Assert.Equal("npx", notato.Command);
        Assert.Equal(_repository, notato.WorkingDirectory);
        string[] args = await notato.GetArgumentValuesAsync();
        Assert.Equal(["--yes", $"notato@{NotatoBuilderExtensions.PackageVersion}", "start", "--attach", "--port", "4747"], args);
        Assert.Matches(@"^\d+\.\d+\.\d+", NotatoBuilderExtensions.PackageVersion);
    }

    [Fact]
    public void Listens_on_the_same_port_every_run_and_says_when_it_is_up()
    {
        NotatoResource notato = Builder().AddNotato(port: 4800).Resource;

        EndpointAnnotation endpoint = notato.Annotations.OfType<EndpointAnnotation>().Single();
        Assert.Equal(4800, endpoint.Port);
        Assert.Equal(4800, endpoint.TargetPort);
        Assert.False(endpoint.IsProxied);
        Assert.Equal("http", endpoint.UriScheme);
        Assert.Single(notato.Annotations.OfType<HealthCheckAnnotation>());
    }

    [Fact]
    public async Task Takes_a_data_folder_a_settings_file_a_tunnel_and_another_command()
    {
        IDistributedApplicationBuilder builder = Builder();
        NotatoResource notato = builder.AddNotato()
            .WithDataDirectory("../../.notato-shared")
            .WithConfigFile("~/notato.config.json")
            .WithTunnel()
            .WithNotatoCommand("bun", "/checkout/packages/cli/src/main.ts")
            .Resource;

        Assert.Equal("bun", notato.Command);
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.Equal(
            [
                "/checkout/packages/cli/src/main.ts", "start", "--attach", "--port", "4747",
                "--dir", Path.Combine(_repository, ".notato-shared"),
                "--config", Path.Combine(home, "notato.config.json"),
                "--tunnel",
            ],
            await notato.GetArgumentValuesAsync());
    }

    [Fact]
    public async Task A_vite_app_is_given_the_variables_its_page_can_read()
    {
        IDistributedApplicationBuilder builder = Builder();
        IResourceBuilder<NotatoResource> notato = builder.AddNotato();
        IResourceBuilder<IResourceWithEnvironment> web = builder.AddViteApp("web", "../web").WithReference(notato);
        Allocate(notato.Resource, web.Resource);

        Dictionary<string, string> env = await web.Resource.GetEnvironmentVariableValuesAsync();
        Assert.Equal("true", env["VITE_NOTATO"]);
        Assert.Equal("http://localhost:4747", env["VITE_NOTATO_SERVER"]);
        Assert.False(env.ContainsKey("NOTATO_ENABLED"));
        Assert.Contains(web.Resource.Annotations.OfType<ResourceRelationshipAnnotation>(), r => r.Resource == notato.Resource);
    }

    [Fact]
    public void Every_kind_of_javascript_app_is_given_vites_names()
    {
        IDistributedApplicationBuilder builder = Builder();
        Assert.Equal(("VITE_NOTATO", "VITE_NOTATO_SERVER"), NotatoBuilderExtensions.Variables(builder.AddJavaScriptApp("spa", "../spa").Resource));
        Assert.Equal(("VITE_NOTATO", "VITE_NOTATO_SERVER"), NotatoBuilderExtensions.Variables(builder.AddNodeApp("node", "../node", "server.js").Resource));
        Assert.Equal(("NOTATO_ENABLED", "NOTATO_SERVER"), NotatoBuilderExtensions.Variables(builder.AddContainer("box", "nginx").Resource));
    }

    [Fact]
    public async Task Any_other_app_is_given_the_variables_the_native_sdks_read()
    {
        IDistributedApplicationBuilder builder = Builder();
        IResourceBuilder<NotatoResource> notato = builder.AddNotato(port: 4801);
        IResourceBuilder<ExecutableResource> app = builder.AddExecutable("app", "dotnet", ".").WithReference(notato);
        Allocate(notato.Resource);

        Dictionary<string, string> env = await app.Resource.GetEnvironmentVariableValuesAsync();
        Assert.Equal("true", env["NOTATO_ENABLED"]);
        Assert.Equal("http://localhost:4801", env["NOTATO_SERVER"]);
        Assert.False(env.ContainsKey("VITE_NOTATO"));
    }

    [Fact]
    public async Task An_app_can_be_told_to_keep_it_off()
    {
        IDistributedApplicationBuilder builder = Builder();
        IResourceBuilder<NotatoResource> notato = builder.AddNotato();
        IResourceBuilder<ExecutableResource> app = builder.AddExecutable("app", "dotnet", ".").WithReference(notato, enabled: false);
        Allocate(notato.Resource);

        Assert.Equal("false", (await app.Resource.GetEnvironmentVariableValuesAsync())["NOTATO_ENABLED"]);
    }

    [Fact]
    public void Nothing_of_it_is_published()
    {
        IDistributedApplicationBuilder builder = Builder("--publisher", "manifest", "--output-path", Path.Combine(_repository, "out"));
        Assert.True(builder.ExecutionContext.IsPublishMode);
        IResourceBuilder<NotatoResource> notato = builder.AddNotato();
        IResourceBuilder<ExecutableResource> app = builder.AddExecutable("app", "dotnet", ".").WithReference(notato);

        Assert.Contains(notato.Resource.Annotations.OfType<ManifestPublishingCallbackAnnotation>(), a => a == ManifestPublishingCallbackAnnotation.Ignore);
        Assert.Empty(app.Resource.Annotations.OfType<EnvironmentCallbackAnnotation>());
    }

    [Fact]
    public void Without_a_repository_it_runs_in_the_app_hosts_folder()
    {
        string lone = Directory.CreateTempSubdirectory("notato-aspire-lone-").FullName;
        try
        {
            Assert.Null(NotatoBuilderExtensions.RepositoryRoot(lone));
            Assert.Equal(_repository, NotatoBuilderExtensions.RepositoryRoot(AppHost));
        }
        finally
        {
            Directory.Delete(lone);
        }
    }
}
