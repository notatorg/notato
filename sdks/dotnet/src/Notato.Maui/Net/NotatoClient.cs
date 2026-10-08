using Notato.Maui.Model;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Notato.Maui.Net;

/// <summary>A refusal from the server, or no answer at all.</summary>
public sealed class NotatoServerException(string message, int status, Exception? inner = null) : Exception(message, inner)
{
    /// <summary>0 when the server could not be reached.</summary>
    public int Status { get; } = status;

    /// <summary>The server understood and said no: sending the same thing again would fail the same way.</summary>
    public bool Permanent => Status is >= 400 and < 500 and not 408 and not 429;

    /// <summary>
    /// The server turned down what was sent, not who sent it or when (400, 409, 413, 415, 422): a note answered this
    /// way is never accepted, so it is set aside and the notes after it are still sent. Every other failure (no
    /// credential, an unknown project, too many requests, a server error, no answer) can pass, so the note waits.
    /// </summary>
    public bool Rejected => Status is 400 or 409 or 413 or 415 or 422;
}

/// <summary>One server-sent event.</summary>
public readonly record struct ServerSentEvent(string Event, string Data);

/// <summary>What the server said to a note sent to it: its copy, and whether this send made it (201) or it had one already (200).</summary>
internal readonly record struct PostedAnnotation(StoredAnnotation Stored, bool Created);

/// <summary>
/// The Notato HTTP API (packages/server/src/http.ts): post annotations with their screenshots, read them back, follow
/// changes over server-sent events, and act on them as the person.
/// </summary>
public sealed class NotatoClient
{
    /// <summary>How long the server has to start answering. Sending a large body adds to it (see <see cref="UploadTimeout"/>).</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long an answer's body may stop coming. There is no limit on the whole of it: a long list on a slow
    /// connection takes the time it takes, page by page, as long as it keeps coming.
    /// </summary>
    internal static readonly TimeSpan BodyIdleTimeout = TimeSpan.FromSeconds(30);

    /// <summary>The slowest upload allowed for before the server must answer: 50 KB a second.</summary>
    private const double SlowestUploadBytesPerSecond = 50_000;

    /// <summary>
    /// How long the event stream may stay silent. The server sends a keep-alive every 15 s, so three missed ones mean
    /// the connection is gone even if nothing said so (a phone that changed networks, a sleeping laptop).
    /// </summary>
    internal static readonly TimeSpan EventsIdleTimeout = TimeSpan.FromSeconds(45);

    /// <summary>The most a list asks for at once; the server pages past it.</summary>
    internal const int PageSize = 500;

    private readonly HttpClient _http;
    private readonly string? _token;

    public NotatoClient(HttpClient http, string baseUrl, string? token)
    {
        _http = http;
        BaseUrl = baseUrl.TrimEnd('/');
        _devTunnel = Uri.TryCreate(BaseUrl, UriKind.Absolute, out Uri? uri) && uri.Host.EndsWith(".devtunnels.ms", StringComparison.OrdinalIgnoreCase);
        _token = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
    }

    public string BaseUrl { get; }

    private readonly bool _devTunnel;

    private static string Segment(string value) => Uri.EscapeDataString(value);

    private HttpRequestMessage Request(HttpMethod method, string path, HttpContent? content = null)
    {
        HttpRequestMessage request = new(method, BaseUrl + path) { Content = content };
        if (_token is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        }
        // A dev tunnel with anonymous access puts a warning page in front of what looks like a browser; this is not one.
        if (_devTunnel)
        {
            request.Headers.TryAddWithoutValidation("X-Tunnel-Skip-AntiPhishing-Page", "true");
        }

        return request;
    }

    /// <summary>The time to allow for sending <paramref name="bytes"/> and having the server start to answer.</summary>
    internal static TimeSpan UploadTimeout(long bytes) => RequestTimeout + TimeSpan.FromSeconds(bytes / SlowestUploadBytesPerSecond);

