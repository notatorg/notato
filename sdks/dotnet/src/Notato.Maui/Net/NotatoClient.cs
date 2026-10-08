using Notato.Maui.Model;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;

namespace Notato.Maui.Net;

/// <summary>A refusal from the Notato server, or no answer at all.</summary>
/// <param name="message">What went wrong, fit to show to a person: the server's own reason when it gave one.</param>
/// <param name="status">The HTTP status the server answered with, or 0 when it could not be reached.</param>
/// <param name="inner">The error underneath, if any.</param>
public sealed class NotatoServerException(string message, int status, Exception? inner = null) : Exception(message, inner)
{
    /// <summary>The HTTP status the server answered with; 0 when it could not be reached.</summary>
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
internal readonly record struct ServerSentEvent(string Event, string Data);

/// <summary>What the server said to a note sent to it: its copy, and whether this send made it (201) or it had one already (200).</summary>
internal readonly record struct PostedAnnotation(StoredAnnotation Stored, bool Created);

/// <summary>
/// The Notato HTTP API (packages/server/src/http.ts): post annotations with their screenshots, read them back, follow
/// changes over server-sent events, and act on them as the person.
/// </summary>
internal sealed class NotatoClient
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

    /// <summary>Screenshots and bundles are read from their files in pieces this big as they are sent.</summary>
    private const int FileBufferSize = 64 * 1024;

    private readonly HttpClient _http;
    private readonly string? _token;
    /// <summary>A dev tunnel's address: it needs a header to skip its warning page.</summary>
    private readonly bool _devTunnel;

    public NotatoClient(HttpClient http, string baseUrl, string? token)
    {
        _http = http;
        BaseUrl = baseUrl.TrimEnd('/');
        _devTunnel = Uri.TryCreate(BaseUrl, UriKind.Absolute, out Uri? uri) && uri.Host.EndsWith(".devtunnels.ms", StringComparison.OrdinalIgnoreCase);
        _token = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
    }

    public string BaseUrl { get; }

    /// <summary>The time to allow for sending <paramref name="bytes"/> and having the server start to answer.</summary>
    internal static TimeSpan UploadTimeout(long bytes) => RequestTimeout + TimeSpan.FromSeconds(bytes / SlowestUploadBytesPerSecond);

    // ---- the API ----------------------------------------------------------------------------------------------------

    /// <summary>What a client must know before capturing: whether screenshots are allowed, and what <c>@</c> can call.</summary>
    public Task<ServerConfig> GetConfigAsync(CancellationToken ct = default) =>
        ReadAsync(Request(HttpMethod.Get, "/config"), NotatoJsonContext.Default.ServerConfig, ct);

    /// <summary>
    /// Sends an annotation with its screenshots read from their files (a path by asset id), and says whether the server
    /// made it now (201) or had it already (200: an earlier answer was lost on the way). Safe to repeat: the server keeps
    /// the first copy of an id.
    /// </summary>
    public async Task<PostedAnnotation> PostAnnotationAsync(Annotation annotation, IReadOnlyDictionary<string, string> files, CancellationToken ct = default)
    {
        long bytes = files.Values.Sum(path => File.Exists(path) ? new FileInfo(path).Length : 0);
        // Disposed once answered, which closes the screenshots' files.
        using HttpRequestMessage request = Request(HttpMethod.Post, $"/projects/{Segment(annotation.ProjectId)}/annotations", AnnotationForm(annotation, files));
        HttpResponseMessage response = await SendAsync(request, ct, UploadTimeout(bytes)).ConfigureAwait(false);
        bool created = response.StatusCode == HttpStatusCode.Created;
        return new PostedAnnotation(await ReadBodyAsync(response, NotatoJsonContext.Default.StoredAnnotation, ct).ConfigureAwait(false), created);
    }

