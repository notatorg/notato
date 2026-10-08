using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Notato.Maui.Model;
using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace Notato.Maui.Tests;

internal static class Fixtures
{
    /// <summary>packages/schema/schema.json: generated from the Zod schema the server validates with.</summary>
    public static string SchemaPath([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "..", "..", "packages", "schema", "schema.json"));

    /// <summary>An annotation shaped like one the SDK makes, with every optional part filled in.</summary>
    public static Annotation Annotation(string? bundleId = null) => new()
    {
        Id = "01M46YHJA6PBM210JB4H2WMY14",
        ProjectId = "maui-sample",
        BundleId = bundleId,
        Author = Author.Human("Dom"),
        Mode = Modes.Dev,
        CreatedAt = "2026-10-05T21:12:02.121Z",
        Url = "maui://com.notato.mauisample/shop",
        Route = "/shop",
        AppName = "Sample",
        AppVersion = "1.0 (1)",
        Environment = new EnvironmentInfo
        {
            UserAgent = "Sample/1.0 (iOS 26.5; iPhone; simulator) .NET MAUI/10.0.60",
            Viewport = new Viewport(402, 874),
            Dpr = 3,
            Platform = "maui",
            Sdk = new SdkInfo("Notato.Maui", "0.2.0"),
        },
        Target = new Target
        {
            Kind = TargetKinds.Element,
            Identity =
            [
                new ElementIdentity
                {
                    Selector = "ProductsPage Border#PromoBanner",
                    TestId = "PromoBanner",
                    PlatformId = "PromoBanner",
                    Role = "text",
                    Name = "Autumn sale",
                    Tag = "Border",
                    Classes = ["promo"],
                    Text = "Autumn sale: 20% off jackets this week",
                    Source = new SourceLocation { File = "src/App/Views/ProductsPage.xaml", Line = 14, Col = 14 },
                    Component = new ComponentInfo { Name = "ProductsPage", Source = "src/App/Views/ProductsPage.xaml", Path = ["AppShell", "ProductsPage"] },
                    Styles = new Dictionary<string, string> { ["background"] = "#fef3c7" },
                    Ancestors = ["ProductsPage", "Grid"],
                },
            ],
            Rect = new PageRect(16, 195.67, 370, 38),
        },
        Comment = "The sale text is almost invisible.",
        Severity = Severities.Major,
        Intent = AnnotationIntents.Fix,
        Screenshots = new Screenshots
        {
            Full = new AssetRef { Id = new string('a', 64), Mime = "image/png", W = 804, H = 1748 },
            Crop = new AssetRef { Id = new string('b', 64), Mime = "image/png", W = 804, H = 172 },
        },
        Steps = [new AgentStep { Action = "tap", Target = "#PromoBanner", At = "2026-10-05T21:12:00.000Z" }],
        Context = new Dictionary<string, JsonElement>
        {
            ["console"] = JsonSerializer.SerializeToElement([new() { Level = "warn", Message = "boom", At = "2026-10-05T21:11:00.000Z" }], NotatoJsonContext.Default.ListLogEntry),
        },
        Status = Statuses.Open,
        Thread = [],
    };

    /// <summary>
    /// A People only note as the server sends it: turned on by one person, with an agent's reply from before, an aside,
    /// and the automatic entries the server writes for each change.
    /// </summary>
    public static Annotation PeopleOnlyAnnotation() => Annotation() with
    {
        Status = Statuses.Acknowledged,
        PeopleOnly = true,
        Thread =
        [
            new Reply { Id = "01M46YHK00AGENTREPLY000001", Author = Author.Agent("Claude"), Body = "Looking at the contrast now.", CreatedAt = "2026-10-05T21:13:00.000Z" },
            new Reply { Id = "01M46YHK00ASIDE00000000002", Author = Author.Human("Dom"), Body = "Sam, ignore the agent for a sec.", CreatedAt = "2026-10-05T21:14:00.000Z", Aside = true },
            new Reply { Id = "01M46YHK00OFF0000000000003", Author = Author.Human("Sam"), Body = PeopleOnlyToggle.TurnedOff, CreatedAt = "2026-10-05T21:15:00.000Z", Automatic = true, PeopleOnly = false },
            new Reply { Id = "01M46YHK00ON00000000000004", Author = Author.Human("Dom"), Body = PeopleOnlyToggle.TurnedOn, CreatedAt = "2026-10-05T21:16:00.000Z", Automatic = true, PeopleOnly = true },
        ],
    };

    /// <summary>
    /// A controller as the app's DI makes it, never switched on (so no overlay, no sync loop), talking to
    /// <paramref name="server"/> through <paramref name="handler"/> when given.
    /// </summary>
    public static NotatoController Controller(NotatoMode mode = NotatoMode.Dev, string? server = "http://127.0.0.1:9", HttpMessageHandler? handler = null)
    {
        IServiceCollection services = new ServiceCollection().AddLogging();
        services.AddNotato(configure: o =>
        {
            o.Project = "maui-sample";
            o.Mode = mode;
            o.Author = "Dom";
            o.Server = server;
            o.RememberRuntimeState = false;
        });
        ServiceProvider provider = services.BuildServiceProvider();
        return new NotatoController(provider.GetRequiredService<IOptionsMonitor<NotatoOptions>>(), provider.GetRequiredService<ILogger<NotatoController>>(), handler);
    }

    /// <summary>A note as the server stores it, answered as JSON.</summary>
    public static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Stored(HttpStatusCode status, Annotation annotation, long seq = 1) =>
        Json(status, JsonSerializer.Serialize(new StoredAnnotation { Annotation = annotation, Seq = seq }, NotatoJsonContext.Default.StoredAnnotation));

    public static HttpResponseMessage List(params Annotation[] annotations) =>
        Json(HttpStatusCode.OK, JsonSerializer.Serialize(new AnnotationList { Items = [.. annotations.Select((a, i) => new StoredAnnotation { Annotation = a, Seq = i + 1 })] }, NotatoJsonContext.Default.AnnotationList));
}

/// <summary>A server that answers as told, and remembers what it was asked: method, path and query, and body.</summary>
internal sealed class FakeServer(Func<HttpRequestMessage, string, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<(HttpMethod Method, string Path, string Body)> Seen { get; } = [];

    /// <summary>What was asked, as <c>METHOD /path?query</c>.</summary>
    public List<string> Asked => [.. Seen.Select(s => $"{s.Method} {s.Path}")];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        lock (Seen)
        {
            Seen.Add((request.Method, request.RequestUri!.PathAndQuery, body));
        }
        return answer(request, body);
    }
}
