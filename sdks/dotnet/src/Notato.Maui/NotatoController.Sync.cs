using Microsoft.Extensions.Logging;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Networking;
using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace Notato.Maui;

// The connection to the server: its event stream, followed for as long as Notato is on (connecting again after a
// failure, waiting longer each time), what the server says it allows, and what the toolbar shows of it.
internal sealed partial class NotatoController
{
    /// <summary>The first wait before connecting again; it doubles after each failure, up to <see cref="MaxReconnectDelay"/>.</summary>
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(1);

    private static readonly TimeSpan MaxReconnectDelay = TimeSpan.FromSeconds(10);

    /// <summary>The wait after the server refused this app: trying again sooner would only be refused again.</summary>
    private static readonly TimeSpan RefusedDelay = TimeSpan.FromSeconds(30);

    /// <summary>How old the server's word on screenshots may be before a screenshot asks again, and how long it waits.</summary>
    private static readonly TimeSpan PolicyFresh = TimeSpan.FromSeconds(5);

    private static readonly TimeSpan PolicyWait = TimeSpan.FromSeconds(1.5);

    /// <summary>Capture-only: how often the server is asked again, there being no stream to say that it went.</summary>
    private static readonly TimeSpan SendOnlyCheck = TimeSpan.FromSeconds(30);

    /// <summary>What a capture-only app says when asked to read or change a note it sent.</summary>
    internal const string OnTheBoard = "This app can only send notes: read, reply to and change them on the Notato board.";

    private NotatoClient? _client;
    /// <summary>Stops the sync loop that is running, and everything it planned.</summary>
    private CancellationTokenSource? _sync;
    private NotatoConnection _connection = NotatoConnection.Disabled;
    private string? _connectionDetail;
    /// <summary>How the last try at the server ended, while it keeps failing: offline or refused; null once it works.</summary>
    private NotatoConnection? _lastFailure;
    /// <summary>The menu's Retry is under way.</summary>
    private bool _retrying;
    /// <summary>
    /// Whether the server takes screenshots, as it last said (<c>/config</c>): asked before its stream is opened, on each
    /// connection, and again before a screenshot. Null until it answers, and until then none is taken.
    /// </summary>
    private bool? _serverScreenshots;
    private bool _serverDerivedScreenshots;
    /// <summary>The server takes new notes from this app and nothing else (a capture-only token).</summary>
    private bool _captureOnly;
    /// <summary>When the server was last asked what it allows, answered or not. Main thread.</summary>
    private DateTime _askedAt;
    private List<MentionInfo> _mentions = [];
    private AgentState _agentState = new();

    public NotatoConnection Connection => _connection;

    public string? ConnectionDetail => _connectionDetail ?? _invalid;

    /// <summary>The connection as the toolbar and its menu show it (see <see cref="MenuText.Shown"/>).</summary>
    internal NotatoConnection ShownConnection => MenuText.Shown(_connection, _lastFailure, _retrying);

    /// <summary>The server could not be reached (or refused this app) the last time it was tried: the menu says so.</summary>
    internal NotatoConnection? Unreachable => _enabled && HasServer ? _lastFailure : null;

    /// <summary>The menu's Retry is trying the server now.</summary>
    internal bool Retrying => _retrying;

    /// <summary>Whether the server has said it takes screenshots: it can turn them off for everyone.</summary>
    public bool ServerScreenshotsAllowed => _serverScreenshots == true;

    /// <summary>The server takes new notes from this app and nothing else: replies, status and deleting are on the board.</summary>
    internal bool CaptureOnly => _captureOnly && Server is not null;

    /// <summary>
    /// Screenshots are taken: this person wants them and, when there is a server (test mode's too), it has said it takes
    /// them. With no server at all, they stay on the device and the person decides.
    /// </summary>
    private bool ScreenshotsOn => ScreenshotsWanted && (Server is null || _serverScreenshots == true);

    /// <summary>What <c>@</c> can call now: the server's mention plugins, of which there are none unless the server adds some.</summary>
    internal IReadOnlyList<MentionInfo> AvailableMentions =>
        _connection == NotatoConnection.Connected ? _mentions.Where(m => m.Available).ToList() : [];

    /// <summary>Whether an agent has Notato's MCP open, as the server last said.</summary>
    internal AgentState Agent => _agentState;

    private void SetMentions(List<MentionInfo>? next, AgentState? agent)
    {
        bool changed = false;
        if (next is not null && !next.SequenceEqual(_mentions))
        {
            _mentions = next;
            changed = true;
        }

        if (agent is not null && agent != _agentState)
        {
            _agentState = agent;
            changed = true;
        }

        if (changed)
        {
            RaiseChanged();
        }
    }