    /// <summary>
    /// Every annotation of the project, oldest first: page after page until the server says there are no more. Throws
    /// if any page fails, so a caller never takes part of the list for all of it. With <paramref name="summary"/>, the
    /// server leaves out what only the agent reads (each note comes with an empty <c>context</c> and no <c>steps</c>),
    /// which makes a long list much shorter; an older server sends them whole.
    /// </summary>
    public async Task<IReadOnlyList<StoredAnnotation>> ListAsync(string project, bool summary = false, CancellationToken ct = default)
    {
        List<StoredAnnotation> all = [];
        long? after = null;
        while (true)
        {
            string query = $"?limit={PageSize}"
                + (summary ? "&fields=summary" : "")
                + (after is { } seq ? "&afterSeq=" + seq.ToString(CultureInfo.InvariantCulture) : "");
            AnnotationList page = await ReadAsync(Request(HttpMethod.Get, $"/projects/{Segment(project)}/annotations{query}"), NotatoJsonContext.Default.AnnotationList, ct).ConfigureAwait(false);
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

    /// <summary>Moves a note to <paramref name="status"/>, as <paramref name="author"/>, with a line in its thread.</summary>
    public Task<StoredAnnotation> SetStatusAsync(string id, string status, string? note, Author? author, CancellationToken ct = default)
    {
        StatusChange change = new() { Status = status, Note = string.IsNullOrWhiteSpace(note) ? null : note, Author = author };
        return ReadAsync(Request(HttpMethod.Patch, $"/annotations/{Segment(id)}", Json(change, NotatoJsonContext.Default.StatusChange)), NotatoJsonContext.Default.StoredAnnotation, ct);
    }

    /// <summary>Adds a reply to the note's thread. An <paramref name="aside"/> is for the people on the thread: the agent never gets it.</summary>
    public Task<StoredAnnotation> ReplyAsync(string id, string text, Author? author, bool aside = false, CancellationToken ct = default)
    {
        ReplyBody reply = new() { Body = text, Author = author, Aside = aside ? true : null };
        return ReadAsync(Request(HttpMethod.Post, $"/annotations/{Segment(id)}/replies", Json(reply, NotatoJsonContext.Default.ReplyBody)), NotatoJsonContext.Default.StoredAnnotation, ct);
    }

    /// <summary>
    /// Turns People only on or off for a note, as <paramref name="author"/>: the server records the change in the thread.
    /// Only a person can (anyone else gets a 403).
    /// </summary>
    public Task<StoredAnnotation> SetPeopleOnlyAsync(string id, bool on, Author? author, CancellationToken ct = default)
    {
        PeopleOnlyChange change = new() { PeopleOnly = on, Author = author };
        return ReadAsync(Request(HttpMethod.Patch, $"/annotations/{Segment(id)}", Json(change, NotatoJsonContext.Default.PeopleOnlyChange)), NotatoJsonContext.Default.StoredAnnotation, ct);
    }

    public Task DeleteAsync(string id, CancellationToken ct = default) =>
        SendOnlyAsync(Request(HttpMethod.Delete, $"/annotations/{Segment(id)}"), ct);

    /// <summary>Tells the server how an annotate request relayed from <c>notato_annotate</c> went.</summary>
    public Task PostRelayResultAsync(string requestId, RelayResult result, CancellationToken ct = default) =>
        SendOnlyAsync(Request(HttpMethod.Post, $"/relay/{Segment(requestId)}/result", Json(result, NotatoJsonContext.Default.RelayResult)), ct);

    /// <summary>Uploads a packaged bundle zip from its file, read as it is sent.</summary>
    public async Task UploadBundleAsync(string project, string path, CancellationToken ct = default)
    {
        FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileBufferSize, useAsync: true);
        StreamContent content = new(file);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        content.Headers.ContentLength = file.Length;
        await SendOnlyAsync(Request(HttpMethod.Post, $"/projects/{Segment(project)}/bundles", content), ct, UploadTimeout(file.Length)).ConfigureAwait(false);
    }

    /// <summary>
    /// Follows the project's event stream until cancelled or the connection drops: <c>hello</c> first, then
    /// <c>created</c>, <c>updated</c>, <c>replied</c>, <c>deleted</c>, <c>mentions</c>, <c>agent</c>, and (with
    /// <paramref name="agent"/>) <c>annotate-request</c>.
    /// </summary>
    public async IAsyncEnumerable<ServerSentEvent> EventsAsync(string project, bool agent, [EnumeratorCancellation] CancellationToken ct = default)
    {
        using HttpRequestMessage request = Request(HttpMethod.Get, $"/projects/{Segment(project)}/events{(agent ? "?agent=1" : "")}");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using HttpResponseMessage response = await SendAsync(request, ct).ConfigureAwait(false);
        await using Stream stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using StreamReader reader = new(stream, Encoding.UTF8);
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(reader, EventsIdleTimeout, ct).ConfigureAwait(false))
        {
            yield return e;
        }
    }

    // ---- the multipart form a note is sent as -----------------------------------------------------------------------

