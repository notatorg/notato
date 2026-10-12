using System.Reflection;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.JavaScript;

namespace Aspire.Hosting;

/// <summary>Adds Notato to a .NET Aspire app host, and turns it on in the apps that use it.</summary>
public static class NotatoBuilderExtensions
{
    /// <summary>The port Notato listens on unless told otherwise, as <c>npx notato</c> does.</summary>
    public const int DefaultPort = 4747;

    /// <summary>
    /// Runs Notato on this machine, as <c>npx notato</c> does: the board, the server the apps' notes go to, and MCP for
    /// coding agents at <c>/mcp</c>. It is the version of the <c>notato</c> npm package this package was released with,
    /// started with npx (so Node.js has to be installed), from the repository's root folder, so its data is
    /// <c>.notato</c> there as with <c>npx notato</c>. When a Notato already runs on the port (one a coding agent
    /// started, say), that one is used, and this one takes the port over if it stops.
    /// <code>
    /// var notato = builder.AddNotato();
    /// builder.AddViteApp("web", "../web").WithReference(notato);
    /// </code>
    /// The port stays the same from run to run, because coding agents are given its address once. Notato is a
    /// development tool: it is left out of what the app host publishes.
    /// </summary>
    /// <param name="builder">The app host.</param>
    /// <param name="name">The resource's name on the dashboard.</param>
    /// <param name="port">The port it listens on.</param>
    public static IResourceBuilder<NotatoResource> AddNotato(
        this IDistributedApplicationBuilder builder,
        [ResourceName] string name = "notato",
        int port = DefaultPort)
    {
        ArgumentNullException.ThrowIfNull(builder);

        string folder = RepositoryRoot(builder.AppHostDirectory) ?? builder.AppHostDirectory;
        NotatoResource resource = new(name, "npx", folder);
        NotatoLaunchAnnotation launch = new() { Prefix = ["--yes", $"notato@{PackageVersion}"] };

        return builder.AddResource(resource)
            .WithAnnotation(launch)
            .WithArgs(context =>
            {
                foreach (object argument in launch.Arguments(resource.Endpoint.Property(EndpointProperty.TargetPort)))
                {
                    context.Args.Add(argument);
                }
            })
            .WithHttpEndpoint(port: port, targetPort: port, name: NotatoResource.EndpointName, isProxied: false)
            .WithHttpHealthCheck("/health", endpointName: NotatoResource.EndpointName)
            .WithUrlForEndpoint(NotatoResource.EndpointName, url => url.DisplayText = "Board")
            .WithUrls(context =>
            {
                if (resource.Endpoint.IsAllocated)
                {
                    context.Urls.Add(new ResourceUrlAnnotation
                    {
                        Url = $"{resource.Endpoint.Url}/mcp",
                        DisplayText = "MCP for coding agents",
                        DisplayLocation = UrlDisplayLocation.DetailsOnly,
                    });
                }
            })
            .WithIconName("Comment")
            .ExcludeFromManifest();
    }