    /// <summary>The menu's Retry: try the server again now, rather than when the wait between tries runs out.</summary>
    internal void RetryConnection()
    {
        if (!_enabled || !HasServer || _retrying)
        {
            return;
        }

        _retrying = true;
        StartSync();
        RaiseChanged();
    }

    private void StartSync()
    {
        StopSync();
        // A new server (or none) starts afresh; Retry tries the same one again, which is still failing until it works.
        if (!_retrying)
        {
            _lastFailure = null;
        }

        string? server = Server;
        if (!HasServer)
        {
            // Test mode with a server set still uploads its packages there, and asks it whether to take screenshots.
            _client = server is null ? null : new NotatoClient(_http, server, Options.TokenFor(server));
            SetConnection(NotatoConnection.Local, Mode == NotatoMode.Test ? null : "No server is set: notes stay on this device.");
            if (_client is { } asked)
            {
                _sync = new CancellationTokenSource();
                _ = AskServerAsync(asked, _sync.Token);
            }

            return;
        }

        _client = new NotatoClient(_http, server!, Options.TokenFor(server));
        _sync = new CancellationTokenSource();
        CancellationToken token = _sync.Token;
        NotatoClient client = _client;
        _ = Task.Run(() => SyncLoopAsync(client, token));
        try
        {
            Connectivity.Current.ConnectivityChanged += OnConnectivity;
        }
        catch (NotImplementedException)
        {
            // Plain net10.0 (an app's unit tests) cannot tell when the network comes back: the sync loop still retries.
        }
    }

    private void StopSync()
    {
        // What a server allowed is that server's: the next one (or the same one, asked again) says for itself.
        _serverScreenshots = null;
        _serverDerivedScreenshots = false;
        _captureOnly = false;
        _askedAt = default;
        _sync?.Cancel();
        _sync?.Dispose();
        _sync = null;
        _retryPlanned = false;
        _retries = 0;
        // What the stopped loop heard and had not passed on yet is of the last server.
        lock (_eventsGate)
        {
            _events.Clear();
        }

        try
        {
            Connectivity.Current.ConnectivityChanged -= OnConnectivity;
        }
        catch
        {
            // Not available on plain net10.0.
        }
    }

    private void OnConnectivity(object? sender, ConnectivityChangedEventArgs e)
    {
        if (e.NetworkAccess == NetworkAccess.Internet)
        {
            _ = FlushAsync();
        }
    }

