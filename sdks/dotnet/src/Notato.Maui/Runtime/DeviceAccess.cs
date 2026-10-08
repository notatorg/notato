using System.Reflection;

namespace Notato.Maui.Runtime;

/// <summary>
/// How this build reaches <c>notato dev</c> from a phone: what <c>notato dev --tunnel</c> wrote to
/// <c>.notato/device.json</c> when the app was built (the package's build targets record it in debug builds). A phone
/// cannot reach the development machine's localhost, so on one Notato uses the dev tunnel and its device token.
/// </summary>
internal sealed record DeviceAccess(string? Tunnel, string? Token, string? Local)
{
    internal const string TunnelKey = "Notato.DeviceServer";
    internal const string TokenKey = "Notato.DeviceToken";
    internal const string LocalKey = "Notato.LocalServer";

    private static readonly Lazy<DeviceAccess?> recorded = new(() => FromAssemblies(AppDomain.CurrentDomain.GetAssemblies()));
    private static readonly Lazy<bool> reachesLoopback = new(Detect);

    /// <summary>What the app's build recorded, or null (a release build, or no tunnel when it was built).</summary>
    internal static DeviceAccess? Recorded => recorded.Value;

    /// <summary>
    /// Whether this device can reach the development machine's localhost. The iOS simulator and Mac Catalyst share the
    /// Mac's network; a phone does not, and neither does the Android emulator (whose localhost is itself).
    /// </summary>
    internal static bool ReachesLoopback => reachesLoopback.Value;

    private static bool Detect()
    {
#if MACCATALYST
        return true;
#elif IOS
        return Microsoft.Maui.Devices.DeviceInfo.Current.DeviceType == Microsoft.Maui.Devices.DeviceType.Virtual;
#elif ANDROID
        return false;
#else
        return true;
#endif
    }

    internal static DeviceAccess? FromAssemblies(IEnumerable<Assembly> assemblies)
    {
        foreach (Assembly assembly in assemblies)
        {
            if (assembly.IsDynamic)
            {
                continue;
            }

            if (FromMetadata(assembly.GetCustomAttributes<AssemblyMetadataAttribute>()) is { } found)
            {
                return found;
            }
        }
        return null;
    }

    internal static DeviceAccess? FromMetadata(IEnumerable<AssemblyMetadataAttribute> metadata)
    {
        string? tunnel = null, token = null, local = null;
        foreach (AssemblyMetadataAttribute meta in metadata)
        {
            if (meta.Key == TunnelKey)
            {
                tunnel = Clean(meta.Value);
            }
            else if (meta.Key == TokenKey)
            {
                token = Clean(meta.Value);
            }
            else if (meta.Key == LocalKey)
            {
                local = Clean(meta.Value);
            }
        }
        return tunnel is not null || local is not null ? new DeviceAccess(tunnel, token, local) : null;
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    /// <summary>The server to use when none is configured: localhost where it can be reached, else the tunnel.</summary>
    internal string? ServerFor(bool reachesLoopback) => reachesLoopback ? Local : Tunnel ?? Local;

    /// <summary>The device token, for the tunnel it belongs to only.</summary>
    internal string? TokenFor(string? server) =>
        Tunnel is not null && Token is not null && string.Equals(server?.TrimEnd('/'), Tunnel, StringComparison.OrdinalIgnoreCase) ? Token : null;
}
