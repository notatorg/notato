using Aspire.Hosting.ApplicationModel;

namespace Aspire.Hosting;

/// <summary>How <c>notato start</c> is run: what comes before it on the command line, and its options.</summary>
internal sealed class NotatoLaunchAnnotation : IResourceAnnotation
{
    /// <summary>The arguments before <c>start</c>: npx's, with the version to run, or those of a command given instead.</summary>
    public List<string> Prefix { get; set; } = [];

    /// <summary><c>--dir</c>: where the notes and screenshots are kept. Notato's own default is <c>.notato</c> where it runs.</summary>
    public string? DataDirectory { get; set; }

    /// <summary><c>--config</c>: the settings file. Notato's own default is <c>notato.config.json</c> where it runs.</summary>
    public string? ConfigFile { get; set; }

    /// <summary><c>--tunnel</c>: a Microsoft dev tunnel in front of it, for phones.</summary>
    public bool Tunnel { get; set; }

    /// <summary>The whole command line after the command, with <paramref name="port"/> for <c>--port</c>.</summary>
    public IEnumerable<object> Arguments(object port)
    {
        foreach (string argument in Prefix)
        {
            yield return argument;
        }

        // --attach: a Notato already on the port (one an agent started, another app host's) is used rather than
        // refused, and this one takes over the port if that one stops.
        yield return "start";
        yield return "--attach";
        yield return "--port";
        yield return port;
        if (DataDirectory is not null)
        {
            yield return "--dir";
            yield return DataDirectory;
        }

        if (ConfigFile is not null)
        {
            yield return "--config";
            yield return ConfigFile;
        }

        if (Tunnel)
        {
            yield return "--tunnel";
        }
    }
}