    private async Task SyncLoopAsync(NotatoClient client, CancellationToken token)
    {
        TimeSpan delay = ReconnectDelay;
        while (!token.IsCancellationRequested)
        {
            try
            {
                DispatchFor(token, () => SetConnection(NotatoConnection.Connecting, null));
                // What the server allows comes first: a capture-only token may not open the stream at all.
                if (await AskServerAsync(client, token).ConfigureAwait(false) is { CaptureOnly: true })
                {
                    await OnSendOnlyAsync(client, token).ConfigureAwait(false);
                    delay = ReconnectDelay;
                    // Nothing comes from the server to follow, so it is asked again now and then instead: that is how a
                    // lost connection shows, and a token that may do more now.
                    ServerConfig? again;
                    do
                    {
                        await Task.Delay(SendOnlyCheck, token).ConfigureAwait(false);
                        again = await AskServerAsync(client, token).ConfigureAwait(false);
                    }
                    while (again is { CaptureOnly: true });

                    if (again is not null)
                    {
                        continue;
                    }

                    DispatchFor(token, () => SetConnection(NotatoConnection.Offline, $"Cannot reach the server at {client.BaseUrl}."));
                }
                else
                {
                    await foreach (ServerSentEvent e in client.EventsAsync(Options.Project, agent: Mode == NotatoMode.Agent, token).ConfigureAwait(false))
                    {
                        await OnServerEventAsync(client, e, token).ConfigureAwait(false);
                        delay = ReconnectDelay;
                    }

                    if (token.IsCancellationRequested)
                    {
                        return;
                    }

                    DispatchFor(token, () => SetConnection(NotatoConnection.Offline, "The server closed the connection."));
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (NotatoServerException error) when (error.Permanent)
            {
                DispatchFor(token, () => SetConnection(NotatoConnection.Refused, error.Message));
                delay = RefusedDelay;
            }
            catch (Exception error)
            {
                string message = error is NotatoServerException ? error.Message : $"Lost the server at {client.BaseUrl}: {error.Message}";
                DispatchFor(token, () => SetConnection(NotatoConnection.Offline, message));
            }

            try
            {
                await Task.Delay(delay, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            delay = TimeSpan.FromTicks(Math.Min(MaxReconnectDelay.Ticks, delay.Ticks * 2));
        }
    }

    /// <summary>One event from the server's stream (see <see cref="NotatoClient.EventsAsync"/>).</summary>
    internal async Task OnServerEventAsync(NotatoClient client, ServerSentEvent e, CancellationToken token)
    {
        switch (e.Event)
        {
            case "hello":
                await OnConnectedAsync(client, token).ConfigureAwait(false);
                break;
            case "created" or "updated" or "replied":
                if (Parse(e.Data, NotatoJsonContext.Default.ServerEventData)?.Annotation is { } annotation)
                {
                    QueueEvent(new QueuedEvent(annotation, null, token));
                }

                break;
            case "deleted":
                if (Parse(e.Data, NotatoJsonContext.Default.ServerEventData)?.Id is { } id)
                {
                    QueueEvent(new QueuedEvent(null, id, token));
                }

                break;
            case "mentions":
                if (Parse(e.Data, NotatoJsonContext.Default.ListMentionInfo) is { } mentions)
                {
                    DispatchFor(token, () => SetMentions(mentions, null));
                }

                break;
            case "agent":
                if (Parse(e.Data, NotatoJsonContext.Default.AgentState) is { } agent)
                {
                    DispatchFor(token, () => SetMentions(null, agent));
                }

                break;
            case "annotate-request":
                // One that cannot be read is timed out by the server.
                if (Parse(e.Data, NotatoJsonContext.Default.AnnotateRequest) is { } request)
                {
                    _ = AnswerRelayAsync(client, request);
                }

                break;
        }
    }

    /// <summary>
    /// The stream is open: what the server allows is read, the notes waiting here are sent, and then the project's
    /// notes are read, page by page, and put in place.
    /// </summary>
    private async Task OnConnectedAsync(NotatoClient client, CancellationToken token)
    {
        DispatchFor(token, () => SetConnection(NotatoConnection.Connected, null));
        await AskServerAsync(client, token).ConfigureAwait(false);

        // What an earlier connection heard goes in before the list, which is newer.
        await OnMain(DrainEvents).ConfigureAwait(false);
        // The notes waiting here go first: they reach the agent without waiting behind a long list, and the list asked
        // for afterwards has them.
        await FlushAsync(client).ConfigureAwait(false);
        // Only notes the server had already taken when the list was asked for can be missing from it because they were
        // deleted; a note sent or made since is newer than the list.
        HashSet<string> settled = await OnMain(_records.SettledIds).ConfigureAwait(false);
        // Every page, or (if one fails) nothing: the connection then starts again and nothing is dropped. Only what the
        // toolbar shows: the board and the agent read the rest from the server.
        IReadOnlyList<StoredAnnotation> items = await client.ListAsync(Options.Project, summary: true, token).ConfigureAwait(false);
        // Sorted out here, off the main thread; the main thread only puts it in place.
        ServerList listed = new(items, Options.Project);
        DispatchFor(token, () => Merge(listed, settled, client));
    }

    /// <summary>
    /// A capture-only token: the server takes new notes from this app and nothing else (no stream, no list). The notes
    /// waiting here are sent now; one that cannot go is tried again later (<see cref="RetryFlushLater"/>).
    /// </summary>
    internal async Task OnSendOnlyAsync(NotatoClient client, CancellationToken token)
    {
        DispatchFor(token, () => SetConnection(NotatoConnection.Connected, null));
        await FlushAsync(client).ConfigureAwait(false);
    }

    /// <summary>
    /// Asks the server what it allows (<c>/config</c>) and keeps the answer. Null when it gives none (it cannot be
    /// reached, or is too old to say): what it said last then stands, and until it has said anything no screenshot is
    /// taken.
    /// </summary>
    internal async Task<ServerConfig?> AskServerAsync(NotatoClient client, CancellationToken token)
    {
        ServerConfig? config = null;
        try
        {
            config = await client.GetConfigAsync(token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            _logger.LogDebug(error, "Notato could not ask the server what it allows");
        }

        await OnMain(() =>
        {
            // A stopped connection's answer is the last server's.
            if (token.IsCancellationRequested)
            {
                return;
            }

            _askedAt = DateTime.UtcNow;
            if (config is not null)
            {
                _serverScreenshots = config.Screenshots;
                _serverDerivedScreenshots = config.DerivedScreenshots;
                _captureOnly = config.CaptureOnly;
                SetMentions(config.Mentions, config.Agent);
                RaiseChanged();
            }
        }).ConfigureAwait(false);
        return config;
    }

    /// <summary>
    /// Whether a screenshot may be taken now (<see cref="ScreenshotsOn"/>). An answer from the server more than a few
    /// seconds old is asked for again first. Main thread.
    /// </summary>
    private async Task<bool> ScreenshotsAllowedAsync()
    {
        if (ScreenshotsWanted && DateTime.UtcNow - _askedAt > PolicyFresh)
        {
            await AskBrieflyAsync();
        }

        return ScreenshotsOn;
    }

    /// <summary>Asks the server what it allows, when there is one, waiting a moment at most: a slow server must not hold the person up.</summary>
    private async Task AskBrieflyAsync()
    {
        (NotatoClient? client, CancellationToken token) = await OnMain(() => (_client, _sync?.Token ?? new CancellationToken(canceled: true)));
        if (client is not null && !token.IsCancellationRequested)
        {
            await Task.WhenAny(AskServerAsync(client, token), Task.Delay(PolicyWait));
        }
    }

    /// <summary>An event's JSON, or null when it cannot be read: what was known before is kept.</summary>
    private static T? Parse<T>(string data, JsonTypeInfo<T> info) where T : class
    {
        try
        {
            return JsonSerializer.Deserialize(data, info);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Agent mode: an agent asked, through <c>notato_annotate</c>, for an element of this app to be annotated.</summary>
    private async Task AnswerRelayAsync(NotatoClient client, AnnotateRequest request)
    {
        RelayResult result;
        try
        {
            Annotation annotation = await MainThread.InvokeOnMainThreadAsync(async () =>
            {
                VisualElement? element;
                try
                {
                    element = Find(request.Args.Target);
                }
                catch (FormatException error)
                {
                    throw new InvalidOperationException(error.Message);
                }

                if (element is null)
                {
                    string route = _sessions.FirstOrDefault() is { } session ? SafeRoute(session.Window) : "?";
                    throw new InvalidOperationException($"no element on the screen matches \"{request.Args.Target}\" (the app is on {route}). MAUI selectors look like #AutomationId, Button:text(\"Sign in\") or LoginPage Entry[x:Name=Email].");
                }

                return await AnnotateAsync(element, request.Args.Comment, new AnnotateOptions
                {
                    AgentName = request.Args.Author ?? "agent",
                    Intent = request.Args.Intent,
                    Severity = request.Args.Severity,
                    Steps = request.Args.Steps,
                });
            }).ConfigureAwait(false);
            result = new RelayResult { Ok = true, AnnotationId = annotation.Id };
        }
        catch (Exception error)
        {
            result = new RelayResult { Ok = false, Error = error.Message };
        }

        try
        {
            await client.PostRelayResultAsync(request.RequestId, result).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Notato could not report an annotate result to the server");
        }
    }

    private void SetConnection(NotatoConnection next, string? detail)
    {
        // A loop that was just stopped can still report; once off, Notato stays "disabled".
        if (!_enabled && next != NotatoConnection.Disabled)
        {
            return;
        }

        NotatoConnection? failure = next switch
        {
            NotatoConnection.Offline or NotatoConnection.Refused => next,
            NotatoConnection.Connecting => _lastFailure,
            _ => null,
        };
        // A retry lasts until the try it started ends, one way or the other.
        bool stillRetrying = _retrying && next == NotatoConnection.Connecting;
        if (_connection == next && _connectionDetail == detail && failure == _lastFailure && stillRetrying == _retrying)
        {
            return;
        }

        _connection = next;
        _connectionDetail = detail;
        _lastFailure = failure;
        _retrying = stillRetrying;
        if (next == NotatoConnection.Refused)
        {
            _logger.LogWarning("Notato: {Problem}", detail);
        }

        RaiseChanged();
    }

    /// <summary>The connection in a line, for the settings sheet.</summary>
    internal string DescribeConnection()
    {
        string? where = MenuText.Host(Server);
        return _connection switch
        {
            NotatoConnection.Connected => CaptureOnly ? $"Sending notes to {where}; they are read on the board" : $"Connected to {where}",
            NotatoConnection.Connecting => $"Connecting to {where}…",
            NotatoConnection.Offline => _connectionDetail ?? $"Cannot reach {where}",
            NotatoConnection.Refused => _connectionDetail ?? $"{where} refused this app",
            NotatoConnection.Local => Mode == NotatoMode.Test
                ? where is null ? "Notes stay on this device until packaged" : $"Notes stay on this device; a package is uploaded to {where}"
                : _connectionDetail ?? "No server",
            _ => _invalid ?? "Off",
        };
    }
}
