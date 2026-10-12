namespace Notato.Maui.Runtime;

/// <summary>
/// What whoever launched the app says in environment variables: .NET Aspire, an IDE's launch profile, or
/// <c>SIMCTL_CHILD_NOTATO_ENABLED=false xcrun simctl launch …</c>. They are applied after the configuration and the
/// code in <c>MauiProgram</c>, so they win for this launch.
/// </summary>
internal static class EnvironmentSettings
{
    /// <summary>
    /// <c>true</c>, <c>1</c>, <c>yes</c> or <c>on</c> turns Notato on, and <c>false</c>, <c>0</c>, <c>no</c> or
    /// <c>off</c> keeps it off, over the options and over what was chosen on the device before.
    /// </summary>
    internal const string Enabled = "NOTATO_ENABLED";

    /// <summary>The server, such as <c>http://localhost:4747</c>, in place of the configured one.</summary>
    internal const string Server = "NOTATO_SERVER";

    /// <summary>On, off, or null for anything else (so the options decide), in any case.</summary>
    internal static bool? ParseSwitch(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "true" or "1" or "yes" or "on" => true,
        "false" or "0" or "no" or "off" => false,
        _ => null,
    };

    /// <summary>Sets what the variables <paramref name="read"/> finds say on <paramref name="options"/>.</summary>
    internal static void Apply(NotatoOptions options, Func<string, string?> read)
    {
        if (ParseSwitch(read(Enabled)) is bool on)
        {
            options.Enabled = on;
            options.EnabledByEnvironment = true;
        }

        if (read(Server) is { } server && !string.IsNullOrWhiteSpace(server))
        {
            options.Server = server.Trim();
        }
    }
}
