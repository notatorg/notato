using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Runtime;
using Notato.Maui.Util;
using System.Net;
using System.Text;

namespace Notato.Maui.Tests;

public class OptionsTests
{
    private static NotatoOptions Bind(Dictionary<string, string?> values, Action<NotatoOptions>? configure = null)
    {
        IConfigurationRoot configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        IServiceCollection services = new ServiceCollection().AddLogging();
        services.AddNotato(configuration.GetSection(NotatoOptions.SectionName), configure);
        return services.BuildServiceProvider().GetRequiredService<IOptions<NotatoOptions>>().Value;
    }

    [Fact]
    public void The_Notato_section_binds_and_code_adjusts_it()
    {
        NotatoOptions options = Bind(new()
        {
            ["Notato:Project"] = "checkout-app",
            ["Notato:Mode"] = "agent",
            ["Notato:Server"] = "https://notato.example.com/",
            ["Notato:Enabled"] = "false",
            ["Notato:ToolbarPosition"] = "TopLeft",
            ["Notato:MaskInputs"] = "false",
        }, o => o.Author = "Dom");
        Assert.Equal("checkout-app", options.Project);
        Assert.Equal(NotatoMode.Agent, options.Mode);
        Assert.False(options.Enabled);
        Assert.Equal(ToolbarCorner.TopLeft, options.ToolbarPosition);
        Assert.Equal("https://notato.example.com", options.ResolvedServer);
        Assert.False(options.ResolvedMaskInputs);
        Assert.Equal("Dom", options.Author);
    }

    [Fact]
    public void Defaults_suit_dev_mode()
    {
        NotatoOptions options = Bind(new() { ["Notato:Project"] = "app" });
        Assert.True(options.Enabled);
        Assert.Equal(NotatoOptions.DefaultServer, options.ResolvedServer);
        Assert.False(options.ResolvedMaskInputs);
        Assert.Null(NotatoController.Validate(options));
    }

    [Fact]
    public void Test_mode_has_no_server_unless_given_one_and_masks_inputs()
    {
        NotatoOptions options = Bind(new() { ["Notato:Project"] = "app", ["Notato:Mode"] = "Test" });
        Assert.Null(options.ResolvedServer);
        Assert.True(options.ResolvedMaskInputs);
    }

    [Theory]
    [InlineData("", null, "needs a project id")]
    [InlineData("has spaces", null, "may only use")]
    [InlineData("café", null, "may only use")]
    [InlineData("..", null, "not only dots")]
    [InlineData(".", null, "not only dots")]
    [InlineData("app", "ftp://x", "not an http(s) URL")]
    public void Bad_options_are_explained(string project, string? server, string expected)
    {
        string? problem = NotatoController.Validate(new NotatoOptions { Project = project, Server = server });
        Assert.Contains(expected, problem);
    }
}

public class ServerSentEventTests
{
    [Fact]
    public async Task Events_are_split_on_blank_lines_and_comments_are_skipped()
    {
        string text = "event: hello\ndata: {\"projectId\":\"p\"}\n\n: ping\n\nevent: updated\ndata: {\"a\":1,\ndata: \"b\":2}\n\ndata: plain\n\n";
        List<ServerSentEvent> events = [];
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new StringReader(text)))
        {
            events.Add(e);
        }

        Assert.Equal([new ServerSentEvent("hello", "{\"projectId\":\"p\"}"), new ServerSentEvent("updated", "{\"a\":1,\n\"b\":2}"), new ServerSentEvent("message", "plain")], events);
    }

    /// <summary>A connection that sends what it is given and then nothing, as a half-open one does: no error, no end.</summary>
    private sealed class Silent(string text) : TextReader
    {
        private readonly StringReader _given = new(text);

        public override async ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            if (_given.ReadLine() is { } line)
            {
                return line;
            }
            // Ignores the token, as some platforms' network streams do.
            await Task.Delay(Timeout.Infinite, CancellationToken.None);
            return null;
        }
    }

    [Fact]
    public async Task A_stream_that_goes_quiet_ends_in_a_timeout_after_what_it_sent()
    {
        List<ServerSentEvent> events = [];
        Task reading = Task.Run(async () =>
        {
            await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new Silent("event: hello\ndata: {}\n\n: ping\n"), TimeSpan.FromMilliseconds(150)))
            {
                events.Add(e);
            }
        });

        Task first = await Task.WhenAny(reading, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(reading, first);
        TimeoutException error = await Assert.ThrowsAsync<TimeoutException>(() => reading);
        Assert.Contains("keep-alive", error.Message);
        Assert.Equal([new ServerSentEvent("hello", "{}")], events);
    }

    /// <summary>A connection with nothing to say but a keep-alive every <paramref name="every"/>, then one event.</summary>
    private sealed class Pinging(int pings, TimeSpan every) : TextReader
    {
        private readonly Queue<string> _lines = new([.. Enumerable.Repeat(new[] { ": ping", "" }, pings).SelectMany(l => l), "event: bye", "data: {}", ""]);

        public override async ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            if (_lines.Count == 0)
            {
                return null;
            }

            if (_lines.Peek().StartsWith(':'))
            {
                await Task.Delay(every, cancellationToken);
            }

            return _lines.Dequeue();
        }
    }

    [Fact]
    public async Task Keep_alives_keep_a_quiet_stream_open()
    {
        // Ten pings 40 ms apart: far longer than the 150 ms limit in all, but never 150 ms without a line.
        List<ServerSentEvent> events = [];
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new Pinging(10, TimeSpan.FromMilliseconds(40)), TimeSpan.FromMilliseconds(150)))
        {
            events.Add(e);
        }

        Assert.Equal([new ServerSentEvent("bye", "{}")], events);
    }
}