    /// <summary>
    /// The multipart form the server ingests: the annotation as JSON, and each screenshot as an <c>asset:&lt;id&gt;</c>
    /// file read from its file as it is sent (<paramref name="files"/>: a path by asset id), so it is never held in
    /// memory. A file that is gone is left out.
    /// </summary>
    internal static MultipartFormDataContent AnnotationForm(Annotation annotation, IReadOnlyDictionary<string, string> files)
    {
        MultipartFormDataContent form = [];
        StringContent json = new(JsonSerializer.Serialize(annotation, NotatoJsonContext.Default.Annotation), Encoding.UTF8);
        json.Headers.ContentType = null;
        json.Headers.ContentDisposition = new ContentDispositionHeaderValue("form-data") { Name = "\"annotation\"" };
        form.Add(json);
        foreach (AssetRef? shot in new[] { annotation.Screenshots?.Full, annotation.Screenshots?.Crop })
        {
            if (shot is null || !files.TryGetValue(shot.Id, out string? path) || !File.Exists(path))
            {
                continue;
            }

            StreamContent file = new(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, FileBufferSize, useAsync: true));
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

    // ---- requests and answers ---------------------------------------------------------------------------------------

    private static string Segment(string value) => Uri.EscapeDataString(value);

    private static StringContent Json<T>(T value, JsonTypeInfo<T> info) =>
        new(JsonSerializer.Serialize(value, info), Encoding.UTF8, "application/json");

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

    /// <summary>Sends <paramref name="request"/> (and disposes it) and reads the answer's JSON.</summary>
    private async Task<T> ReadAsync<T>(HttpRequestMessage request, JsonTypeInfo<T> info, CancellationToken ct)
    {
        using (request)
        {
            return await ReadBodyAsync(await SendAsync(request, ct).ConfigureAwait(false), info, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Sends <paramref name="request"/> (and disposes it) for its effect: the answer only has to be a success.</summary>
    private async Task SendOnlyAsync(HttpRequestMessage request, CancellationToken ct, TimeSpan? headerTimeout = null)
    {
        using (request)
        {
            using HttpResponseMessage _ = await SendAsync(request, ct, headerTimeout).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Sends the request and waits for the answer's headers only, for <paramref name="headerTimeout"/> at most (30 s
    /// unless given). The body is read afterwards, with an idle timeout (<see cref="ReadBodyAsync"/>); the event stream
    /// has its own. An answer that is not a success throws, with the server's reason when it gave one.
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
                // Not JSON, or not all of it came: the status says enough.
            }

            throw new NotatoServerException(detail ?? $"The server answered {(int)response.StatusCode} {response.ReasonPhrase}.", (int)response.StatusCode);
        }
    }

    /// <summary>Reads an answer's JSON as it comes, failing only if it stops coming for <see cref="BodyIdleTimeout"/>.</summary>
    private async Task<T> ReadBodyAsync<T>(HttpResponseMessage response, JsonTypeInfo<T> info, CancellationToken ct)
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

    /// <summary>Why the server could not be reached, in a line a person can act on.</summary>
    private string Unreachable(HttpRequestException error)
    {
        string said = $"{error.Message} {error.InnerException?.Message}";
        // Android refuses plain http unless the app allows it; say what to change rather than "connection failed".
        if (said.Contains("cleartext", StringComparison.OrdinalIgnoreCase))
        {
            return $"Android blocked plain http to {BaseUrl}. Allow cleartext traffic for this host in the app (see the Notato MAUI README).";
        }

        if (said.Contains("App Transport Security", StringComparison.OrdinalIgnoreCase))
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
        const string described = "NSLocalizedDescription=";
        int at = message.IndexOf(described, StringComparison.Ordinal);
        if (at >= 0)
        {
            string rest = message[(at + described.Length)..];
            int end = rest.IndexOfAny([',', '}']);
            return (end < 0 ? rest : rest[..end]).Trim();
        }

        Match quoted = Regex.Match(message, "\"([^\"]{4,120})\"");
        if (quoted.Success)
        {
            return quoted.Groups[1].Value;
        }

        return message.Length > 140 ? message[..139] + "…" : message;
    }
}

/// <summary>Parses the text/event-stream format: <c>event:</c> and <c>data:</c> lines, a blank line ending each event.</summary>
internal static class ServerSentEvents
{
    /// <summary>
    /// Reads events until the stream ends. With <paramref name="idleTimeout"/>, a stream that sends nothing at all (not
    /// even a keep-alive comment) for that long throws <see cref="TimeoutException"/>: a connection that died without
    /// closing would otherwise be waited on for ever. The caller then closes it.
    /// </summary>
    public static async IAsyncEnumerable<ServerSentEvent> ReadAsync(TextReader reader, TimeSpan? idleTimeout = null, [EnumeratorCancellation] CancellationToken ct = default)
    {
        Func<CancellationToken, ValueTask<string?>> readLine = reader.ReadLineAsync;
        if (idleTimeout is { } limit)
        {
            string stalled = $"The server sent nothing for {limit.TotalSeconds:0} s, not even a keep-alive.";
            readLine = token => new ValueTask<string?>(IdleTimeout.ReadAsync(reader.ReadLineAsync, limit, stalled, token));
        }

        string type = "message";
        StringBuilder data = new();
        while (!ct.IsCancellationRequested)
        {
            string? line = await readLine(ct).ConfigureAwait(false);
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

            // A comment, such as the keep-alive ping.
            if (line[0] == ':')
            {
                continue;
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
}
