using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;

namespace Notato.Maui.Tests;

/// <summary>The HTTP API: what is sent, how answers and failures are read, and uploads.</summary>
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
        string folder = Directory.CreateTempSubdirectory("notato-form-").FullName;
        try
        {
            Annotation annotation = Fixtures.Annotation();
            Dictionary<string, string> files = new()
            {
                [new string('a', 64)] = Path.Combine(folder, "full.png"),
                [new string('b', 64)] = Path.Combine(folder, "crop.png"),
            };
            foreach (string file in files.Values)
            {
                await File.WriteAllBytesAsync(file, [137, 80, 78, 71]);
            }

            Recorder handler = new(_ => Fixtures.Stored(HttpStatusCode.Created, annotation, 7));
            NotatoClient client = new(new HttpClient(handler), "http://localhost:4747/", "pft_secret");

            PostedAnnotation result = await client.PostAnnotationAsync(annotation, files);

            Assert.Equal(7, result.Stored.Seq);
            (HttpRequestMessage request, string body) = Assert.Single(handler.Seen);
            Assert.Equal("http://localhost:4747/projects/maui-sample/annotations", request.RequestUri!.ToString());
            Assert.Equal("Bearer pft_secret", request.Headers.Authorization!.ToString());
            Assert.StartsWith("multipart/form-data", request.Content!.Headers.ContentType!.ToString());
            Assert.Contains("name=\"annotation\"", body);
            Assert.Contains($"name=\"asset:{new string('a', 64)}\"", body);
            Assert.Contains($"name=\"asset:{new string('b', 64)}\"", body);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
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
            return JsonSerializer.Serialize(new AnnotationList { Items = items, Next = next }, NotatoJsonContext.Default.AnnotationList);
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
        ServerConfig? config = await JsonSerializer.DeserializeAsync(steady, NotatoJsonContext.Default.ServerConfig);
        Assert.False(config!.Screenshots);

        IdleTimeoutStream stalled = new(new Trickle(10, TimeSpan.FromMilliseconds(10), stall: true), limit);
        Task<ServerConfig?> reading = JsonSerializer.DeserializeAsync(stalled, NotatoJsonContext.Default.ServerConfig).AsTask();
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
            using (ZipArchive zip = ZipFile.OpenRead(path))
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
    public void Sizes_read_as_megabytes(long bytes, string expected) => Assert.Equal(expected, MenuText.Megabytes(bytes));

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