public class ClientTests
{
    private sealed class Recorder(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Seen.Add((request, request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken)));
            return answer(request);
        }
    }

    [Fact]
    public async Task An_annotation_is_posted_as_multipart_with_its_screenshots()
    {
        Annotation annotation = Fixtures.Annotation();
        string stored = System.Text.Json.JsonSerializer.Serialize(new StoredAnnotation { Annotation = annotation, Seq = 7 }, NotatoJsonContext.Default.StoredAnnotation);
        Recorder handler = new(_ => new HttpResponseMessage(HttpStatusCode.Created) { Content = new StringContent(stored, Encoding.UTF8, "application/json") });
        NotatoClient client = new(new HttpClient(handler), "http://localhost:4747/", "pft_secret");
        Dictionary<string, byte[]> assets = new() { [new string('a', 64)] = [137, 80, 78, 71], [new string('b', 64)] = [137, 80, 78, 71] };

        StoredAnnotation result = await client.PostAnnotationAsync(annotation, assets);

        Assert.Equal(7, result.Seq);
        (HttpRequestMessage? request, string? body) = Assert.Single(handler.Seen);
        Assert.Equal("http://localhost:4747/projects/maui-sample/annotations", request.RequestUri!.ToString());
        Assert.Equal("Bearer pft_secret", request.Headers.Authorization!.ToString());
        Assert.StartsWith("multipart/form-data", request.Content!.Headers.ContentType!.ToString());
        Assert.Contains("name=\"annotation\"", body);
        Assert.Contains($"name=\"asset:{new string('a', 64)}\"", body);
        Assert.Contains($"name=\"asset:{new string('b', 64)}\"", body);
    }

    [Fact]
    public async Task A_refusal_carries_the_servers_reason_and_is_permanent()
    {
        Recorder handler = new(_ => new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"error\":\"this credential cannot access project \\\"x\\\"\"}") });
        NotatoClient client = new(new HttpClient(handler), "http://localhost:4747", null);
        NotatoServerException error = await Assert.ThrowsAsync<NotatoServerException>(() => client.ListAsync("x"));
        Assert.True(error.Permanent);
        Assert.Contains("cannot access project", error.Message);
    }

    [Fact]
    public async Task The_platforms_long_error_dump_is_cut_to_its_reason()
    {
        const string dump = "Error Domain=NSURLErrorDomain Code=-1004 \"Could not connect to the server.\" UserInfo={_kCFStreamErrorCodeKey=61, NSLocalizedDescription=Could not connect to the server., NSErrorFailingURLKey=http://localhost:4747/x}";
        Recorder handler = new(_ => throw new HttpRequestException(dump));
        NotatoServerException error = await Assert.ThrowsAsync<NotatoServerException>(() => new NotatoClient(new HttpClient(handler), "http://localhost:4747", null).GetConfigAsync());
        Assert.Equal("Cannot reach the Notato server at http://localhost:4747: Could not connect to the server.", error.Message);
    }

    [Theory]
    [InlineData(400, true)]
    [InlineData(409, true)]
    [InlineData(413, true)]
    [InlineData(415, true)]
    [InlineData(422, true)]
    [InlineData(401, false)]
    [InlineData(403, false)]
    [InlineData(404, false)]
    [InlineData(408, false)]
    [InlineData(429, false)]
    [InlineData(500, false)]
    [InlineData(503, false)]
    [InlineData(0, false)]
    public void Only_a_refusal_of_what_was_sent_sets_a_note_aside(int status, bool rejected)
    {
        Assert.Equal(rejected, new NotatoServerException("x", status).Rejected);
    }

    [Fact]
    public async Task The_list_is_read_page_after_page_until_there_is_no_next()
    {
        static string Page(int from, int count, long? next)
        {
            List<StoredAnnotation> items = [.. Enumerable.Range(from, count).Select(i => new StoredAnnotation { Annotation = Fixtures.Annotation() with { Id = $"N{i:000000}" }, Seq = i })];
            return System.Text.Json.JsonSerializer.Serialize(new AnnotationList { Items = items, Next = next }, NotatoJsonContext.Default.AnnotationList);
        }
        Recorder handler = new(request =>
        {
            string query = request.RequestUri!.Query;
            string body = query switch
            {
                "?limit=500" => Page(1, 500, 500),
                "?limit=500&afterSeq=500" => Page(501, 500, 1000),
                "?limit=500&afterSeq=1000" => Page(1001, 20, null),
                _ => throw new InvalidOperationException(query),
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        });

        IReadOnlyList<StoredAnnotation> all = await new NotatoClient(new HttpClient(handler), "http://localhost:4747", null).ListAsync("maui-sample");

        Assert.Equal(1020, all.Count);
        Assert.Equal("N001020", all[^1].Annotation.Id);
        Assert.Equal(3, handler.Seen.Count);
        Assert.All(handler.Seen, s => Assert.StartsWith("/projects/maui-sample/annotations", s.Request.RequestUri!.AbsolutePath));
    }

    [Fact]
    public async Task A_page_that_fails_fails_the_whole_list()
    {
        Recorder handler = new(request => request.RequestUri!.Query.Contains("afterSeq", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"items\":[],\"next\":500}", Encoding.UTF8, "application/json") });

        await Assert.ThrowsAsync<NotatoServerException>(() => new NotatoClient(new HttpClient(handler), "http://localhost:4747", null).ListAsync("p"));
    }

    [Fact]
    public async Task An_older_server_without_next_is_one_page()
    {
        Recorder handler = new(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"items\":[]}", Encoding.UTF8, "application/json") });
        Assert.Empty(await new NotatoClient(new HttpClient(handler), "http://localhost:4747", null).ListAsync("p"));
        Assert.Single(handler.Seen);
    }

    [Fact]
    public async Task On_connecting_the_list_asks_for_summaries_page_by_page()
    {
        Recorder handler = new(request => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(request.RequestUri!.Query.Contains("afterSeq", StringComparison.Ordinal) ? "{\"items\":[]}" : "{\"items\":[],\"next\":500}", Encoding.UTF8, "application/json"),
        });

        await new NotatoClient(new HttpClient(handler), "http://localhost:4747", null).ListAsync("p", summary: true);

        Assert.Equal(["?limit=500&fields=summary", "?limit=500&fields=summary&afterSeq=500"], handler.Seen.Select(s => s.Request.RequestUri!.Query));
    }

    /// <summary>A body that sends <paramref name="chunks"/> pieces, <paramref name="every"/> apart, then (with <paramref name="stall"/>) nothing more.</summary>
    private sealed class Trickle(int chunks, TimeSpan every, bool stall) : Stream
    {
        private readonly byte[] _json = Encoding.UTF8.GetBytes("{\"screenshots\":false}");
        private int _sent;

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            int chunk = (int)Math.Ceiling(_json.Length / (double)chunks);
            if (_sent >= _json.Length || (stall && _sent >= chunk))
            {
                if (stall)
                {
                    // Ignores the token, as some platforms' network streams do.
                    await Task.Delay(Timeout.Infinite, CancellationToken.None);
                }

                return 0;
            }

            await Task.Delay(every, cancellationToken);
            int n = Math.Min(chunk, _json.Length - _sent);
            _json.AsMemory(_sent, n).CopyTo(buffer);
            _sent += n;
            return n;
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Fact]
    public async Task A_body_may_take_as_long_as_it_keeps_coming_but_one_that_stops_times_out()
    {
        TimeSpan limit = TimeSpan.FromMilliseconds(150);
        // Ten pieces 40 ms apart: far longer than the limit in all, but never that long without a byte.
        IdleTimeoutStream steady = new(new Trickle(10, TimeSpan.FromMilliseconds(40), stall: false), limit);
        ServerConfig? config = await System.Text.Json.JsonSerializer.DeserializeAsync(steady, NotatoJsonContext.Default.ServerConfig);
        Assert.False(config!.Screenshots);

        IdleTimeoutStream stalled = new(new Trickle(10, TimeSpan.FromMilliseconds(10), stall: true), limit);
        Task<ServerConfig?> reading = System.Text.Json.JsonSerializer.DeserializeAsync(stalled, NotatoJsonContext.Default.ServerConfig).AsTask();
        Assert.Same(reading, await Task.WhenAny(reading, Task.Delay(TimeSpan.FromSeconds(10))));
        await Assert.ThrowsAsync<TimeoutException>(() => reading);
    }

    [Fact]
    public async Task A_note_is_sent_with_its_screenshots_read_from_their_files_and_says_if_the_server_had_it()
    {
        string folder = Directory.CreateTempSubdirectory("notato-post-").FullName;
        try
        {
            Annotation annotation = Fixtures.Annotation();
            string full = Path.Combine(folder, "full.png");
            await File.WriteAllBytesAsync(full, [137, 80, 78, 71, 1, 2, 3]);
            HttpStatusCode answer = HttpStatusCode.Created;
            Recorder handler = new(_ => Fixtures.Stored(answer, annotation, 7));
            NotatoClient client = new(new HttpClient(handler), "http://localhost:4747", null);
            // The crop's file is gone: it is left out, as a missing asset always was.
            Dictionary<string, string> files = new() { [new string('a', 64)] = full, [new string('b', 64)] = Path.Combine(folder, "gone.png") };

            PostedAnnotation first = await client.PostAnnotationAsync(annotation, files);
            answer = HttpStatusCode.OK;
            PostedAnnotation again = await client.PostAnnotationAsync(annotation, files);

            Assert.True(first.Created);
            Assert.False(again.Created);
            Assert.Equal(7, again.Stored.Seq);
            string body = handler.Seen[0].Body;
            Assert.Contains($"name=\"asset:{new string('a', 64)}\"", body);
            Assert.DoesNotContain($"asset:{new string('b', 64)}", body);
            // The file is closed once the answer is in: it can go.
            File.Delete(full);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public async Task A_bundle_is_written_to_its_file_and_uploaded_from_it()
    {
        string folder = Directory.CreateTempSubdirectory("notato-bundle-").FullName;
        try
        {
            string shot = Path.Combine(folder, "a.png");
            await File.WriteAllBytesAsync(shot, [137, 80, 78, 71]);
            LocalAnnotation note = new(Fixtures.Annotation(), new Dictionary<string, string> { [new string('a', 64)] = shot });

            string path = await BundleWriter.WriteAsync([note], "maui-sample", "Dom", "Sample", "1.0", folder, CancellationToken.None);

            Assert.True(File.Exists(path));
            Assert.Empty(Directory.GetFiles(folder, "*.tmp"));
            using (System.IO.Compression.ZipArchive zip = System.IO.Compression.ZipFile.OpenRead(path))
            {
                Assert.Equal(["annotations.json", "feedback.md", "shots/01-full.png"], zip.Entries.Select(e => e.FullName).Order());
            }

            Recorder handler = new(_ => new HttpResponseMessage(HttpStatusCode.Created));
            await new NotatoClient(new HttpClient(handler), "http://localhost:4747", "pft_secret").UploadBundleAsync("maui-sample", path);

            (HttpRequestMessage request, string _) = Assert.Single(handler.Seen);
            Assert.Equal("/projects/maui-sample/bundles", request.RequestUri!.AbsolutePath);
            Assert.Equal("application/zip", request.Content!.Headers.ContentType!.MediaType);
            Assert.Equal(new FileInfo(path).Length, request.Content.Headers.ContentLength);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Theory]
    [InlineData(100L * 1024 * 1024, "100 MB")]
    [InlineData(110_000_000L, "104.9 MB")]
    [InlineData(512L * 1024, "0.5 MB")]
    public void Sizes_read_as_megabytes(long bytes, string expected) => Assert.Equal(expected, Notato.Maui.Overlay.MenuText.Megabytes(bytes));

    [Fact]
    public void A_large_upload_is_given_time_to_go_before_the_server_must_answer()
    {
        Assert.Equal(TimeSpan.FromSeconds(30), NotatoClient.UploadTimeout(0));
        // 100 MB at 50 KB a second, at the least.
        Assert.True(NotatoClient.UploadTimeout(BundleWriter.ServerLimit) > TimeSpan.FromMinutes(30));
    }

    [Fact]
    public async Task No_answer_is_not_permanent()
    {
        Recorder handler = new(_ => throw new HttpRequestException("connection refused"));
        NotatoClient client = new(new HttpClient(handler), "http://localhost:4747", null);
        NotatoServerException error = await Assert.ThrowsAsync<NotatoServerException>(() => client.GetConfigAsync());
        Assert.False(error.Permanent);
        Assert.Contains("Cannot reach the Notato server at http://localhost:4747", error.Message);
    }
}

public class SmallPartsTests
{
    [Fact]
    public void Ulids_are_26_crockford_characters_and_sort_by_time()
    {
        string earlier = Ulid.New(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
        string later = Ulid.New(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_001));
        Assert.Equal(26, earlier.Length);
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{26}$", earlier);
        Assert.True(string.CompareOrdinal(earlier, later) < 0);
        Assert.NotEqual(Ulid.New(), Ulid.New());
    }

    [Theory]
    [InlineData("D_FAULT_CheckoutPage10", "CheckoutPage")]
    [InlineData("IMPL_MainPage", "MainPage")]
    [InlineData("shop", "shop")]
    public void Generated_shell_route_names_become_page_names(string segment, string expected) =>
        Assert.Equal(expected, AppContextInfo.CleanShellSegment(segment));

    [Theory]
    [InlineData("Notato.Maui.NotatoController", true)]
    [InlineData("Notato.Maui.Native.AppleOverlayHost", true)]
    [InlineData("Notato.Maui.Sample.Views.AccountPage", false)]
    [InlineData("MyApp.LoginViewModel", false)]
    public void Only_Notatos_own_log_categories_are_left_out(string category, bool own) =>
        Assert.Equal(own, LogRecorder.IsNotatos(category));

    [Fact]
    public void The_log_keeps_the_newest_messages()
    {
        Ring<int> ring = new(3);
        for (int i = 0; i < 5; i++)
        {
            ring.Add(i);
        }

        Assert.Equal([2, 3, 4], ring.Snapshot());
    }

    [Fact]
    public void Containers_read_as_the_text_inside_them_and_passwords_are_never_read()
    {
        Border banner = new() { Content = new HorizontalStackLayout { Children = { new Label { Text = "Autumn sale:" }, new Label { Text = "20% off" } } } };
        Assert.Equal("Autumn sale: 20% off", ElementText.Visible(banner, mask: false));
        Assert.Null(ElementText.Of(new Entry { Text = "hunter2", IsPassword = true }, mask: false));
        Assert.Null(ElementText.Of(new Entry { Text = "dom@example.com" }, mask: true));
        Assert.Equal("dom@example.com", ElementText.Of(new Entry { Text = "dom@example.com" }, mask: false));
        Assert.Equal("button", ElementText.RoleOf(new Button()));
        Assert.Equal("heading", ElementText.RoleOf(new Label { Text = "Title" }.Also(l => SemanticProperties.SetHeadingLevel(l, SemanticHeadingLevel.Level1))));
    }

    [Fact]
    public void Styles_list_what_was_chosen_and_leave_defaults_out()
    {
        Label label = new() { TextColor = Color.FromArgb("#2563eb"), FontSize = 18, FontAttributes = FontAttributes.Bold, HorizontalTextAlignment = TextAlignment.End, Margin = new Thickness(4, 8) };
        IReadOnlyDictionary<string, string> styles = ElementInspector.StylesOf(label);
        Assert.Equal("#2563eb", styles["color"]);
        Assert.Equal("18", styles["font-size"]);
        Assert.Equal("700", styles["font-weight"]);
        Assert.Equal("end", styles["text-align"]);
        Assert.Equal("8 4", styles["margin"]);
        Assert.False(styles.ContainsKey("opacity"));
        Assert.False(styles.ContainsKey("background"));
    }

    [Fact]
    public void Xaml_paths_are_given_from_the_repository_root()
    {
        SourceLocator locator = new("src/MyApp");
        Assert.Equal("src/MyApp/Views/LoginPage.xaml", locator.FromRepositoryRoot("Views/LoginPage.xaml", null));
        Assert.Equal("src/MyApp/Views/LoginPage.xaml", locator.FromRepositoryRoot("Views\\LoginPage.xaml", null));
    }
}

internal static class TestExtensions
{
    public static T Also<T>(this T value, Action<T> action)
    {
        action(value);
        return value;
    }
}
