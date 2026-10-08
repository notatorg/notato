using Microsoft.Extensions.Logging;
using Notato.Maui.Model;
using System.Diagnostics;

namespace Notato.Maui.Runtime;

/// <summary>A small ring buffer, safe to write from any thread.</summary>
internal sealed class Ring<T>(int capacity)
{
    private readonly Queue<T> _items = new();
    private int _limit = Math.Max(1, capacity);

    public int Capacity
    {
        get => _limit;
        set
        {
            lock (_items)
            {
                _limit = Math.Max(1, value);
                while (_items.Count > _limit)
                {
                    _items.Dequeue();
                }
            }
        }
    }

    public void Add(T item)
    {
        lock (_items)
        {
            _items.Enqueue(item);
            while (_items.Count > _limit)
            {
                _items.Dequeue();
            }
        }
    }

    public List<T> Snapshot()
    {
        lock (_items)
        {
            return [.. _items];
        }
    }
}

/// <summary>
/// The app's recent log messages and unhandled exceptions, attached to each annotation as <c>context.console</c> (the
/// same shape the web SDK records), so the agent sees the error that went with "this screen is empty".
/// </summary>
internal sealed class LogRecorder : ILoggerProvider
{
    internal static readonly LogRecorder Shared = new();

    public Ring<LogEntry> Entries { get; } = new(50);

    /// <summary>Messages below this level are not kept. Information keeps the story around a warning.</summary>
    public LogLevel MinimumLevel { get; set; } = LogLevel.Information;

    private bool _hooked;

    public void HookUnhandled()
    {
        if (_hooked)
        {
            return;
        }

        _hooked = true;
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Add("uncaught", e.ExceptionObject?.ToString() ?? "unknown error");
        TaskScheduler.UnobservedTaskException += (_, e) => Add("unhandledrejection", e.Exception.ToString());
    }

    public void Add(string level, string message) =>
        Entries.Add(new LogEntry { Level = level, Message = message.Length > 1000 ? message[..999] + "…" : message, At = DateTimeOffset.UtcNow.ToString("O") });

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

    private static readonly string[] OwnCategories = [typeof(NotatoController).FullName!, "Notato.Maui.Native.", "Notato.Maui.Net.", "Notato.Maui.Overlay.", "Notato.Maui.Runtime.", "Notato.Maui.Inspection.", "Notato.Maui.Capture."];

    /// <summary>A category from Notato itself, not from an app that happens to share the prefix.</summary>
    internal static bool IsNotatos(string category) => OwnCategories.Any(c => category.StartsWith(c, StringComparison.Ordinal));

    public void Dispose() { }

    private sealed class Logger(LogRecorder recorder, string category) : ILogger
    {
        // Notato's own messages, and the HTTP client's line per request, are noise in a bug report.
        private readonly bool _ignored = IsNotatos(category) || category.StartsWith("System.Net.Http.HttpClient", StringComparison.Ordinal);

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => !_ignored && logLevel != LogLevel.None && logLevel >= recorder.MinimumLevel;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            string level = logLevel switch
            {
                LogLevel.Trace or LogLevel.Debug => "debug",
                LogLevel.Information => "info",
                LogLevel.Warning => "warn",
                _ => "error",
            };
            string message = $"[{category}] {formatter(state, exception)}";
            if (exception is not null)
            {
                message += Environment.NewLine + exception;
            }

            recorder.Add(level, message);
        }
    }
}

/// <summary>
/// Records the app's HTTP requests (method, URL without its query, status, duration) for <c>context.network</c>. Add it
/// to the app's own HttpClients: <c>services.AddHttpClient("api").AddHttpMessageHandler(() =&gt; new NotatoNetworkHandler())</c>.
/// </summary>
public sealed class NotatoNetworkHandler : DelegatingHandler
{
    internal static readonly Ring<NetworkEntry> Entries = new(50);

    public NotatoNetworkHandler() { }

    public NotatoNetworkHandler(HttpMessageHandler inner) : base(inner) { }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        string at = DateTimeOffset.UtcNow.ToString("O");
        // Query strings routinely carry tokens: origin and path only.
        string url = request.RequestUri is { } uri ? uri.GetLeftPart(UriPartial.Path) : "";
        try
        {
            HttpResponseMessage response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            Entries.Add(new NetworkEntry { Method = request.Method.Method, Url = url, Status = (int)response.StatusCode, DurationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, At = at });
            return response;
        }
        catch
        {
            Entries.Add(new NetworkEntry { Method = request.Method.Method, Url = url, Status = 0, DurationMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, At = at });
            throw;
        }
    }
}
