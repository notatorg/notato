using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Storage;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;
using System.Text.RegularExpressions;

namespace Notato.Maui;

/// <summary>
/// The running Notato: the overlay in each window, the notes, and the connection to the server. This file holds its
/// state, switching it on and off, and the plumbing; the rest is in the <c>NotatoController.*.cs</c> files, one per
/// job: windows, the toolbar, pins, selecting, making notes, sending them, the server connection, merging the server's
/// copies, acting on a note, and test mode's package.
/// </summary>
/// <remarks>
/// Everything that touches the notes or the overlay runs on the main thread. Work that waits on the network runs off
/// it, and comes back through <see cref="OnMain(Action)"/> or <see cref="Dispatch"/>.
/// </remarks>
internal sealed partial class NotatoController : INotato, IDisposable
{
    /// <summary>
    /// The server's project id: ASCII letters, digits and <c>_ . @ -</c> (.NET's <c>\w</c> would also take letters the server
    /// refuses), never only dots, so it can never name a parent folder.
    /// </summary>
    [GeneratedRegex(@"^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$")]
    private static partial Regex ProjectId();

    private readonly IOptionsMonitor<NotatoOptions> _monitor;
    private readonly IDisposable? _optionsListener;
    private readonly ILogger _logger;
    private readonly ElementInspector _inspector;
    private readonly HttpClient _http;
    private readonly RecordSet _records = [];
    private readonly List<OverlaySession> _sessions = [];
    private readonly RuntimeState _state;

    private bool _started, _enabled, _toolbarVisible, _annotating;
    /// <summary>Why the options cannot be used, fit to show to a person; null when they can.</summary>
    private string? _invalid;
    private LocalStore? _local;
    /// <summary>The project the notes in memory and <see cref="_local"/> belong to.</summary>
    private string? _localProject;
    /// <summary>The store whose notes are in memory, and the one being read now.</summary>
    private LocalStore? _loadedFrom, _loadingFrom;

    public NotatoController(IOptionsMonitor<NotatoOptions> monitor, ILogger<NotatoController> logger)
        : this(monitor, logger, null)
    {
    }

    /// <param name="monitor">The options.</param>
    /// <param name="logger">Where problems are said.</param>
    /// <param name="handler">What carries requests to the server: the platform's own unless given (tests give one).</param>
    internal NotatoController(IOptionsMonitor<NotatoOptions> monitor, ILogger<NotatoController> logger, HttpMessageHandler? handler)
    {
        _monitor = monitor;
        _logger = logger;
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        // Each request sets its own limits (see NotatoClient): the event stream has none at all.
        _http.Timeout = Timeout.InfiniteTimeSpan;
        NotatoOptions options = monitor.CurrentValue;
        _state = new RuntimeState(options.RememberRuntimeState);
        _fold = new ToolbarFold(_state, () => Options.ToolbarCollapsed);
        _inspector = new ElementInspector(new SourceLocator(options.ProjectPath));
        _invalid = Validate(options);
        _optionsListener = monitor.OnChange(_ => Dispatch(Reconfigure));
    }

    private NotatoOptions Options => _monitor.CurrentValue;