    /// <summary>
    /// Sends the request and waits for the answer's headers only, for <paramref name="headerTimeout"/> at most (30 s
    /// unless given). The body is read afterwards, with an idle timeout (<see cref="ReadAsync"/>); the event stream
    /// has its own.
    /// </summary>
    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct, TimeSpan? headerTimeout = null)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(headerTimeout ?? RequestTimeout);

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new NotatoServerException($"The Notato server at {BaseUrl} did not answer in time.", 0);
        }
        catch (HttpRequestException error)
        {
            throw new NotatoServerException(Unreachable(error), 0, error);
        }
        if (response.IsSuccessStatusCode)
        {
            return response;
        }

        using (response)
        {
            string? detail = null;
            try
            {
                using CancellationTokenSource reading = CancellationTokenSource.CreateLinkedTokenSource(ct);
                reading.CancelAfter(RequestTimeout);
                string body = await response.Content.ReadAsStringAsync(reading.Token).ConfigureAwait(false);
                detail = JsonSerializer.Deserialize(body, NotatoJsonContext.Default.ErrorBody)?.Error;
            }
            catch
            {
                // not JSON, or not all of it came: the status says enough
            }
            throw new NotatoServerException(detail ?? $"The server answered {(int)response.StatusCode} {response.ReasonPhrase}.", (int)response.StatusCode);
        }
    }

    private string Unreachable(HttpRequestException error)
    {
        string detail = error.InnerException?.Message ?? "";
        // Android refuses plain http unless the app allows it; say what to change rather than "connection failed".
        if ($"{error.Message} {detail}".Contains("cleartext", StringComparison.OrdinalIgnoreCase))
        {
            return $"Android blocked plain http to {BaseUrl}. Allow cleartext traffic for this host in the app (see the Notato MAUI README).";
        }

        if ($"{error.Message} {detail}".Contains("App Transport Security", StringComparison.OrdinalIgnoreCase))
        {
            return $"iOS App Transport Security blocked {BaseUrl}. Add NSAllowsLocalNetworking to Info.plist (see the Notato MAUI README).";
        }
        // The platform's own message, not its whole error dump (iOS's runs to a dozen lines).
        string reason = error.Message;
        if (reason.Length > 140 || reason.Contains("Error Domain=", StringComparison.Ordinal))
        {
            reason = ShortReason(reason);
        }

        return $"Cannot reach the Notato server at {BaseUrl}: {reason}";
    }

    private static string ShortReason(string message)
    {
        int described = message.IndexOf("NSLocalizedDescription=", StringComparison.Ordinal);
        if (described >= 0)
        {
            string rest = message[(described + "NSLocalizedDescription=".Length)..];
            int end = rest.IndexOfAny([',', '}']);
            return (end < 0 ? rest : rest[..end]).Trim();
        }
        Match quoted = System.Text.RegularExpressions.Regex.Match(message, "\"([^\"]{4,120})\"");
        if (quoted.Success)
        {
            return quoted.Groups[1].Value;
        }

        return message.Length > 140 ? message[..139] + "…" : message;
    }

    /// <summary>Reads an answer's JSON as it comes, failing only if it stops coming for <see cref="BodyIdleTimeout"/>.</summary>
    private async Task<T> ReadAsync<T>(HttpResponseMessage response, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info, CancellationToken ct)
    {
        using (response)
        {
            try
            {
                await using IdleTimeoutStream stream = new(await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), BodyIdleTimeout);
                return await JsonSerializer.DeserializeAsync(stream, info, ct).ConfigureAwait(false)
                    ?? throw new NotatoServerException("The server sent an empty answer.", (int)response.StatusCode);
            }
            catch (TimeoutException error)
            {
                throw new NotatoServerException($"The Notato server at {BaseUrl} stopped answering part way through.", 0, error);
            }
            catch (IOException error) when (!ct.IsCancellationRequested)
            {
                throw new NotatoServerException($"Lost the Notato server at {BaseUrl} part way through an answer: {error.Message}", 0, error);
            }
        }
    }

    private static StringContent Json<T>(T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info) =>
        new(JsonSerializer.Serialize(value, info), Encoding.UTF8, "application/json");

    /// <summary>What a client must know before capturing: whether screenshots are allowed.</summary>
    public async Task<ServerConfig> GetConfigAsync(CancellationToken ct = default) =>
        await ReadAsync(await SendAsync(Request(HttpMethod.Get, "/config"), ct).ConfigureAwait(false), NotatoJsonContext.Default.ServerConfig, ct).ConfigureAwait(false);

    public async Task<AuthMe> GetMeAsync(CancellationToken ct = default) =>
        await ReadAsync(await SendAsync(Request(HttpMethod.Get, "/auth/me"), ct).ConfigureAwait(false), NotatoJsonContext.Default.AuthMe, ct).ConfigureAwait(false);

    /// <summary>The multipart form the server ingests: the annotation as JSON, and each screenshot as an <c>asset:&lt;id&gt;</c> file.</summary>
    internal static MultipartFormDataContent AnnotationForm(Annotation annotation, IReadOnlyDictionary<string, byte[]> assets) =>
        AnnotationForm(annotation, id => assets.TryGetValue(id, out byte[]? bytes) ? new ByteArrayContent(bytes) : null);

    /// <summary>
    /// The same form with each screenshot read from its file as it is sent (<paramref name="files"/>: a path by asset
    /// id), so it is never held in memory. A file that is gone is left out, as a missing asset always was.
    /// </summary>
    internal static MultipartFormDataContent AnnotationForm(Annotation annotation, IReadOnlyDictionary<string, string> files) =>
        AnnotationForm(annotation, id => files.TryGetValue(id, out string? path) && File.Exists(path)
            ? new StreamContent(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true))
            : null);

    private static MultipartFormDataContent AnnotationForm(Annotation annotation, Func<string, HttpContent?> asset)
    {
        MultipartFormDataContent form = [];
        StringContent json = new(JsonSerializer.Serialize(annotation, NotatoJsonContext.Default.Annotation), Encoding.UTF8);
        json.Headers.ContentType = null;
        json.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = "\"annotation\"" };
        form.Add(json);
        foreach (AssetRef? shot in new[] { annotation.Screenshots?.Full, annotation.Screenshots?.Crop })
        {
            if (shot is null || asset(shot.Id) is not { } file)
            {
                continue;
            }

            file.Headers.ContentType = new MediaTypeHeaderValue(shot.Mime);
            file.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data")
            {
                Name = $"\"asset:{shot.Id}\"",
                FileName = $"\"{shot.Id}\"",
            };
            form.Add(file);
        }
        return form;
    }

    /// <summary>Sends an annotation. Safe to repeat: the server keeps the first copy of an id.</summary>
    public async Task<StoredAnnotation> PostAnnotationAsync(Annotation annotation, IReadOnlyDictionary<string, byte[]> assets, CancellationToken ct = default)
    {
        using HttpRequestMessage request = Request(HttpMethod.Post, $"/projects/{Segment(annotation.ProjectId)}/annotations", AnnotationForm(annotation, assets));
        return await ReadAsync(await SendAsync(request, ct, UploadTimeout(assets.Values.Sum(b => (long)b.Length))).ConfigureAwait(false), NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Sends an annotation with its screenshots read from their files (a path by asset id), and says whether the server
    /// made it now (201) or had it already (200: an earlier answer was lost on the way). Safe to repeat.
    /// </summary>
    internal async Task<PostedAnnotation> PostAnnotationAsync(Annotation annotation, IReadOnlyDictionary<string, string> files, CancellationToken ct = default)
    {
        long bytes = files.Values.Sum(path => File.Exists(path) ? new FileInfo(path).Length : 0);
        // Disposed once answered, which closes the screenshots' files.
        using HttpRequestMessage request = Request(HttpMethod.Post, $"/projects/{Segment(annotation.ProjectId)}/annotations", AnnotationForm(annotation, files));
        HttpResponseMessage response = await SendAsync(request, ct, UploadTimeout(bytes)).ConfigureAwait(false);
        bool created = response.StatusCode == HttpStatusCode.Created;
        return new PostedAnnotation(await ReadAsync(response, NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false), created);
    }

    /// <summary>
    /// Every annotation of the project, oldest first: page after page until the server says there are no more. Throws
    /// if any page fails, so a caller never takes part of the list for all of it.
    /// </summary>
    public Task<IReadOnlyList<StoredAnnotation>> ListAsync(string project, CancellationToken ct = default) => ListAsync(project, summary: false, ct);

    /// <summary>
    /// Every annotation of the project, as <see cref="ListAsync(string, CancellationToken)"/>. With
    /// <paramref name="summary"/>, the server leaves out what only the agent reads (each note comes with an empty
    /// <c>context</c> and no <c>steps</c>), which makes a long list much shorter; an older server sends them whole.
    /// </summary>
    public async Task<IReadOnlyList<StoredAnnotation>> ListAsync(string project, bool summary, CancellationToken ct = default)
    {
        List<StoredAnnotation> all = [];
        long? after = null;
        while (true)
        {
            string query = $"?limit={PageSize}" + (summary ? "&fields=summary" : "") + (after is { } seq ? $"&afterSeq={seq.ToString(System.Globalization.CultureInfo.InvariantCulture)}" : "");
            AnnotationList page = await ReadAsync(await SendAsync(Request(HttpMethod.Get, $"/projects/{Segment(project)}/annotations{query}"), ct).ConfigureAwait(false), NotatoJsonContext.Default.AnnotationList, ct).ConfigureAwait(false);
            all.AddRange(page.Items);
            // An older server never sends next: its one page is the list.
            if (page.Next is not { } next)
            {
                return all;
            }

            if (after is { } previous && next <= previous)
            {
                throw new NotatoServerException($"The server's list of \"{project}\" did not move past {previous}.", 0);
            }

            after = next;
        }
    }

    public async Task<StoredAnnotation> SetStatusAsync(string id, string status, string? note, Author? author, CancellationToken ct = default)
    {
        StringContent body = Json(new StatusChange { Status = status, Note = string.IsNullOrWhiteSpace(note) ? null : note, Author = author }, NotatoJsonContext.Default.StatusChange);
        return await ReadAsync(await SendAsync(Request(HttpMethod.Patch, $"/annotations/{Segment(id)}", body), ct).ConfigureAwait(false), NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false);
    }

    /// <summary>Adds a reply to the note's thread.</summary>
    public Task<StoredAnnotation> ReplyAsync(string id, string text, Author? author, CancellationToken ct = default) =>
        ReplyAsync(id, text, author, aside: false, ct);

    /// <summary>Adds a reply to the note's thread. An <paramref name="aside"/> is for the people on the thread: the agent never gets it.</summary>
    public async Task<StoredAnnotation> ReplyAsync(string id, string text, Author? author, bool aside, CancellationToken ct = default)
    {
        StringContent body = Json(new ReplyBody { Body = text, Author = author, Aside = aside ? true : null }, NotatoJsonContext.Default.ReplyBody);
        return await ReadAsync(await SendAsync(Request(HttpMethod.Post, $"/annotations/{Segment(id)}/replies", body), ct).ConfigureAwait(false), NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Turns People only on or off for a note, as <paramref name="author"/>: the server records the change in the thread.
    /// Only a person can (anyone else gets a 403).
    /// </summary>
    public async Task<StoredAnnotation> SetPeopleOnlyAsync(string id, bool on, Author? author, CancellationToken ct = default)
    {
        StringContent body = Json(new PeopleOnlyChange { PeopleOnly = on, Author = author }, NotatoJsonContext.Default.PeopleOnlyChange);
        return await ReadAsync(await SendAsync(Request(HttpMethod.Patch, $"/annotations/{Segment(id)}", body), ct).ConfigureAwait(false), NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false);
    }

    public async Task DeleteAsync(string id, CancellationToken ct = default)
    {
        using HttpResponseMessage _ = await SendAsync(Request(HttpMethod.Delete, $"/annotations/{Segment(id)}"), ct).ConfigureAwait(false);
    }

    /// <summary>Tells the server how an annotate request relayed from <c>notato_annotate</c> went.</summary>
    public async Task PostRelayResultAsync(string requestId, RelayResult result, CancellationToken ct = default)
    {
        using HttpResponseMessage _ = await SendAsync(Request(HttpMethod.Post, $"/relay/{Segment(requestId)}/result", Json(result, NotatoJsonContext.Default.RelayResult)), ct).ConfigureAwait(false);
    }

    /// <summary>Uploads a packaged bundle zip.</summary>
    public async Task UploadBundleAsync(string project, byte[] zip, CancellationToken ct = default)
    {
        ByteArrayContent content = new(zip);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        using HttpRequestMessage request = Request(HttpMethod.Post, $"/projects/{Segment(project)}/bundles", content);
        using HttpResponseMessage _ = await SendAsync(request, ct, UploadTimeout(zip.Length)).ConfigureAwait(false);
    }

    /// <summary>Uploads a packaged bundle zip from its file, read as it is sent.</summary>
    public async Task UploadBundleAsync(string project, string path, CancellationToken ct = default)
    {
        FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, useAsync: true);
        StreamContent content = new(file);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        content.Headers.ContentLength = file.Length;
        using HttpRequestMessage request = Request(HttpMethod.Post, $"/projects/{Segment(project)}/bundles", content);
        using HttpResponseMessage _ = await SendAsync(request, ct, UploadTimeout(file.Length)).ConfigureAwait(false);
    }

    /// <summary>
    /// Follows the project's event stream until cancelled or the connection drops: <c>hello</c> first, then
    /// <c>created</c>, <c>updated</c>, <c>replied</c>, <c>deleted</c>, and (with <paramref name="agent"/>)
    /// <c>annotate-request</c>.
    /// </summary>
    public async IAsyncEnumerable<ServerSentEvent> EventsAsync(string project, bool agent, [EnumeratorCancellation] CancellationToken ct = default)
    {
        string path = $"/projects/{Segment(project)}/events{(agent ? "?agent=1" : "")}";
        HttpRequestMessage request = Request(HttpMethod.Get, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using HttpResponseMessage response = await SendAsync(request, ct).ConfigureAwait(false);
        await using Stream stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using StreamReader reader = new(stream, Encoding.UTF8);
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(reader, EventsIdleTimeout, ct).ConfigureAwait(false))
        {
            yield return e;
        }
    }
}

/// <summary>Parses the text/event-stream format: <c>event:</c> and <c>data:</c> lines, a blank line ending each event.</summary>
public static class ServerSentEvents
{
    public static IAsyncEnumerable<ServerSentEvent> ReadAsync(TextReader reader, CancellationToken ct = default) =>
        ReadAsync(reader, null, ct);

    /// <summary>
    /// Reads events until the stream ends. With <paramref name="idleTimeout"/>, a stream that sends nothing at all (not
    /// even a keep-alive comment) for that long throws <see cref="TimeoutException"/>: a connection that died without
    /// closing would otherwise be waited on for ever. The caller then closes it.
    /// </summary>
    public static async IAsyncEnumerable<ServerSentEvent> ReadAsync(TextReader reader, TimeSpan? idleTimeout, [EnumeratorCancellation] CancellationToken ct = default)
    {
        string type = "message";
        StringBuilder data = new();
        while (!ct.IsCancellationRequested)
        {
            string? line = await ReadLineAsync(reader, idleTimeout, ct).ConfigureAwait(false);
            if (line is null)
            {
                yield break;
            }

            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    yield return new ServerSentEvent(type, data.ToString());
                }

                type = "message";
                data.Clear();
                continue;
            }
            if (line[0] == ':')
            {
                continue; // a comment, such as the keep-alive ping
            }

            int colon = line.IndexOf(':');
            string field = colon < 0 ? line : line[..colon];
            string value = colon < 0 ? "" : line[(colon + 1)..];
            if (value.StartsWith(' '))
            {
                value = value[1..];
            }

            if (field == "event")
            {
                type = value;
            }
            else if (field == "data")
            {
                if (data.Length > 0)
                {
                    data.Append('\n');
                }

                data.Append(value);
            }
        }
    }

    private static async Task<string?> ReadLineAsync(TextReader reader, TimeSpan? idleTimeout, CancellationToken ct)
    {
        if (idleTimeout is not { } limit)
        {
            return await reader.ReadLineAsync(ct).ConfigureAwait(false);
        }

        using CancellationTokenSource quiet = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task<string?> read = reader.ReadLineAsync(quiet.Token).AsTask();
        Task idle = Task.Delay(limit, quiet.Token);
        // Not every platform's network stream stops a read when asked to, so the wait is raced rather than cancelled.
        if (await Task.WhenAny(read, idle).ConfigureAwait(false) == read)
        {
            await quiet.CancelAsync().ConfigureAwait(false);
            return await read.ConfigureAwait(false);
        }

        await quiet.CancelAsync().ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        // The read ends when the caller closes the stream; what it ends with no longer matters.
        _ = read.ContinueWith(static t => _ = t.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        throw new TimeoutException($"The server sent nothing for {limit.TotalSeconds:0} s, not even a keep-alive.");
    }
}
