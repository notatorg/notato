using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Devices;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using System.Globalization;
using System.Reflection;
using System.Text.Json.Serialization;

namespace Notato.Maui.Runtime;

/// <summary>What the agent is told about the app and device, as <c>context.maui</c>.</summary>
internal sealed record MauiContextInfo
{
    public string? Page { get; init; }
    public string? PageXaml { get; init; }
    /// <summary>The type of the selected element's BindingContext: usually its view model.</summary>
    public string? BindingContext { get; init; }
    public string? PageBindingContext { get; init; }
    public string? ShellLocation { get; init; }
    public IReadOnlyList<string>? NavigationStack { get; init; }
    public IReadOnlyList<string>? ModalStack { get; init; }
    public string? Platform { get; init; }
    public string? OsVersion { get; init; }
    public string? Device { get; init; }
    public string? Idiom { get; init; }
    public bool? Virtual { get; init; }
    public string? Orientation { get; init; }
    public string? Theme { get; init; }
    public string? Culture { get; init; }
    public double? FontScale { get; init; }
    public string? Maui { get; init; }
    public string? Dotnet { get; init; }
}

internal sealed record PinContext
{
    public int Pin { get; init; }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(MauiContextInfo))]
[JsonSerializable(typeof(PinContext))]
internal sealed partial class ContextJson : JsonSerializerContext;

/// <summary>The route, URL, environment and <c>maui</c> context of an annotation.</summary>
internal static class AppContextInfo
{
    private static string? mauiVersion;

    private static string Version(Assembly assembly)
    {
        string v = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? assembly.GetName().Version?.ToString() ?? "";
        int plus = v.IndexOf('+');
        return plus < 0 ? v : v[..plus];
    }

    public static string MauiVersion => mauiVersion ??= Version(typeof(Element).Assembly);

    private static T? Safe<T>(Func<T> read)
    {
        try
        {
            return read();
        }
        catch
        {
            // Essentials throws on plain net10.0; a missing detail is fine.
            return default;
        }
    }

    public static string AppName(NotatoOptions options) => options.AppName ?? Safe(() => AppInfo.Current.Name) ?? "app";

    public static string? AppVersion(NotatoOptions options) =>
        options.AppVersion ?? Safe(() => $"{AppInfo.Current.VersionString} ({AppInfo.Current.BuildString})");

    /// <summary>The page stack that is showing, as type names: a NavigationPage's stack, a tab's, a flyout's detail.</summary>
    private static List<string> StackOf(Page page)
    {
        return page switch
        {
            NavigationPage nav => [.. nav.Navigation.NavigationStack.Select(p => VisualTree.TypeName(p.GetType()))],
            TabbedPage tabs when tabs.CurrentPage is { } current => StackOf(current),
            FlyoutPage flyout when flyout.Detail is { } detail => StackOf(detail),
            _ => [VisualTree.TypeName(page.GetType())],
        };
    }

    /// <summary>
    /// The route: the Shell location without its query (<c>/products/details</c>), else the page stack
    /// (<c>/MainPage/DetailsPage</c>), with any modal page that is not part of it added on the end.
    /// </summary>
    public static (string Route, string Url, string? ShellLocation, IReadOnlyList<string> Stack, IReadOnlyList<string> Modals) RouteOf(Window window)
    {
        string path;
        string query = "";
        string? location = null;
        List<string> stack = [];
        if (window.Page is Shell shell)
        {
            location = shell.CurrentState?.Location?.OriginalString;
            string raw = location ?? "";
            int q = raw.IndexOf('?');
            if (q >= 0)
            {
                query = raw[q..];
                raw = raw[..q];
            }
            path = "/" + string.Join('/', raw.TrimStart('/').Split('/').Select(CleanShellSegment));
            if (shell.CurrentPage is not null)
            {
                stack = [.. shell.Navigation.NavigationStack.Where(p => p is not null).Select(p => VisualTree.TypeName(p.GetType()))];
            }

            if (stack.Count == 0 && shell.CurrentPage is { } only)
            {
                stack.Add(VisualTree.TypeName(only.GetType()));
            }
        }
        else
        {
            stack = window.Page is { } page ? StackOf(page) : [];
            path = "/" + string.Join("/", stack);
        }
        List<string> modals = window.Navigation?.ModalStack.Where(p => p is not null).Select(p => VisualTree.TypeName(p.GetType())).ToList() ?? [];
        if (window.Page is Shell shellPage)
        {
            // Shell lists a modal it navigated to in its location already; add only modals pushed around it.
            Page shown = shellPage.CurrentPage;
            foreach (Page? modal in window.Navigation?.ModalStack ?? [])
            {
                if (modal is null || ReferenceEquals(modal, shown) || modal is NavigationPage { CurrentPage: var inner } && ReferenceEquals(inner, shown))
                {
                    continue;
                }

                path += "/" + VisualTree.TypeName((modal is NavigationPage nav ? nav.CurrentPage ?? modal : modal).GetType());
            }
        }
        else
        {
            foreach (string name in modals)
            {
                path += "/" + name;
            }
        }
        if (path.Length > 1)
        {
            path = path.TrimEnd('/');
        }

        string package = Safe(() => AppInfo.Current.PackageName) ?? "app";
        return (path, $"maui://{package}{path}{query}", location, stack, modals);
    }