    /// <summary>
    /// Keeps Notato's notes, screenshots and dev tunnel details in <paramref name="path"/> (relative to the app host's
    /// folder; <c>~</c> is your home folder), rather than in <c>.notato</c> at the repository's root. A Notato.Maui app
    /// built with a tunnel reads <c>device.json</c> from there too, given <c>&lt;NotatoDataDirectory&gt;</c>.
    /// </summary>
    public static IResourceBuilder<NotatoResource> WithDataDirectory(this IResourceBuilder<NotatoResource> builder, string path)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        Launch(builder).DataDirectory = FullPath(builder, path);
        return builder;
    }

    /// <summary>
    /// Reads Notato's settings (screenshots, MCP, webhooks: see <c>notato config</c>) from <paramref name="path"/>
    /// (relative to the app host's folder; <c>~</c> is your home folder), rather than from <c>notato.config.json</c> at the
    /// repository's root.
    /// </summary>
    public static IResourceBuilder<NotatoResource> WithConfigFile(this IResourceBuilder<NotatoResource> builder, string path)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        Launch(builder).ConfigFile = FullPath(builder, path);
        return builder;
    }

    /// <summary>
    /// Also puts Notato behind a Microsoft dev tunnel, so a phone can reach it: anything that comes through the tunnel
    /// needs the device token that Notato writes, with the tunnel's address, to <c>device.json</c> in its data folder,
    /// where a Notato.Maui debug build picks both up. Needs the devtunnel CLI, signed in once
    /// (<c>devtunnel user login</c>).
    /// </summary>
    public static IResourceBuilder<NotatoResource> WithTunnel(this IResourceBuilder<NotatoResource> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        Launch(builder).Tunnel = true;
        return builder;
    }

    /// <summary>
    /// Runs Notato with <paramref name="command"/> and <paramref name="args"/> in place of <c>npx --yes notato@…</c>;
    /// <c>start</c> and its options follow them. For example <c>WithNotatoCommand("notato")</c> for one that is
    /// installed, <c>WithNotatoCommand("npx", "--yes", "notato@latest")</c> for another version, or
    /// <c>WithNotatoCommand("bun", "/path/to/notato/packages/cli/src/main.ts")</c> from a checkout. It runs in the
    /// repository's root folder, so a relative path is relative to that.
    /// </summary>
    public static IResourceBuilder<NotatoResource> WithNotatoCommand(
        this IResourceBuilder<NotatoResource> builder,
        string command,
        params string[] args)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentException.ThrowIfNullOrWhiteSpace(command);
        Launch(builder).Prefix = [.. args];
        return builder.WithCommand(command);
    }

    /// <summary>
    /// Turns Notato on in this app and points it at <paramref name="notato"/>. A JavaScript app (<c>AddViteApp</c>,
    /// <c>AddJavaScriptApp</c>) is given <c>VITE_NOTATO=true</c> and <c>VITE_NOTATO_SERVER</c>, which
    /// <c>&lt;Notato /&gt;</c> and <c>provideNotato</c> read in an app built with Vite (in a production build too) and
    /// which <c>@notato/vite</c> records source positions under. Anything else (a .NET MAUI app, a Swift app) is given
    /// <c>NOTATO_ENABLED=true</c> and <c>NOTATO_SERVER</c>, which the native SDKs read. With
    /// <paramref name="enabled"/> false the app is told to keep Notato off instead, in development too. Nothing is set
    /// when the app host publishes.
    /// </summary>
    /// <param name="builder">The app.</param>
    /// <param name="notato">The Notato it uses, from <see cref="AddNotato"/>.</param>
    /// <param name="enabled">Whether Notato is on in the app.</param>
    public static IResourceBuilder<TDestination> WithReference<TDestination>(
        this IResourceBuilder<TDestination> builder,
        IResourceBuilder<NotatoResource> notato,
        bool enabled = true)
        where TDestination : IResourceWithEnvironment
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(notato);
        if (builder.ApplicationBuilder.ExecutionContext.IsPublishMode)
        {
            return builder;
        }

        NotatoResource resource = notato.Resource;
        (string enabledVariable, string serverVariable) = Variables(builder.Resource);
        return builder
            .WithReferenceRelationship(resource)
            .WithEnvironment(context =>
            {
                context.EnvironmentVariables[enabledVariable] = enabled ? "true" : "false";
                context.EnvironmentVariables[serverVariable] = resource.ServerUrl;
            });
    }

    /// <summary>
    /// The variables an app reads. A Vite app's page only sees <c>VITE_</c> ones, and <c>VITE_NOTATO</c> is the switch
    /// the web SDKs, <c>@notato/vite</c> and the code <c>npx notato init</c> writes already share.
    /// </summary>
    internal static (string Enabled, string Server) Variables(IResource resource) => resource is JavaScriptAppResource
        ? ("VITE_NOTATO", "VITE_NOTATO_SERVER")
        : ("NOTATO_ENABLED", "NOTATO_SERVER");

    /// <summary>This package's version: the <c>notato</c> npm package of the same release is what it runs.</summary>
    internal static string PackageVersion { get; } =
        typeof(NotatoBuilderExtensions).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? "latest";

    /// <summary>The folder above <paramref name="folder"/>, or it, that holds a <c>.git</c> folder or file; null when none does.</summary>
    internal static string? RepositoryRoot(string folder)
    {
        for (DirectoryInfo? directory = new(folder); directory is not null; directory = directory.Parent)
        {
            string git = Path.Combine(directory.FullName, ".git");
            if (Directory.Exists(git) || File.Exists(git))
            {
                return directory.FullName;
            }
        }
        return null;
    }

    private static NotatoLaunchAnnotation Launch(IResourceBuilder<NotatoResource> builder) =>
        builder.Resource.Annotations.OfType<NotatoLaunchAnnotation>().Single();

    private static string FullPath(IResourceBuilder<NotatoResource> builder, string path)
    {
        if (path == "~" || path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
        {
            path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path.Length > 1 ? path[2..] : "");
        }
        return Path.GetFullPath(path, builder.ApplicationBuilder.AppHostDirectory);
    }
}
