using Notato.Maui.Model;
using System.Reflection;

namespace Notato.Maui.Runtime;

/// <summary>
/// This package as notes name it (<c>environment.sdk</c>). The version is the assembly's, which Directory.Build.props
/// sets (<c>bun scripts/version.ts</c> stamps it), without the commit the build adds after a <c>+</c>.
/// </summary>
internal static class NotatoSdk
{
    public static SdkInfo Current { get; } = new(
        "Notato.Maui",
        (typeof(NotatoSdk).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0")
            .Split('+')[0]);
}