    /// <summary>
    /// Shell makes up route names for what was not given one: <c>D_FAULT_CheckoutPage10</c> for a page pushed without a
    /// route, <c>IMPL_MainPage</c> for an implicit item. The page's name is what means something.
    /// </summary>
    internal static string CleanShellSegment(string segment)
    {
        if (segment.StartsWith("D_FAULT_", StringComparison.Ordinal))
        {
            return segment["D_FAULT_".Length..].TrimEnd("0123456789".ToCharArray());
        }

        if (segment.StartsWith("IMPL_", StringComparison.Ordinal))
        {
            return segment["IMPL_".Length..];
        }

        return segment;
    }

    public static EnvironmentInfo Environment(NotatoOptions options, Size window)
    {
        string app = AppName(options);
        string version = Safe(() => AppInfo.Current.VersionString) ?? "";
        string platform = Safe(() => DeviceInfo.Current.Platform.ToString()) ?? "unknown";
        string os = Safe(() => DeviceInfo.Current.VersionString) ?? "";
        string model = Safe(() => DeviceInfo.Current.Model) ?? "";
        string kind = Safe(() => DeviceInfo.Current.DeviceType) == DeviceType.Virtual ? "; simulator" : "";
        double density = Safe(() => DeviceDisplay.Current.MainDisplayInfo.Density);
        return new EnvironmentInfo
        {
            UserAgent = $"{app}/{version} ({platform} {os}; {model}{kind}) .NET MAUI/{MauiVersion}",
            Viewport = new Viewport(Math.Round(window.Width, 2), Math.Round(window.Height, 2)),
            Dpr = density > 0 ? density : 1,
            Platform = "maui",
            Sdk = NotatoSdk.Current,
        };
    }

    public static MauiContextInfo Describe(Window window, Element? target, SourceLocator sources)
    {
        (_, _, string? location, IReadOnlyList<string> stack, IReadOnlyList<string> modals) = RouteOf(window);
        Page? page = target is null ? null : VisualTree.PageOf(target);
        DisplayInfo display = Safe(() => DeviceDisplay.Current.MainDisplayInfo);
        return new MauiContextInfo
        {
            Page = page is null ? null : VisualTree.TypeName(page.GetType()),
            PageXaml = page is null ? null : sources.XamlFileOf(page),
            BindingContext = target?.BindingContext?.GetType().Name,
            PageBindingContext = page?.BindingContext?.GetType().Name,
            ShellLocation = location,
            NavigationStack = stack.Count > 0 ? stack : null,
            ModalStack = modals.Count > 0 ? modals : null,
            Platform = Safe(() => DeviceInfo.Current.Platform.ToString()),
            OsVersion = Safe(() => DeviceInfo.Current.VersionString),
            Device = Safe(() => $"{DeviceInfo.Current.Manufacturer} {DeviceInfo.Current.Model}".Trim()),
            Idiom = Safe(() => DeviceInfo.Current.Idiom.ToString()),
            Virtual = Safe(() => DeviceInfo.Current.DeviceType == DeviceType.Virtual),
            Orientation = display.Orientation.ToString(),
            Theme = Safe(() => Application.Current?.RequestedTheme.ToString()),
            Culture = CultureInfo.CurrentUICulture.Name,
            FontScale = FontScale(),
            Maui = MauiVersion,
            Dotnet = System.Environment.Version.ToString(),
        };
    }

    private static double? FontScale()
    {
#if ANDROID
        return Microsoft.Maui.ApplicationModel.Platform.AppContext.Resources?.Configuration?.FontScale;
#elif IOS || MACCATALYST
        return UIKit.UIFontMetrics.DefaultMetrics.GetScaledValue(100) / 100.0;
#else
        return null;
#endif
    }
}