    /// <summary>What is wrong with <paramref name="options"/>, fit to show to a person; null when nothing is.</summary>
    internal static string? Validate(NotatoOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Project))
        {
            return "Notato needs a project id: set Notato:Project in configuration, or options.Project in UseNotato.";
        }

        if (!ProjectId().IsMatch(options.Project))
        {
            return $"Notato's project id \"{options.Project}\" may only use letters, digits and . _ - @ (at most 128), and not only dots.";
        }

        string? server = options.ResolvedServer;
        if (server is not null && !IsHttpUrl(server))
        {
            return $"Notato's server \"{server}\" is not an http(s) URL.";
        }

        if (options.MaxScreenshotScale is < 1 or > 4)
        {
            return "Notato's MaxScreenshotScale must be between 1 and 4.";
        }

        return null;
    }

    private static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) && uri.Scheme is "http" or "https";

    // ---- what the overlay reads -------------------------------------------------------------------------------------

    public NotatoMode Mode => Options.Mode;

    public string Project => Options.Project;

    /// <summary>The server the app configured (or the dev tunnel its build recorded).</summary>
    public string? ConfiguredServer => Options.ResolvedServer;

    /// <summary>A server typed into the settings sheet, which wins over the configured one.</summary>
    public string? ServerOverride => _state.Server;

    /// <summary>The server in use.</summary>
    public string? Server => _state.Server ?? Options.ResolvedServer;

    /// <summary>Whether notes are sent to a server as they are made: there is one, and this is not test mode.</summary>
    public bool HasServer => Server is not null && Mode != NotatoMode.Test;

    public string? AuthorName => _state.Author ?? Options.Author;

    public bool ScreenshotsWanted => _state.Screenshots ?? Options.Screenshots;

    public bool PinsVisible => _state.PinsVisible ?? true;

    // ---- INotato ----------------------------------------------------------------------------------------------------

    public event EventHandler? Changed;

    public bool IsEnabled => _enabled;

    public bool IsToolbarVisible => _enabled && _toolbarVisible;

    public bool IsAnnotating => _enabled && _annotating;

    /// <summary>
    /// The notes as they were at the last change: a copy made on the main thread at each change and swapped in whole,
    /// so it can be read from any thread.
    /// </summary>
    public IReadOnlyList<Annotation> Annotations => _published.Annotations;

    public int PendingCount => _published.Pending;

    /// <summary>What <see cref="Annotations"/> and <see cref="PendingCount"/> read: one object, so they always agree.</summary>
    private sealed record Published(IReadOnlyList<Annotation> Annotations, int Pending);

    private volatile Published _published = new([], 0);
    private int _publishedVersion = -1;

    /// <summary>The notes themselves. Main thread only.</summary>
    internal RecordSet Records => _records;

    public void Enable() => Dispatch(() => SetEnabled(true, remember: true));

    public void Disable() => Dispatch(() => SetEnabled(false, remember: true));

    public void ResetRuntimeState() => Dispatch(() =>
    {
        _state.Reset();
        _toolbarFraction = null;
        Reconfigure();
    });

    public void ShowToolbar() => Dispatch(() => SetToolbar(true));

    public void HideToolbar() => Dispatch(() =>
    {
        SetToolbar(false);
        if (_sessions.FirstOrDefault() is { } session && ShakeAvailable)
        {
            session.View.Toast("Toolbar hidden. Shake the device to bring it back.");
        }
    });

    public void StartAnnotating() => Dispatch(() => SetAnnotating(true));

    public void StopAnnotating() => Dispatch(() => SetAnnotating(false));

    internal void ToggleAnnotating() => SetAnnotating(!_annotating);

    // ---- start-up, on and off ---------------------------------------------------------------------------------------

    /// <summary>Runs once the app has its first window: decides whether Notato is on, and loads what was kept on the device.</summary>
    internal void Start()
    {
        if (_started)
        {
            return;
        }

        _started = true;
        Feedback.Current = this;
        if (_invalid is not null)
        {
            _logger.LogError("{Problem} Notato stays off.", _invalid);
            return;
        }

        if (Options.CaptureLogs)
        {
            LogRecorder.Shared.HookUnhandled();
        }

        LogRecorder.Shared.Entries.Capacity = Options.LogLimit;
        _toolbarVisible = _state.ToolbarVisible ?? Options.ShowToolbar;
        SetEnabled(_state.Enabled ?? Options.Enabled, remember: false);
    }

    private void SetEnabled(bool on, bool remember)
    {
        if (_invalid is not null && on)
        {
            _logger.LogError("{Problem} Notato stays off.", _invalid);
            return;
        }

        if (remember)
        {
            _state.Enabled = on;
        }

        bool settled = on ? _sessions.Count > 0 || Application.Current?.Windows.Count == 0 : _sessions.Count == 0;
        if (on == _enabled && settled)
        {
            RaiseChanged();
            return;
        }

        _enabled = on;
        if (on)
        {
            UseProjectStore();
            _ = LoadLocalAsync();
            AttachAll();
            StartSync();
            StartShake();
            WatchPages(true);
            Wake();
        }
        else
        {
            _annotating = false;
            StopSync();
            StopShake();
            WatchPages(false);
            StopTicks();
            foreach (OverlaySession session in _sessions.ToList())
            {
                Detach(session);
            }

            SetConnection(NotatoConnection.Disabled, null);
        }

        RaiseChanged();
    }

    private void SetAnnotating(bool on)
    {
        if (!_enabled)
        {
            return;
        }

        _annotating = on;
        if (!on)
        {
            foreach (OverlaySession session in _sessions)
            {
                ClearSelection(session);
                session.View.ShowSelection(null);
                if (session.View.Composer is not null)
                {
                    session.View.CloseSheet();
                }
            }
        }

        RenderAll();
    }

    /// <summary>The options changed (a configuration source reloaded) or were reset: everything follows them again.</summary>
    private void Reconfigure()
    {
        // A reset, or a new configured corner, can put the toolbar somewhere else.
        _fold.Moved();
        _invalid = Validate(Options);
        if (_invalid is not null)
        {
            _logger.LogError("{Problem} Notato is off until the configuration is fixed.", _invalid);
            SetEnabled(false, remember: false);
            return;
        }

        _toolbarVisible = _state.ToolbarVisible ?? Options.ShowToolbar;
        bool wanted = _state.Enabled ?? Options.Enabled;
        if (wanted != _enabled)
        {
            SetEnabled(wanted, remember: false);
        }
        else if (_enabled)
        {
            if (_localProject != Options.Project)
            {
                UseProjectStore();
                _ = LoadLocalAsync();
            }

            StopSync();
            StartSync();
        }

        RenderAll();
    }

    /// <summary>
    /// Keeps the notes in the configured project's folder, and returns that store. When the project changed, the last
    /// one's notes leave memory; those still to be sent stay in its folder until it is the project again.
    /// </summary>
    private LocalStore UseProjectStore()
    {
        if (_local is not null && _localProject == Options.Project)
        {
            return _local;
        }

        if (_local is not null)
        {
            _records.Clear();
        }

        LocalStore store = new(Path.Combine(SafeAppData(), "notato"), Options.Project, _logger);
        UseLocalStore(store, Options.Project);
        return store;
    }

    /// <summary>Keeps the notes in <paramref name="store"/> from now on: those read from another store no longer count.</summary>
    internal void UseLocalStore(LocalStore store, string project)
    {
        _local = store;
        _localProject = project;
        _loadedFrom = null;
        _loadingFrom = null;
    }

    private static string SafeAppData()
    {
        try
        {
            return FileSystem.Current.AppDataDirectory;
        }
        catch
        {
            // Plain net10.0 (an app's unit tests) has no app data folder.
            return Path.Combine(Path.GetTempPath(), "notato-app");
        }
    }

    // ---- plumbing ---------------------------------------------------------------------------------------------------

    /// <summary>Something the overlay shows changed: drawn again, once per window.</summary>
    private void RenderAll() => RaiseChanged();

    /// <summary>
    /// Something changed: the copy of the notes other threads read is made again (when they changed), each window's
    /// overlay is drawn again, once, and <see cref="Changed"/> is raised. Main thread.
    /// </summary>
    private void RaiseChanged()
    {
        if (_publishedVersion != _records.Version)
        {
            (IReadOnlyList<Annotation> annotations, int pending) = _records.Snapshot();
            _published = new Published(annotations, pending);
            _publishedVersion = _records.Version;
        }

        foreach (OverlaySession session in _sessions)
        {
            session.View.Render();
        }

        // Pins may have come, gone or changed: the next look is soon.
        Wake();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>A page appearing is a new screen, maybe with its own pins: the overlay looks at once.</summary>
    private void WatchPages(bool on)
    {
        if (Application.Current is not { } app)
        {
            return;
        }

        app.PageAppearing -= OnPageAppearing;
        if (on)
        {
            app.PageAppearing += OnPageAppearing;
        }
    }

    private void OnPageAppearing(object? sender, Page page) => Wake();

    /// <summary>
    /// Runs what a sync loop learnt on the main thread, unless that loop was stopped first (another server, another
    /// project, or Notato off): an old loop must not bring back the notes or the state of the last server.
    /// </summary>
    private static void DispatchFor(CancellationToken token, Action action) => Dispatch(() =>
    {
        if (!token.IsCancellationRequested)
        {
            action();
        }
    });

    /// <summary>Runs <paramref name="action"/> on the main thread: now when this is it, else as soon as it is free.</summary>
    private static void Dispatch(Action action)
    {
        if (Application.Current?.Dispatcher is { IsDispatchRequired: true } dispatcher)
        {
            dispatcher.Dispatch(action);
        }
        else
        {
            action();
        }
    }

    /// <summary>Runs <paramref name="action"/> on the main thread, and finishes when it has.</summary>
    private static Task OnMain(Action action)
    {
        if (!IsMainThread)
        {
            return MainThread.InvokeOnMainThreadAsync(action);
        }

        action();
        return Task.CompletedTask;
    }

    /// <summary>Reads something on the main thread.</summary>
    private static Task<T> OnMain<T>(Func<T> read) => IsMainThread ? Task.FromResult(read()) : MainThread.InvokeOnMainThreadAsync(read);

    /// <summary>Whether this is the UI thread. Plain net10.0 (an app's unit tests) has no UI: every thread will do.</summary>
#if IOS || MACCATALYST || ANDROID || WINDOWS
    private static bool IsMainThread => MainThread.IsMainThread;
#else
    private static bool IsMainThread => true;
#endif

    public void Dispose()
    {
        _optionsListener?.Dispose();
        StopSync();
        StopShake();
        WatchPages(false);
        StopTicks();
        foreach (OverlaySession session in _sessions.ToList())
        {
            Detach(session);
        }

        _http.Dispose();
    }
}
