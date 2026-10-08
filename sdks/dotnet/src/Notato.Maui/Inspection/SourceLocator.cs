using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Xaml;
using Notato.Maui.Model;
using System.Collections.Concurrent;
using System.Reflection;

namespace Notato.Maui.Inspection;

/// <summary>
/// Where in the code an element was written. MAUI records the XAML file, line and column of every element it inflates
/// when its diagnostics are on (Notato turns them on; see <see cref="NotatoOptions.XamlSourceInfo"/>). Paths are made
/// to start at the repository root using what the package's MSBuild targets recorded in each assembly.
/// </summary>
internal sealed class SourceLocator(string? projectPathOverride)
{
    internal const string ProjectPathKey = "Notato.ProjectPath";
    internal const string RepositoryRootKey = "Notato.RepositoryRoot";

    private readonly ConcurrentDictionary<string, (string? ProjectPath, string? RepositoryRoot)> _assemblies = new();

    /// <summary>Asks MAUI to keep XAML source info. Must run before the first page is inflated.</summary>
    public static void EnableXamlSourceInfo() =>
        AppContext.SetSwitch("Microsoft.Maui.RuntimeFeature.EnableMauiDiagnostics", true);

    /// <summary>The element's own location, or the nearest element around it that has one (marked <c>nearest</c>).</summary>
    public SourceLocation? Locate(Element element)
    {
        bool nearest = false;
        foreach (Element e in VisualTree.SelfAndAncestors(element))
        {
            if (Of(e) is { } found)
            {
                return nearest ? found with { Nearest = true } : found;
            }

            nearest = true;
            // A page is a boundary: past it the location says nothing about this element.
            if (e is Page)
            {
                break;
            }
        }
        return null;
    }

    public SourceLocation? Of(object target)
    {
        SourceInfo? info = Microsoft.Maui.VisualDiagnostics.GetSourceInfo(target);
        if (info is null || info.LineNumber <= 0)
        {
            return null;
        }
        // "Views/LoginPage.xaml;assembly=MyApp"
        string raw = Uri.UnescapeDataString(info.SourceUri.OriginalString);
        int split = raw.IndexOf(";assembly=", StringComparison.Ordinal);
        string path = split < 0 ? raw : raw[..split];
        string? assembly = split < 0 ? null : raw[(split + ";assembly=".Length)..];
        return new SourceLocation
        {
            File = FromRepositoryRoot(path, assembly),
            Line = info.LineNumber,
            Col = Math.Max(1, info.LinePosition),
        };
    }

    /// <summary>The XAML file behind a page or view type, e.g. <c>src/MyApp/Views/LoginPage.xaml</c>.</summary>
    public string? XamlFileOf(Element component)
    {
        XamlFilePathAttribute? attribute = component.GetType().GetCustomAttribute<XamlFilePathAttribute>(inherit: false);
        if (attribute is null || string.IsNullOrEmpty(attribute.FilePath))
        {
            return null;
        }

        return FromRepositoryRoot(attribute.FilePath, component.GetType().Assembly.GetName().Name);
    }

    internal string FromRepositoryRoot(string path, string? assemblyName)
    {
        path = path.Replace('\\', '/');
        (string? projectPath, string? repositoryRoot) = assemblyName is null ? (null, null) : RecordedFor(assemblyName);
        if (Path.IsPathRooted(path) || path.StartsWith('/'))
        {
            string? root = repositoryRoot?.Replace('\\', '/').TrimEnd('/');
            if (root is not null && path.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase))
            {
                return path[(root.Length + 1)..];
            }

            return path;
        }
        string? prefix = projectPathOverride ?? projectPath;
        if (string.IsNullOrEmpty(prefix) || prefix == ".")
        {
            return path;
        }

        return prefix.Replace('\\', '/').Trim('/') + "/" + path.TrimStart('/');
    }

    private (string?, string?) RecordedFor(string assemblyName) => _assemblies.GetOrAdd(assemblyName, static name =>
    {
        Assembly? assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == name);
        if (assembly is null)
        {
            return (null, null);
        }

        string? project = null, root = null;
        foreach (AssemblyMetadataAttribute meta in assembly.GetCustomAttributes<AssemblyMetadataAttribute>())
        {
            if (meta.Key == ProjectPathKey)
            {
                project = meta.Value;
            }
            else if (meta.Key == RepositoryRootKey)
            {
                root = meta.Value;
            }
        }
        return (project, root);
    });
}
