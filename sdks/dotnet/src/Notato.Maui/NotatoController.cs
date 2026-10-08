using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Devices.Sensors;
using Microsoft.Maui.Dispatching;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Networking;
using Microsoft.Maui.Storage;
using Notato.Maui.Capture;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Native;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;
using Notato.Maui.Util;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Notato.Maui;

/// <summary>What is selected in one window, and the picture taken when it was.</summary>
internal sealed class SelectionState(List<VisualElement> elements, CapturedScreen? screen)
{
    public List<VisualElement> Elements { get; set; } = elements;

    /// <summary>The picture, until a note takes it (and disposes it) or the selection goes (<see cref="Dispose"/>).</summary>
    public CapturedScreen? Screen { get; private set; } = screen;

    /// <summary>Hands the picture over to whoever disposes it now: the selection no longer has it.</summary>
    public CapturedScreen? TakeScreen()
    {
        CapturedScreen? screen = Screen;
        Screen = null;
        return screen;
    }

    /// <summary>The selection is replaced or cancelled: its picture, a whole screen's bitmap, goes with it.</summary>
    public void Dispose() => TakeScreen()?.Dispose();
}

/// <summary>Notato in one of the app's windows.</summary>
internal sealed class OverlaySession(Window window, IOverlayHost host)
{
    public Window Window { get; } = window;
    public IOverlayHost Host { get; } = host;
    public NotatoOverlay View { get; set; } = null!;
    public SelectionState? Selection { get; set; }
    public string Route { get; set; } = "";
    /// <summary>The element each note's pin was found on in this window.</summary>
    public Dictionary<string, PinTarget> Resolved { get; } = [];
    /// <summary>Notes whose element was not on screen at the last look, and when to look again.</summary>
    public Dictionary<string, long> Missed { get; } = [];
    public int Ticks { get; set; }
}

/// <summary>
/// The element a note's pin is on, and what it showed when the pin was put there. An element inside a list
/// (a CollectionView, a ListView) can be recycled to show another item: <see cref="InList"/> says it must be checked.
/// </summary>
internal sealed class PinTarget
{
    public PinTarget(VisualElement element)
    {
        Element = new WeakReference<VisualElement>(element);
        Context = element.BindingContext is { } context ? new WeakReference<object>(context) : null;
        InList = VisualTree.InList(element);
    }

    public WeakReference<VisualElement> Element { get; }

    /// <summary>The item it was showing (its BindingContext) when the pin was put on it.</summary>
    public WeakReference<object>? Context { get; }

    public bool InList { get; }

    /// <summary>
    /// Whether the element still shows the note's item: always outside a list; inside one, when it is bound to the same
    /// item, or shows the same text as when the note was made.
    /// </summary>
    public bool StillShows(VisualElement element, ElementIdentity? identity, bool mask)
    {
        if (!InList)
        {
            return true;
        }

        if (Context is not null && Context.TryGetTarget(out object? was) && ReferenceEquals(was, element.BindingContext))
        {
            return true;
        }

        return identity?.Text is { } text && ElementText.Visible(element, mask) == text;
    }
}

/// <summary>The running Notato: the overlay in each window, the notes, and the connection to the server.</summary>
internal sealed partial class NotatoController : INotato, IDisposable
{
    internal sealed class Record(Annotation annotation)
    {
        private Annotation _annotation = annotation;
        private bool _pending;

        /// <summary>The set the note is in, told when it changes so each screen's notes are worked out again.</summary>
        internal RecordSet? Owner { get; set; }

        public Annotation Annotation
        {
            get => _annotation;
            set
            {
                _annotation = value;
                Owner?.Touch();
            }
        }

        /// <summary>Made here and not yet taken by the server (or, in test mode, not yet packaged).</summary>
        public bool Pending
        {
            get => _pending;
            set
            {
                _pending = value;
                Owner?.Touch();
            }
        }

        /// <summary>The server turned this note down for good, and why: it is not sent again.</summary>
        public string? Error { get; set; }
        /// <summary>Why the last try at sending it did not go through, when the server said: it is tried again.</summary>
        public string? Held { get; set; }
        /// <summary>Made on this device in this run.</summary>
        public bool Mine { get; set; }
        /// <summary>The element it was made on, in this run.</summary>
        public PinTarget? Element { get; set; }
        /// <summary>Where its screenshots are kept on the device, by asset id, until the server (or a package) has them.</summary>
        public IReadOnlyDictionary<string, string>? Assets { get; set; }
    }

    /// <summary>
    /// The server's project id: ASCII letters, digits and <c>_ . @ -</c> (.NET's <c>\w</c> would also take letters the server
    /// refuses), never only dots, so it can never name a parent folder.
    /// </summary>
    [GeneratedRegex(@"^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$")]
    private static partial Regex ProjectId();

    private readonly IOptionsMonitor<NotatoOptions> _monitor;
    private readonly ILogger _logger;
    private readonly ElementInspector _inspector;
    private readonly HttpClient _http;
    private readonly RecordSet _records = [];
    private readonly List<OverlaySession> _sessions = [];
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly SemaphoreSlim _creating = new(1, 1);

    private readonly RuntimeState _state;
    private readonly ToolbarFold _fold;
    private bool _foldSawAnnotating;
    private LocalStore? _local;
    /// <summary>The store whose notes are in memory, and the one being read now.</summary>
    private LocalStore? _loadedFrom, _loadingFrom;
    private NotatoClient? _client;
    private CancellationTokenSource? _sync;
    private IDispatcherTimer? _timer;
    private bool _started, _enabled, _toolbarVisible, _annotating;
    private ShakeListener? _shake;
    /// <summary>The project the notes in memory and <see cref="_local"/> belong to.</summary>
    private string? _localProject;
    /// <summary>A flush that stopped is to be tried again; how many times in a row that has happened.</summary>
    private bool _retryPlanned;
    private int _retries;
    private bool _serverScreenshots = true;
    private string? _invalid;
    private NotatoConnection _connection = NotatoConnection.Disabled;
    private string? _connectionDetail;
    /// <summary>How the last try at the server ended, while it keeps failing: offline or refused; null once it works.</summary>
    private NotatoConnection? _lastFailure;
    /// <summary>The menu's Retry is under way.</summary>
    private bool _retrying;
    private Point? _toolbarFraction;

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
        _http.Timeout = Timeout.InfiniteTimeSpan;
        NotatoOptions options = monitor.CurrentValue;
        _state = new RuntimeState(options.RememberRuntimeState);
        _fold = new ToolbarFold(_state, () => Options.ToolbarCollapsed);
        _inspector = new ElementInspector(new SourceLocator(options.ProjectPath));
        _invalid = Validate(options);
        monitor.OnChange(_ => Dispatch(Reconfigure));
    }

    private NotatoOptions Options => _monitor.CurrentValue;

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
        if (server is not null && (!Uri.TryCreate(server, UriKind.Absolute, out Uri? uri) || uri.Scheme is not ("http" or "https")))
        {
            return $"Notato's server \"{server}\" is not an http(s) URL.";
        }

        if (options.MaxScreenshotScale is < 1 or > 4)
        {
            return "Notato's MaxScreenshotScale must be between 1 and 4.";
        }

        return null;
    }

    // ---- what the overlay reads -------------------------------------------------------------------------------------

    public NotatoMode Mode => Options.Mode;
    public string Project => Options.Project;
    public string? ConfiguredServer => Options.ResolvedServer;
    public string? ServerOverride => _state.Server;
    public string? Server => _state.Server ?? Options.ResolvedServer;
    public bool HasServer => Server is not null && Mode != NotatoMode.Test;
    public string? AuthorName => _state.Author ?? Options.Author;
    public bool ScreenshotsWanted => _state.Screenshots ?? Options.Screenshots;
    public bool ServerScreenshotsAllowed => _serverScreenshots;

    private List<MentionInfo> _mentions = [];
    private AgentState _agentState = new();

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
    private bool ScreenshotsOn => ScreenshotsWanted && _serverScreenshots;
    public bool PinsVisible => _state.PinsVisible ?? true;
    public bool ShakeAvailable => Options.ShakeToToggle && SafeAccelerometerSupported();

    public Point ToolbarFraction
    {
        get => _toolbarFraction ??= _state.ToolbarPosition ?? Options.ToolbarPosition switch
        {
            // Bottom corners start a little up, clear of a tab bar; people drag it where they like.
            ToolbarCorner.BottomLeft => new Point(0, 0.86),
            ToolbarCorner.TopRight => new Point(1, 0.08),
            ToolbarCorner.TopLeft => new Point(0, 0.08),
            _ => new Point(1, 0.86),
        };
        set
        {
            _toolbarFraction = value;
            _state.ToolbarPosition = value;
        }
    }

    /// <summary>
    /// Where a fold or an opening left the toolbar. While it is only open for annotating this is not remembered, so a
    /// restart comes back folded where the round button was.
    /// </summary>
    internal void ToolbarArrived(Point fraction)
    {
        if (_fold.OpenedForAnnotating)
        {
            _toolbarFraction = fraction;
        }
        else
        {
            ToolbarFraction = fraction;
        }
    }

    /// <summary>Whether the toolbar grows from, and folds to, the right (see <see cref="ToolbarFold.HeldSide"/>).</summary>
    internal bool ToolbarHeldRight => _fold.HeldSide(_state.ToolbarPosition, Options.ToolbarPosition);

    /// <summary>A fold or an opening of the settled toolbar starts (see <see cref="ToolbarFold.Start"/>).</summary>
    internal ToolbarFold.Trip StartToolbarTrip(bool collapsing, ToolbarFold.Room room, double fromWidth, double toWidth, Point? dragging) =>
        _fold.Start(collapsing, room, (dragging ?? ToolbarFraction).X, fromWidth, toWidth, dragging ?? _state.ToolbarPosition, Options.ToolbarPosition);

    internal ToolbarFold.Trip TurnToolbarAround(bool collapsing, ToolbarFold.Room room, bool heldRight, double fromEdge, double toWidth) =>
        _fold.TurnAround(collapsing, room, heldRight, fromEdge, toWidth);

    /// <summary>The person dragged the toolbar somewhere: its side and its folded and open places start afresh.</summary>
    internal void ToolbarMoved() => _fold.Moved();

    /// <summary>The window changed size: the places it was folded and open at are forgotten; its side is kept.</summary>
    internal void ToolbarRoomChanged() => _fold.ForgetPlaces();

    /// <summary>
    /// Whether the toolbar shows folded into its round button now: as the person left it, but open while annotating
    /// (however that started) if it was folded when it did.
    /// </summary>
    internal bool ToolbarCollapsed
    {
        get
        {
            FollowAnnotating();
            return _fold.Collapsed;
        }
    }

    /// <summary>The person folded the toolbar (its chevron) or opened it (the round button). Remembered.</summary>
    internal void SetToolbarCollapsed(bool collapsed)
    {
        FollowAnnotating();
        if (_fold.Set(collapsed))
        {
            RenderAll();
        }
    }

    /// <summary>
    /// Tells the fold when annotating started or stopped. Checked whenever the fold is read rather than at each place
    /// annotating changes (the toolbar, the menu, <see cref="StartAnnotating"/>, <see cref="SelectAsync"/>, a note
    /// sent or cancelled, Notato switched off), so no way of starting or stopping it is missed.
    /// </summary>
    private void FollowAnnotating()
    {
        if (IsAnnotating == _foldSawAnnotating)
        {
            return;
        }

        _foldSawAnnotating = IsAnnotating;
        _fold.AnnotatingChanged(_foldSawAnnotating);
    }

    // ---- INotato ----------------------------------------------------------------------------------------------

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
    public NotatoConnection Connection => _connection;
    public string? ConnectionDetail => _connectionDetail ?? _invalid;

    /// <summary>The connection as the toolbar and its menu show it (see <see cref="MenuText.Shown"/>).</summary>
    internal NotatoConnection ShownConnection => MenuText.Shown(_connection, _lastFailure, _retrying);

    /// <summary>The server could not be reached (or refused this app) the last time it was tried: the menu says so.</summary>
    internal NotatoConnection? Unreachable => _enabled && HasServer ? _lastFailure : null;

    /// <summary>The menu's Retry is trying the server now.</summary>
    internal bool Retrying => _retrying;

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
        if (_sessions.FirstOrDefault() is { } s && ShakeAvailable)
        {
            s.View.Toast("Toolbar hidden. Shake the device to bring it back.");
        }
    });

    public void StartAnnotating() => Dispatch(() => SetAnnotating(true));

    public void StopAnnotating() => Dispatch(() => SetAnnotating(false));

    internal void ToggleAnnotating() => SetAnnotating(!_annotating);

    internal void TogglePins()
    {
        _state.PinsVisible = !PinsVisible;
        RenderAll();
    }

    // ---- start-up and windows ---------------------------------------------------------------------------------------

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

    /// <summary>A window got its content: put the overlay in it (when on).</summary>
    internal void OnWindowContent(Window window)
    {
        Start();
        if (!_enabled)
        {
            return;
        }
        // After the current layout pass, so the native window is fully set up.
        window.Dispatcher.Dispatch(() => Attach(window));
    }

    private void Attach(Window window)
    {
        if (!_enabled || _sessions.Any(s => ReferenceEquals(s.Window, window)))
        {
            return;
        }

        if (window.Handler?.MauiContext is not { } context)
        {
            return;
        }

        IOverlayHost? host = OverlayHosts.Create(window);
        if (host is null)
        {
            return;
        }

        OverlaySession session = new(window, host);
        session.View = new NotatoOverlay(this, session);
        try
        {
            host.Attach(session.View, context);
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not put its overlay in the window");
            host.Dispose();
            return;
        }
        host.MetricsChanged += (_, _) => session.View.Dispatcher.Dispatch(() => session.View.SetMetrics(host.SafeInsets, host.KeyboardHeight));
        session.View.SetMetrics(host.SafeInsets, host.KeyboardHeight);
        window.ModalPushed += OnModalChanged;
        window.ModalPopped += OnModalChanged;
        window.Destroying += OnWindowDestroying;
        _sessions.Add(session);
        session.View.Render();
        EnsureTimer();
    }

    private void OnModalChanged(object? sender, EventArgs e)
    {
        if (_sessions.FirstOrDefault(s => ReferenceEquals(s.Window, sender)) is not { } session)
        {
            return;
        }
        // A modal page's dialog (Android) shows a moment after the event; look again then.
        foreach (int delay in new[] { 0, 120, 400 })
        {
            session.Window.Dispatcher.DispatchDelayed(TimeSpan.FromMilliseconds(delay), () =>
            {
                session.Host.Refresh();
                session.Resolved.Clear();
                session.Missed.Clear();
                Tick();
            });
        }
    }

    private void OnWindowDestroying(object? sender, EventArgs e)
    {
        if (_sessions.FirstOrDefault(s => ReferenceEquals(s.Window, sender)) is { } session)
        {
            Detach(session);
        }
    }

    private void Detach(OverlaySession session)
    {
        ClearSelection(session);
        session.Window.ModalPushed -= OnModalChanged;
        session.Window.ModalPopped -= OnModalChanged;
        session.Window.Destroying -= OnWindowDestroying;
        session.Host.Dispose();
        _sessions.Remove(session);
    }

    private void AttachAll()
    {
        foreach (Window window in Application.Current?.Windows.OfType<Window>() ?? [])
        {
            Attach(window);
        }
    }

    // ---- on and off ----------------------------------------------------------------------------------------------

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

        if (on == _enabled && (on ? _sessions.Count > 0 || Application.Current?.Windows.Count == 0 : _sessions.Count == 0))
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
            EnsureTimer();
        }
        else
        {
            _annotating = false;
            StopSync();
            StopShake();
            _timer?.Stop();
            foreach (OverlaySession? session in _sessions.ToList())
            {
                Detach(session);
            }

            SetConnection(NotatoConnection.Disabled, null);
        }
        RaiseChanged();
    }

    private void SetToolbar(bool visible)
    {
        _toolbarVisible = visible;
        _state.ToolbarVisible = visible;
        if (!visible)
        {
            _annotating = false;
        }

        RenderAll();
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
    /// Keeps the notes in the configured project's folder. When the project changed, the last one's notes leave memory;
    /// those still to be sent stay in its folder until it is the project again.
    /// </summary>
    private void UseProjectStore()
    {
        if (_local is not null && _localProject == Options.Project)
        {
            return;
        }

        if (_local is not null)
        {
            _records.Clear();
        }

        UseLocalStore(new LocalStore(Path.Combine(SafeAppData(), "notato"), Options.Project, _logger), Options.Project);
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
            return Path.Combine(Path.GetTempPath(), "notato-app");
        }
    }

    // ---- shake ----------------------------------------------------------------------------------------------------

    private static bool SafeAccelerometerSupported()
    {
        try
        {
            return Accelerometer.Default.IsSupported;
        }
        catch
        {
            return false;
        }
    }

    private void StartShake()
    {
        if (!ShakeAvailable)
        {
            return;
        }

        try
        {
            _shake ??= new ShakeListener(Accelerometer.Default, OnShake, _logger);
            _shake.Start();
        }
        catch (Exception error)
        {
            _logger.LogDebug(error, "Notato could not listen for shakes");
        }
    }

    private void StopShake() => _shake?.Stop();

    private void OnShake(object? sender, EventArgs e) => Dispatch(() => SetToolbar(!_toolbarVisible));

    // ---- the overlay's rhythm: pins follow their elements ----------------------------------------------------------

    private void EnsureTimer()
    {
        if (!_enabled || _sessions.Count == 0)
        {
            return;
        }

        if (_timer is null)
        {
            IDispatcher dispatcher = _sessions[0].Window.Dispatcher;
            _timer = dispatcher.CreateTimer();
            _timer.Interval = TimeSpan.FromMilliseconds(150);
            _timer.Tick += (_, _) => Tick();
        }
        if (!_timer.IsRunning)
        {
            _timer.Start();
        }
    }

    private void Tick()
    {
        foreach (OverlaySession? session in _sessions.ToList())
        {
            session.Ticks++;
            if (session.Ticks % 4 == 0)
            {
                session.Host.Refresh();
            }

            string route = SafeRoute(session.Window);
            if (route != session.Route)
            {
                session.Route = route;
                session.Resolved.Clear();
                session.Missed.Clear();
                session.View.Render();
            }
            if (PinsVisible)
            {
                // Drawn again only where something moved or changed (see ShowPins).
                session.View.ShowPins(Placements(session));
            }

            if (session.Selection is { } selection)
            {
                session.View.ShowSelection(Describe(session, selection));
            }
        }
    }

    private static string SafeRoute(Window window)
    {
        try
        {
            return AppContextInfo.RouteOf(window).Route;
        }
        catch
        {
            return "/";
        }
    }

    private string RouteOf(OverlaySession session) => session.Route.Length > 0 ? session.Route : SafeRoute(session.Window);

    /// <summary>The notes on the session's screen, oldest first, numbered as their pins are.</summary>
    internal IReadOnlyList<(int Number, Record Record)> RecordsOnRoute(OverlaySession session) => _records.On(RouteOf(session));

    internal int CountOnRoute(OverlaySession session) => RecordsOnRoute(session).Count;

    /// <summary>
    /// Where each pin on the session's screen goes now. Only notes made with this SDK get one (see
    /// <see cref="RecordSet.PinnedOn"/>), the newest <see cref="RecordSet.MaxPins"/>. A pin whose element is known is
    /// put on it where it is now (a cheap look per pin); the ones whose element is not are looked for together, in one
    /// walk of the tree, about once a second.
    /// </summary>
    private List<PinPlacement> Placements(OverlaySession session)
    {
        IReadOnlyList<(int Number, Record Record)> shown = _records.PinnedOn(RouteOf(session));
        IElementGeometry geometry = session.Host.Geometry;
        bool mask = Options.ResolvedMaskInputs;
        Rect?[] rects = new Rect?[shown.Count];
        List<int> missing = [];
        for (int i = 0; i < shown.Count; i++)
        {
            rects[i] = KnownBounds(session, shown[i].Record, geometry, mask);
            if (rects[i] is null)
            {
                missing.Add(i);
            }
        }
        if (missing.Count > 0)
        {
            LookFor(session, shown, missing, rects, geometry, mask);
        }

        List<PinPlacement> list = new(shown.Count);
        for (int i = 0; i < shown.Count; i++)
        {
            (int number, Record record) = shown[i];
            Annotation a = record.Annotation;
            PageRect stored = a.Target.Rect;
            list.Add(new PinPlacement(a.Id, number, a.Status, rects[i] ?? new Rect(stored.X, stored.Y, stored.W, stored.H), rects[i] is null, record.Pending));
        }
        return list;
    }

    /// <summary>Where the note's element is now, when it is already known and still shows the note; null otherwise.</summary>
    private static Rect? KnownBounds(OverlaySession session, Record record, IElementGeometry geometry, bool mask)
    {
        ElementIdentity? identity = record.Annotation.Target.Identity.FirstOrDefault();
        if (record.Element is { } made)
        {
            if (Bounds(made, identity, geometry, mask) is { } rect)
            {
                return rect;
            }

            if (!made.Element.TryGetTarget(out VisualElement? element) || !made.StillShows(element, identity, mask))
            {
                // Gone, or a list's row that now shows another item: the pin is looked for by its selector instead.
                record.Element = null;
            }
        }
        if (session.Resolved.TryGetValue(record.Annotation.Id, out PinTarget? found))
        {
            if (Bounds(found, identity, geometry, mask) is { } rect)
            {
                return rect;
            }

            session.Resolved.Remove(record.Annotation.Id);
        }
        return null;
    }

    private static Rect? Bounds(PinTarget target, ElementIdentity? identity, IElementGeometry geometry, bool mask) =>
        target.Element.TryGetTarget(out VisualElement? element) && geometry.BoundsOf(element) is { } rect && target.StillShows(element, identity, mask)
            ? rect
            : null;

    /// <summary>
    /// Looks for the elements of the pins in <paramref name="missing"/> whose time to look again has come, all in one
    /// walk of what the window shows. Searching for an element that is not there is the costly case, so each is looked
    /// for about once a second at most. Inside a list, an element must show the note's text to be taken.
    /// </summary>
    private void LookFor(OverlaySession session, IReadOnlyList<(int Number, Record Record)> shown, List<int> missing, Rect?[] rects, IElementGeometry geometry, bool mask)
    {
        long now = Environment.TickCount64;
        List<int> due = [];
        List<IReadOnlyList<Selectors.Step>> selectors = [];
        foreach (int i in missing)
        {
            string id = shown[i].Record.Annotation.Id;
            if (session.Missed.TryGetValue(id, out long until) && now < until)
            {
                continue;
            }

            session.Missed[id] = now + 900;
            // A selector that is not a MAUI one (a newer SDK's) is never found: the stored rectangle will do.
            if (shown[i].Record.Annotation.Target.Identity.FirstOrDefault()?.Selector is { } selector && Selectors.TryParseCached(selector) is { Count: > 0 } steps)
            {
                due.Add(i);
                selectors.Add(steps);
            }
        }
        if (due.Count == 0)
        {
            return;
        }

        bool Takes(int index, Element element)
        {
            if (element is not VisualElement visual || geometry.BoundsOf(visual) is null)
            {
                return false;
            }

            ElementIdentity? identity = shown[due[index]].Record.Annotation.Target.Identity.FirstOrDefault();
            return identity?.Text is not { } text || !VisualTree.InList(visual) || ElementText.Visible(visual, mask) == text;
        }

        foreach (Element root in VisualTree.VisibleRoots(session.Window))
        {
            Element?[] found = Selectors.QueryFirst(root, selectors, mask, Takes);
            for (int k = 0; k < due.Count; k++)
            {
                if (found[k] is not VisualElement element || rects[due[k]] is not null)
                {
                    continue;
                }

                string id = shown[due[k]].Record.Annotation.Id;
                session.Resolved[id] = new PinTarget(element);
                session.Missed.Remove(id);
                rects[due[k]] = geometry.BoundsOf(element);
            }
        }
    }

    // ---- picking ----------------------------------------------------------------------------------------------------

    private bool Skip(Element element) => element is BindableObject b && Feedback.GetIgnore(b);

    internal async void OnPick(OverlaySession session, Point point)
    {
        try
        {
            VisualElement? element = VisualTree.HitTest(session.Window, point, session.Host.Geometry, Skip);
            if (element is null)
            {
                session.View.Toast("Nothing of the app is there.");
                return;
            }
            if (session.Selection is { } existing)
            {
                existing.Elements = [element];
                Select(session, existing);
                return;
            }
            CapturedScreen? screen = await CaptureAsync(session);
            // Another tap may have selected something while the picture was taken: this one replaces it.
            ClearSelection(session);
            Select(session, new SelectionState([element], screen));
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not select that element");
            session.View.Toast("Could not select that: " + error.Message);
        }
    }

    public async Task SelectAsync(VisualElement element)
    {
        await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            if (!_enabled)
            {
                throw new InvalidOperationException("Notato is off. Call Enable() first.");
            }

            OverlaySession session = SessionOf(element) ?? throw new InvalidOperationException("That element is not in a window Notato is in.");
            _annotating = true;
            CapturedScreen? screen = await CaptureAsync(session);
            ClearSelection(session);
            Select(session, new SelectionState([element], screen));
        });
    }

    /// <summary>
    /// A picture of the window, when screenshots are on, with what to cover in it measured in the same moment: every
    /// private element on every page the picture shows. Without its covers there is no picture.
    /// </summary>
    private async Task<CapturedScreen?> CaptureAsync(OverlaySession session)
    {
        if (!ScreenshotsOn)
        {
            return null;
        }

        bool maskInputs = Options.ResolvedMaskInputs;
        try
        {
            return await session.Host.CaptureAsync(() => Privacy.MaskRects(VisualTree.AllRoots(session.Window), session.Host.Geometry, maskInputs));
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Notato could not take the screenshot; the note goes without one");
            return null;
        }
    }

    private void Select(OverlaySession session, SelectionState selection)
    {
        session.Selection = selection;
        SelectionView view = Describe(session, selection);
        session.View.ShowSelection(view);
        session.View.OpenComposer(view, screenshotsOff: !ScreenshotsOn);
        RenderAll();
    }

    private SelectionView Describe(OverlaySession session, SelectionState selection)
    {
        List<Rect> rects = [.. selection.Elements.Select(e => session.Host.Geometry.BoundsOf(e)).OfType<Rect>()];
        VisualElement first = selection.Elements[0];
        string title = Selectors.Segment(first, withPosition: false);
        string? text = ElementText.Visible(first, Options.ResolvedMaskInputs);
        if (text is not null && first is not Page)
        {
            title += $" “{(text.Length > 28 ? text[..27] + "…" : text)}”";
        }

        SourceLocation? where = _inspector.Sources.Locate(first);
        Page? page = VisualTree.PageOf(first);
        string subtitle = string.Join(" · ", new[]
        {
            page is null || ReferenceEquals(page, first) ? null : "in " + VisualTree.TypeName(page.GetType()),
            where is null ? null : $"{Path.GetFileName(where.File)}:{where.Line}",
        }.Where(s => s is not null));
        return new SelectionView(rects, title, subtitle.Length == 0 ? null : subtitle);
    }

    internal void SelectParent(OverlaySession session)
    {
        if (session.Selection is not { } selection)
        {
            return;
        }

        VisualElement current = selection.Elements[0];
        IElementGeometry geometry = session.Host.Geometry;
        foreach (VisualElement parent in VisualTree.SelfAndAncestors(current).Skip(1).OfType<VisualElement>())
        {
            if (parent.Handler is null || geometry.BoundsOf(parent) is null)
            {
                continue;
            }

            selection.Elements = [parent];
            Select(session, selection);
            return;
        }
        session.View.Toast("That is the whole page.");
    }

    internal void CancelSelection(OverlaySession session)
    {
        ClearSelection(session);
        session.View.ShowSelection(null);
        _annotating = false;
        RenderAll();
    }

    /// <summary>The session's selection goes, and the picture taken for it with it.</summary>
    private static void ClearSelection(OverlaySession session)
    {
        session.Selection?.Dispose();
        session.Selection = null;
    }

    private OverlaySession? SessionOf(Element element)
    {
        Window? window = VisualTree.SelfAndAncestors(element).OfType<Window>().FirstOrDefault()
            ?? (element as VisualElement)?.Window;
        return _sessions.FirstOrDefault(s => ReferenceEquals(s.Window, window)) ?? _sessions.FirstOrDefault();
    }

    // ---- making annotations ------------------------------------------------------------------------------------------

    internal async Task<string?> SubmitAsync(OverlaySession session, string comment, string? intent, string? severity, bool peopleOnly = false)
    {
        if (session.Selection is not { } selection)
        {
            return "Select something first.";
        }

        try
        {
            // The note takes the picture, and disposes it once its screenshots are drawn: sending again after a
            // failure goes without one.
            Record record = await CreateAsync(session, selection.Elements, selection.TakeScreen(), comment, intent, severity, Author.Human(AuthorName), Options.Mode == NotatoMode.Agent ? Modes.Agent : ModeName, null, peopleOnly);
            ClearSelection(session);
            session.View.ShowSelection(null);
            session.View.CloseSheet();
            _annotating = false;
            RenderAll();
            SendResult sent = await SendAsync(record);
            session.View.Toast(sent.Problem ?? (HasServer ? "Sent" : "Saved on this device. Package it from the menu."));
            return null;
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not make the annotation");
            return error.Message;
        }
    }

    private string ModeName => Options.Mode switch
    {
        NotatoMode.Test => Modes.Test,
        NotatoMode.Agent => Modes.Agent,
        _ => Modes.Dev,
    };

    public async Task<Annotation> AnnotateAsync(VisualElement element, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default)
    {
        options ??= new AnnotateOptions();
        if (string.IsNullOrWhiteSpace(comment))
        {
            throw new ArgumentException("A note needs a comment.", nameof(comment));
        }

        if (options.PeopleOnly && options.AgentName is not null)
        {
            throw new ArgumentException("Only a person's note can be People only: it is how people keep a note from the agent.", nameof(options));
        }

        cancellationToken.ThrowIfCancellationRequested();
        return await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            if (!_enabled)
            {
                throw new InvalidOperationException("Notato is off. Call Enable() first.");
            }

            OverlaySession session = SessionOf(element) ?? throw new InvalidOperationException("That element is not in a window Notato is in.");
            CapturedScreen? screen = options.Screenshot ? await CaptureAsync(session) : null;
            // The last point at which nothing has been made.
            if (cancellationToken.IsCancellationRequested)
            {
                screen?.Dispose();
                cancellationToken.ThrowIfCancellationRequested();
            }

            Author author = options.AgentName is null ? Author.Human(AuthorName) : Author.Agent(options.AgentName);
            string mode = options.AgentName is null ? ModeName : Modes.Agent;
            Record record = await CreateAsync(session, [element], screen, comment, options.Intent, options.Severity, author, mode, options.Steps, options.PeopleOnly);
            RenderAll();
            SendResult sent = await SendAsync(record, cancellationToken);
            if (sent.Outcome != Sending.Sent && sent.Problem is not null)
            {
                _logger.LogWarning("Notato kept the annotation on the device: {Problem}", sent.Problem);
            }

            return record.Annotation;
        });
    }

    public Task<Annotation> AnnotateAsync(string selector, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default) =>
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            VisualElement element = Find(selector) ?? throw new InvalidOperationException($"No element on the screen matches \"{selector}\".");
            return await AnnotateAsync(element, comment, options, cancellationToken);
        });

    /// <summary>The first element on screen that the selector matches, in any window.</summary>
    private VisualElement? Find(string selector)
    {
        foreach (OverlaySession session in _sessions)
        {
            foreach (Element root in VisualTree.VisibleRoots(session.Window))
            {
                VisualElement? found = Selectors.Query(root, selector, Options.ResolvedMaskInputs).OfType<VisualElement>().FirstOrDefault(e => session.Host.Geometry.BoundsOf(e) is not null);
                if (found is not null)
                {
                    return found;
                }
            }
        }
        return null;
    }

    /// <summary>
    /// Makes one note at a time. A note's pin number is the count of notes on its screen plus one, and it only joins that
    /// list once its screenshot is drawn: two made at once (an agent relaying twice) would otherwise share a number.
    /// </summary>
    private async Task<Record> CreateAsync(OverlaySession session, IReadOnlyList<VisualElement> elements, CapturedScreen? screen, string comment,
        string? intent, string? severity, Author author, string mode, IReadOnlyList<AgentStep>? steps, bool peopleOnly)
    {
        try
        {
            await _creating.WaitAsync();
            try
            {
                return await CreateOneAsync(session, elements, screen, comment, intent, severity, author, mode, steps, peopleOnly);
            }
            finally
            {
                _creating.Release();
            }
        }
        finally
        {
            // Done with as soon as the screenshots are drawn; this is for a note that failed before then.
            screen?.Dispose();
        }
    }

    private async Task<Record> CreateOneAsync(OverlaySession session, IReadOnlyList<VisualElement> elements, CapturedScreen? screen, string comment,
        string? intent, string? severity, Author author, string mode, IReadOnlyList<AgentStep>? steps, bool peopleOnly)
    {
        NotatoOptions options = Options;
        IElementGeometry geometry = session.Host.Geometry;
        List<Rect> rects = [.. elements.Select(e => geometry.BoundsOf(e) ?? Rect.Zero)];
        Rect union = rects.Aggregate((a, b) => a.Union(b));
        (string route, string url, _, _, _) = AppContextInfo.RouteOf(session.Window);
        int pin = _records.On(route).Count + 1;
        bool mask = options.ResolvedMaskInputs;

        ComposedScreenshots? shots = null;
        try
        {
            if (screen is not null && ScreenshotsOn)
            {
                // Where the private parts were when the picture was taken, not where they are now.
                IReadOnlyList<Rect> masks = screen.Masks;
                List<Rect> targets = rects;
                double maxScale = options.MaxScreenshotScale;
                shots = await Task.Run(() => ScreenshotComposer.Compose(screen, targets, pin, masks, maxScale));
            }
        }
        finally
        {
            // The window's bitmap is done with: its PNGs are drawn (or there are none).
            screen?.Dispose();
        }

        Dictionary<string, JsonElement> context = new()
        {
            ["maui"] = JsonSerializer.SerializeToElement(AppContextInfo.Describe(session.Window, elements[0], _inspector.Sources), ContextJson.Default.MauiContextInfo),
            ["screenshot"] = JsonSerializer.SerializeToElement(new PinContext { Pin = pin }, ContextJson.Default.PinContext),
        };
        if (options.CaptureLogs)
        {
            List<LogEntry> logs = LogRecorder.Shared.Entries.Snapshot();
            if (logs.Count > 0)
            {
                context["console"] = JsonSerializer.SerializeToElement(logs, NotatoJsonContext.Default.ListLogEntry);
            }
        }
        List<NetworkEntry> network = NotatoNetworkHandler.Entries.Snapshot();
        if (network.Count > 0)
        {
            context["network"] = JsonSerializer.SerializeToElement(network, NotatoJsonContext.Default.ListNetworkEntry);
        }

        Annotation annotation = new()
        {
            Id = Ulid.New(),
            ProjectId = options.Project,
            BundleId = null,
            Author = author,
            Mode = mode,
            CreatedAt = Now(),
            Url = url,
            Route = route,
            AppName = AppContextInfo.AppName(options),
            AppVersion = AppContextInfo.AppVersion(options),
            Environment = AppContextInfo.Environment(options, session.Host.Size),
            Target = new Target
            {
                Kind = elements.Count > 1 ? TargetKinds.Multi : TargetKinds.Element,
                Identity = [.. elements.Select(e => _inspector.Describe(e, mask))],
                Rect = new PageRect(Math.Round(union.X, 2), Math.Round(union.Y, 2), Math.Round(union.Width, 2), Math.Round(union.Height, 2)),
            },
            Comment = comment.Trim(),
            Severity = severity,
            Intent = intent,
            Screenshots = shots?.Refs,
            Steps = steps,
            Context = context,
            Status = Statuses.Open,
            Thread = [],
            PeopleOnly = PeopleOnlyToggle.Flag(peopleOnly),
        };
        // On the device first, screenshots and all: only where they are is kept in memory.
        if (_local is null)
        {
            UseProjectStore();
        }

        IReadOnlyDictionary<string, string> assets = await _local!.SaveAsync(annotation, shots?.Assets);
        Record record = new(annotation)
        {
            Pending = true,
            Mine = true,
            Element = new PinTarget(elements[0]),
            Assets = assets,
        };
        _records.Add(record);
        RaiseChanged();
        return record;
    }

    // ---- sending -------------------------------------------------------------------------------------------------

    /// <summary>How a try at sending a note ended.</summary>
    internal enum Sending
    {
        /// <summary>The server has it (or had it already).</summary>
        Sent,

        /// <summary>The server turned this note down for good: the note says why, and the notes after it still go.</summary>
        Refused,

        /// <summary>Not now (no server, offline, not allowed, unknown project, busy): it and the notes after it wait.</summary>
        Later,
    }

    /// <summary>How a send ended, and what to tell the person (<c>Problem</c>) when there is something to tell.</summary>
    internal readonly record struct SendResult(Sending Outcome, string? Problem);

    /// <summary>Sends one note now, to <paramref name="client"/> (the current server's unless given).</summary>
    /// <remarks>Safe from any thread: the note list and its records are only ever changed on the main thread.</remarks>
    private async Task<SendResult> SendAsync(Record record, CancellationToken ct = default, NotatoClient? client = null)
    {
        NotatoClient? c = client ?? _client;
        if (!HasServer || c is null)
        {
            return new SendResult(Sending.Later, null);
        }

        await _sending.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            (bool pending, Annotation annotation, IReadOnlyDictionary<string, string>? assets) =
                await OnMain(() => (record.Pending && !_records.WasDeleted(record.Annotation.Id), record.Annotation, record.Assets));
            if (!pending)
            {
                return new SendResult(Sending.Sent, null);
            }

            PostedAnnotation posted = await c.PostAnnotationAsync(annotation, assets ?? new Dictionary<string, string>(), ct).ConfigureAwait(false);
            Annotation stored = posted.Stored.Annotation;
            if (await OnMain(() => _records.WasDeleted(annotation.Id)))
            {
                // Deleted here while it was on its way: it goes from the server too.
                await DeleteSentAsync(c, annotation.Id).ConfigureAwait(false);
                return new SendResult(Sending.Sent, null);
            }

            if (!posted.Created && PeopleOnlyToggle.ToReplay(annotation, stored) is { } replay)
            {
                stored = await ReplayPeopleOnlyAsync(c, annotation.Id, replay.On, replay.By, stored, ct).ConfigureAwait(false);
            }

            await OnMain(() =>
            {
                // The server's events may have brought a newer copy while the answer was on its way: that one stays.
                if (record.Pending)
                {
                    record.Annotation = stored;
                    record.Pending = false;
                }

                record.Error = null;
                record.Held = null;
                record.Assets = null;
                RaiseChanged();
            });
            if (_local is { } store)
            {
                await store.RemoveAsync(annotation.Id).ConfigureAwait(false);
            }

            return new SendResult(Sending.Sent, null);
        }
        catch (NotatoServerException error) when (error.Rejected)
        {
            _logger.LogWarning("The Notato server refused annotation {Id}: {Problem}", record.Annotation.Id, error.Message);
            await OnMain(() =>
            {
                record.Error = error.Message;
                record.Held = null;
                RaiseChanged();
            });
            // Remembered, so it is not sent first (and refused again) after every restart.
            if (_local is { } store)
            {
                await store.MarkRefusedAsync(record.Annotation.Id, error.Message).ConfigureAwait(false);
            }

            return new SendResult(Sending.Refused, "The server refused it: " + error.Message);
        }
        catch (NotatoServerException error) when (error.Status != 0)
        {
            // It answered, but not yet (an unknown project, a credential, too busy): say what it said, and keep the note.
            _logger.LogWarning("Notato kept annotation {Id} to send later: {Problem}", record.Annotation.Id, error.Message);
            await OnMain(() =>
            {
                record.Held = error.Message;
                RaiseChanged();
                RetryFlushLater();
            });
            return new SendResult(Sending.Later, "Saved on this device. The server said: " + error.Message);
        }
        catch (Exception error)
        {
            _logger.LogDebug(error, "Notato could not send annotation {Id} yet", record.Annotation.Id);
            await OnMain(RetryFlushLater);
            return new SendResult(Sending.Later, "Saved. It's sent when the server can be reached.");
        }
        finally
        {
            _sending.Release();
        }
    }

    /// <summary>
    /// The server had the note already (the answer to an earlier send was lost) and People only was turned on or off
    /// here since: the change is made again on the server, as the person who made it, before its copy is taken. When
    /// the server will not take the change, its copy is taken as it is (and the person can turn it again); when it
    /// cannot be reached, the note waits and is sent again.
    /// </summary>
    private async Task<Annotation> ReplayPeopleOnlyAsync(NotatoClient c, string id, bool on, Author by, Annotation stored, CancellationToken ct)
    {
        try
        {
            return (await c.SetPeopleOnlyAsync(id, on, by, ct).ConfigureAwait(false)).Annotation;
        }
        catch (NotatoServerException error) when (error.Status != 0)
        {
            _logger.LogWarning("Notato could not turn People only {State} again on annotation {Id}: {Problem}", on ? "on" : "off", id, error.Message);
            return stored;
        }
    }

    /// <summary>A note deleted here while it was being sent: the server's new copy goes too, and the device's.</summary>
    private async Task DeleteSentAsync(NotatoClient c, string id)
    {
        try
        {
            await c.DeleteAsync(id).ConfigureAwait(false);
        }
        catch (NotatoServerException error)
        {
            _logger.LogWarning("Notato could not delete annotation {Id} on the server after it was sent: {Problem}", id, error.Message);
        }
        if (_local is { } store)
        {
            await store.RemoveAsync(id).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Sends the notes that are waiting, oldest first, to <paramref name="client"/> (the current server's unless given).
    /// A note the server refuses is set aside and the rest go on; when one cannot go yet, the rest wait with it and the
    /// flush is tried again in a while.
    /// </summary>
    private async Task FlushAsync(NotatoClient? client = null)
    {
        List<Record> waiting = await OnMain(() => _records.Where(r => r.Pending && r.Error is null).ToList());
        // A send that has to wait plans the next try itself.
        if (await SendInOrderAsync(waiting, async r => (await SendAsync(r, client: client).ConfigureAwait(false)).Outcome).ConfigureAwait(false))
        {
            await OnMain(() => _retries = 0);
        }
    }

    /// <summary>
    /// Sends <paramref name="waiting"/> in order until one has to wait, which keeps the rest waiting behind it. One
    /// that is refused does not: the next is sent. True when none had to wait.
    /// </summary>
    internal static async Task<bool> SendInOrderAsync<T>(IEnumerable<T> waiting, Func<T, Task<Sending>> send)
    {
        foreach (T item in waiting)
        {
            if (await send(item).ConfigureAwait(false) == Sending.Later)
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// A note could not go while the server is meant to be there: flush again after a wait that grows each time (2 s up
    /// to 2 min). Over a lost connection it does nothing: connecting again flushes.
    /// </summary>
    private void RetryFlushLater()
    {
        if (_retryPlanned || _sync is null || !HasServer)
        {
            return;
        }

        _retryPlanned = true;
        CancellationToken token = _sync.Token;
        TimeSpan wait = TimeSpan.FromSeconds(Math.Min(120, 2 << Math.Min(_retries, 6)));
        _retries++;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(wait, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            bool go = await OnMain(() =>
            {
                // A stopped sync's retry is over; the new one plans its own.
                if (token.IsCancellationRequested)
                {
                    return false;
                }

                _retryPlanned = false;
                return _connection == NotatoConnection.Connected;
            });
            if (go)
            {
                await FlushAsync().ConfigureAwait(false);
            }
        });
    }

    /// <summary>
    /// Reads the notes kept on the device for the current project into memory, once per store. A load that fails is
    /// tried again the next time (Notato switched on, or the project changed back).
    /// </summary>
    private async Task LoadLocalAsync()
    {
        if (_local is not { } store || ReferenceEquals(_loadedFrom, store) || ReferenceEquals(_loadingFrom, store))
        {
            return;
        }

        _loadingFrom = store;
        try
        {
            IReadOnlyList<LocalAnnotation> items = await store.LoadAsync().ConfigureAwait(false);
            await OnMain(() => AddLoaded(store, items));
            if (HasServer && _connection == NotatoConnection.Connected)
            {
                await FlushAsync().ConfigureAwait(false);
            }
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Notato could not read the notes kept on this device");
        }
        finally
        {
            await OnMain(() =>
            {
                if (ReferenceEquals(_loadingFrom, store))
                {
                    _loadingFrom = null;
                }
            });
        }
    }

    /// <summary>
    /// Adds the notes read from <paramref name="store"/>, unless the project changed while they were read: then they
    /// belong to another project's store, and stay there. Returns whether they were added.
    /// </summary>
    internal bool AddLoaded(LocalStore store, IReadOnlyList<LocalAnnotation> items)
    {
        if (!ReferenceEquals(_local, store))
        {
            return false;
        }

        foreach (LocalAnnotation item in items)
        {
            if (_records.Find(item.Annotation.Id) is not null || _records.WasDeleted(item.Annotation.Id))
            {
                continue;
            }

            _records.Add(new Record(item.Annotation) { Pending = true, Mine = true, Assets = item.Assets, Error = item.Refused });
        }
        _loadedFrom = store;
        RaiseChanged();
        return true;
    }

    private static Task OnMain(Action action) => IsMainThread ? Run(action) : MainThread.InvokeOnMainThreadAsync(action);

    private static Task<T> OnMain<T>(Func<T> read) => IsMainThread ? Task.FromResult(read()) : MainThread.InvokeOnMainThreadAsync(read);

    /// <summary>Whether this is the UI thread. Plain net10.0 (an app's unit tests) has no UI: every thread will do.</summary>
#if IOS || MACCATALYST || ANDROID || WINDOWS
    private static bool IsMainThread => MainThread.IsMainThread;
#else
    private static bool IsMainThread => true;
#endif

    private static Task Run(Action action)
    {
        action();
        return Task.CompletedTask;
    }

    // ---- the server: live updates over server-sent events ------------------------------------------------------------

    private void StartSync()
    {
        StopSync();
        // A new server (or none) starts afresh; Retry tries the same one again, which is still failing until it works.
        if (!_retrying)
        {
            _lastFailure = null;
        }

        if (!HasServer)
        {
            _client = Server is null ? null : new NotatoClient(_http, Server, Options.TokenFor(Server));
            SetConnection(NotatoConnection.Local, Mode == NotatoMode.Test ? null : "No server is set: notes stay on this device.");
            return;
        }
        _client = new NotatoClient(_http, Server!, Options.TokenFor(Server));
        _sync = new CancellationTokenSource();
        CancellationToken token = _sync.Token;
        NotatoClient c = _client;
        _ = Task.Run(() => SyncLoopAsync(c, token));
        Connectivity.Current.ConnectivityChanged += OnConnectivity;
    }

    private void StopSync()
    {
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
            // not available on plain net10.0
        }
    }

    private void OnConnectivity(object? sender, ConnectivityChangedEventArgs e)
    {
        if (e.NetworkAccess == NetworkAccess.Internet)
        {
            _ = FlushAsync();
        }
    }

    private async Task SyncLoopAsync(NotatoClient c, CancellationToken token)
    {
        TimeSpan delay = TimeSpan.FromSeconds(1);
        while (!token.IsCancellationRequested)
        {
            try
            {
                DispatchFor(token, () => SetConnection(NotatoConnection.Connecting, null));
                await foreach (ServerSentEvent e in c.EventsAsync(Options.Project, agent: Mode == NotatoMode.Agent, token))
                {
                    await OnServerEventAsync(c, e, token);
                    delay = TimeSpan.FromSeconds(1);
                }
                if (token.IsCancellationRequested)
                {
                    return;
                }

                DispatchFor(token, () => SetConnection(NotatoConnection.Offline, "The server closed the connection."));
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (NotatoServerException error) when (error.Permanent)
            {
                DispatchFor(token, () => SetConnection(NotatoConnection.Refused, error.Message));
                delay = TimeSpan.FromSeconds(30);
            }
            catch (Exception error)
            {
                string message = error is NotatoServerException ? error.Message : $"Lost the server at {c.BaseUrl}: {error.Message}";
                DispatchFor(token, () => SetConnection(NotatoConnection.Offline, message));
            }
            try
            {
                await Task.Delay(delay, token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            delay = TimeSpan.FromSeconds(Math.Min(10, delay.TotalSeconds * 2));
        }
    }

    internal async Task OnServerEventAsync(NotatoClient c, ServerSentEvent e, CancellationToken token)
    {
        switch (e.Event)
        {
            case "hello":
                DispatchFor(token, () => SetConnection(NotatoConnection.Connected, null));
                try
                {
                    ServerConfig config = await c.GetConfigAsync(token);
                    DispatchFor(token, () =>
                    {
                        _serverScreenshots = config.Screenshots;
                        SetMentions(config.Mentions, config.Agent);
                    });
                }
                catch (NotatoServerException)
                {
                    // an older server has no /config: screenshots stay as they are
                }
                // What an earlier connection heard goes in before the list, which is newer.
                await OnMain(DrainEvents);
                // The notes waiting here go first: they reach the agent without waiting behind a long list, and the
                // list asked for afterwards has them.
                await FlushAsync(c);
                // Only notes the server had already taken when the list was asked for can be missing from it because
                // they were deleted; a note sent or made since is newer than the list.
                HashSet<string> settled = await OnMain(_records.SettledIds);
                // Every page, or (if one fails) nothing: the connection then starts again and nothing is dropped. Only
                // what the toolbar shows: the board and the agent read the rest from the server.
                IReadOnlyList<StoredAnnotation> items = await c.ListAsync(Options.Project, summary: true, token);
                // Sorted out here, off the main thread; the main thread only puts it in place.
                ServerList listed = new(items, Options.Project);
                DispatchFor(token, () => Merge(listed, settled, c));
                break;
            case "created" or "updated" or "replied":
            {
                ServerEventData? data = Parse(e.Data);
                if (data?.Annotation is { } annotation)
                {
                    QueueEvent(new QueuedEvent(annotation, null, token));
                }

                break;
            }
            case "deleted":
            {
                ServerEventData? data = Parse(e.Data);
                if (data?.Id is { } id)
                {
                    QueueEvent(new QueuedEvent(null, id, token));
                }

                break;
            }
            case "mentions":
                try
                {
                    List<MentionInfo>? list = JsonSerializer.Deserialize(e.Data, NotatoJsonContext.Default.ListMentionInfo);
                    if (list is not null)
                    {
                        DispatchFor(token, () => SetMentions(list, null));
                    }
                }
                catch (JsonException)
                {
                    // malformed: keep what we had
                }
                break;
            case "agent":
                try
                {
                    AgentState? agent = JsonSerializer.Deserialize(e.Data, NotatoJsonContext.Default.AgentState);
                    if (agent is not null)
                    {
                        DispatchFor(token, () => SetMentions(null, agent));
                    }
                }
                catch (JsonException)
                {
                    // malformed: keep what we had
                }
                break;
            case "annotate-request":
                try
                {
                    AnnotateRequest? request = JsonSerializer.Deserialize(e.Data, NotatoJsonContext.Default.AnnotateRequest);
                    if (request is not null)
                    {
                        _ = AnswerRelayAsync(c, request);
                    }
                }
                catch (JsonException)
                {
                    // malformed: the server times it out
                }
                break;
        }
    }

    private static ServerEventData? Parse(string data)
    {
        try
        {
            return JsonSerializer.Deserialize(data, NotatoJsonContext.Default.ServerEventData);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Which notes to drop once the server's whole list is in: those it had already taken when the list was asked for
    /// (<paramref name="settledAtStart"/>) and no longer has. A note still to be sent, or sent or made since, is kept.
    /// </summary>
    internal static Predicate<Record> Gone(IReadOnlyList<StoredAnnotation> items, IReadOnlySet<string> settledAtStart) =>
        Gone(new HashSet<string>(items.Select(i => i.Annotation.Id), StringComparer.Ordinal), settledAtStart);

    internal static Predicate<Record> Gone(IReadOnlySet<string> onServer, IReadOnlySet<string> settledAtStart) =>
        r => !r.Pending && settledAtStart.Contains(r.Annotation.Id) && !onServer.Contains(r.Annotation.Id);

    /// <summary>
    /// Puts the server's list in place: each note found by its id (not by searching the list), those gone from the
    /// server dropped, and one change raised for all of it. A note still waiting here whose People only change the
    /// server's copy lacks stays to be sent, and is sent (to <paramref name="client"/>) once this is done.
    /// </summary>
    internal void Merge(ServerList list, IReadOnlySet<string> settledAtStart, NotatoClient? client = null)
    {
        bool replay = false;
        foreach (Annotation annotation in list.Notes)
        {
            if (_records.WasDeleted(annotation.Id))
            {
                continue;
            }

            if (_records.Find(annotation.Id) is not { } existing)
            {
                _records.Add(new Record(annotation));
                continue;
            }
            // The list leaves out what only the agent reads; the copy here has it.
            Annotation incoming = annotation.Context.Count == 0 && existing.Annotation.Context.Count > 0
                ? annotation with { Context = existing.Annotation.Context, Steps = annotation.Steps ?? existing.Annotation.Steps }
                : annotation;
            replay |= !Adopt(existing, incoming);
        }

        // Gone from the server while we were away.
        _records.RemoveAll(Gone(list.Ids, settledAtStart));
        RaiseChanged();
        if (replay)
        {
            _ = FlushAsync(client);
        }
    }

    /// <summary>A copy of a note from the server: a new note, or the newer copy of one known here.</summary>
    private void Upsert(Annotation annotation, bool raise = true)
    {
        // Another project's, or deleted here: an event or answer on its way does not bring it back.
        if (annotation.ProjectId != Options.Project || _records.WasDeleted(annotation.Id))
        {
            return;
        }

        if (_records.Find(annotation.Id) is not { } existing)
        {
            _records.Add(new Record(annotation));
        }
        else if (!Adopt(existing, annotation))
        {
            _ = FlushAsync();
        }

        if (raise)
        {
            RaiseChanged();
        }
    }

    /// <summary>
    /// Takes the server's copy of a note known here. A note still waiting to be sent is the server's from now on, and
    /// leaves the device; unless People only was turned on or off here after the server took its first copy (whose
    /// answer was lost), which that copy lacks: then it stays to be sent, and sending makes the change again. False then.
    /// </summary>
    private bool Adopt(Record existing, Annotation server)
    {
        if (!existing.Pending)
        {
            existing.Annotation = server;
            return true;
        }

        if (existing.Error is null && PeopleOnlyToggle.ToReplay(existing.Annotation, server) is not null)
        {
            return false;
        }

        existing.Annotation = server;
        existing.Pending = false;
        existing.Error = null;
        existing.Held = null;
        existing.Assets = null;
        if (_local is not null)
        {
            _ = _local.RemoveAsync(server.Id);
        }

        return true;
    }

    // ---- server events, applied together ----------------------------------------------------------------------

    /// <summary>A note's new copy (<c>created</c>, <c>updated</c>, <c>replied</c>), or the id of one deleted, from the loop with <c>Token</c>.</summary>
    internal readonly record struct QueuedEvent(Annotation? Annotation, string? Deleted, CancellationToken Token);

    /// <summary>How long events gather before they are applied together: a burst (an agent working through notes) is one change.</summary>
    internal static readonly TimeSpan EventBatch = TimeSpan.FromMilliseconds(100);

    private readonly Lock _eventsGate = new();
    private readonly List<QueuedEvent> _events = [];
    private bool _drainPlanned;

    /// <summary>
    /// Keeps an event to apply with the others that come within <see cref="EventBatch"/>: they are applied in order, on
    /// the main thread, and the overlay is drawn and <see cref="Changed"/> raised once for all of them.
    /// </summary>
    internal void QueueEvent(QueuedEvent e)
    {
        bool plan;
        lock (_eventsGate)
        {
            _events.Add(e);
            plan = !_drainPlanned;
            _drainPlanned = true;
        }
        if (plan)
        {
            _ = Task.Delay(EventBatch).ContinueWith(_ => Dispatch(DrainEvents), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }
    }

    /// <summary>Applies the events kept so far, and raises one change for them. Main thread.</summary>
    internal void DrainEvents()
    {
        List<QueuedEvent> batch;
        lock (_eventsGate)
        {
            _drainPlanned = false;
            if (_events.Count == 0)
            {
                return;
            }

            batch = [.. _events];
            _events.Clear();
        }
        bool changed = false;
        HashSet<string> deleted = new(StringComparer.Ordinal);
        foreach (QueuedEvent e in batch)
        {
            // A stopped loop's events are of the last server: dropped, as its other news is.
            if (e.Token.IsCancellationRequested)
            {
                continue;
            }

            if (e.Annotation is { } annotation)
            {
                Upsert(annotation, raise: false);
                changed = true;
            }
            else if (e.Deleted is { } id)
            {
                deleted.Add(id);
            }
        }
        // All of them in one pass over the notes. One still to be sent here is not the server's to delete.
        if (deleted.Count > 0)
        {
            changed |= _records.RemoveAll(r => !r.Pending && deleted.Contains(r.Annotation.Id)) > 0;
        }

        if (changed)
        {
            RaiseChanged();
        }
    }

    /// <summary>Agent mode: an agent asked, through <c>notato_annotate</c>, for an element of this app to be annotated.</summary>
    private async Task AnswerRelayAsync(NotatoClient c, AnnotateRequest request)
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
                    string route = _sessions.FirstOrDefault() is { } s ? SafeRoute(s.Window) : "?";
                    throw new InvalidOperationException($"no element on the screen matches \"{request.Args.Target}\" (the app is on {route}). MAUI selectors look like #AutomationId, Button:text(\"Sign in\") or LoginPage Entry[x:Name=Email].");
                }
                return await AnnotateAsync(element, request.Args.Comment, new AnnotateOptions
                {
                    AgentName = request.Args.Author ?? "agent",
                    Intent = request.Args.Intent,
                    Severity = request.Args.Severity,
                    Steps = request.Args.Steps,
                });
            });
            result = new RelayResult { Ok = true, AnnotationId = annotation.Id };
        }
        catch (Exception error)
        {
            result = new RelayResult { Ok = false, Error = error.Message };
        }
        try
        {
            await c.PostRelayResultAsync(request.RequestId, result);
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
            _ => (NotatoConnection?)null,
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

    internal string DescribeConnection()
    {
        string? where = Server is { } s ? new Uri(s).Authority : null;
        return _connection switch
        {
            NotatoConnection.Connected => $"Connected to {where}",
            NotatoConnection.Connecting => $"Connecting to {where}…",
            NotatoConnection.Offline => _connectionDetail ?? $"Cannot reach {where}",
            NotatoConnection.Refused => _connectionDetail ?? $"{where} refused this app",
            NotatoConnection.Local => Mode == NotatoMode.Test
                ? where is null ? "Notes stay on this device until packaged" : $"Notes stay on this device; a package is uploaded to {where}"
                : _connectionDetail ?? "No server",
            _ => _invalid ?? "Off",
        };
    }

    // ---- acting on a note, as the person ---------------------------------------------------------------------

    /// <summary>
    /// Opens a note's card. <paramref name="back"/> is where its Back goes: the list of notes it was opened from; none
    /// when its pin was tapped.
    /// </summary>
    internal void OpenPin(OverlaySession session, string id, Action? back = null)
    {
        IReadOnlyList<(int Number, Record Record)> list = RecordsOnRoute(session);
        (int Number, Record Record) found = list.FirstOrDefault(x => x.Record.Annotation.Id == id);
        Record? record = found.Record ?? _records.Find(id);
        if (record is null)
        {
            return;
        }

        PinCard card = new(this, session, record, found.Number == 0 ? 0 : found.Number, session.View.CloseSheet, back);
        // Opened from the list, it was opened from the toolbar's menu: folding the toolbar closes it.
        session.View.ShowSheet(card, dim: true, fromBar: back is not null);
    }

    internal void Toast(OverlaySession session, string message) => session.View.Toast(message);

    private NotatoClient Client => _client is not null && HasServer ? _client : throw new InvalidOperationException("Not connected to a Notato server.");

    private Author Me => Author.Human(AuthorName);

    /// <summary>The time now, as the notes and the server write it.</summary>
    private static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>Replies on a note. An <paramref name="aside"/> is for the people on the thread: the agent never gets it.</summary>
    internal async Task ReplyAsync(string id, string text, bool aside = false) => Upsert((await Client.ReplyAsync(id, text.Trim(), Me, aside)).Annotation);

    /// <summary>
    /// Turns People only on or off for a note, as the person. The server records the change in the thread. A note the
    /// server does not have yet (no server, test mode, or not sent yet) is changed here, with the same thread entry, so
    /// it goes (or is packaged) that way.
    /// </summary>
    internal async Task SetPeopleOnlyAsync(string id, bool on)
    {
        Record record = _records.Find(id) ?? throw new InvalidOperationException("That note is gone.");
        if (record.Pending)
        {
            // Waits for a send under way, so the change is not lost under the copy the server sends back.
            await _sending.WaitAsync();
            try
            {
                if (record.Pending)
                {
                    record.Annotation = PeopleOnlyToggle.Set(record.Annotation, on, Me, Ulid.New(), Now());
                    if (_local is not null)
                    {
                        // The note again; its screenshots are kept already.
                        await _local.SaveAsync(record.Annotation);
                    }

                    RaiseChanged();
                    return;
                }
            }
            finally
            {
                _sending.Release();
            }
        }
        Upsert((await Client.SetPeopleOnlyAsync(id, on, Me)).Annotation);
    }

    internal async Task RequestRevertAsync(string id, string? reason) =>
        Upsert((await Client.SetStatusAsync(id, Statuses.RevertRequested, string.IsNullOrWhiteSpace(reason) ? "Please undo this change." : reason.Trim(), Me)).Annotation);

    internal async Task CancelRevertAsync(string id) =>
        Upsert((await Client.SetStatusAsync(id, Statuses.Resolved, "Revert request taken back.", Me)).Annotation);

    internal async Task DeleteAsync(string id)
    {
        Record? record = _records.Find(id);
        if (record is { Pending: false } && HasServer)
        {
            await Client.DeleteAsync(id);
        }

        // Remembered for the rest of the run: a copy of it on its way (an event, a list, the answer to a send under
        // way) does not bring it back, and a send under way deletes it on the server once it lands.
        _records.MarkDeleted(id);
        _records.Remove(id);
        if (_local is not null)
        {
            await _local.RemoveAsync(id);
        }

        RaiseChanged();
    }

    internal void SaveSettings(string? name, bool screenshots, string? server)
    {
        _state.Author = name;
        _state.Screenshots = screenshots == Options.Screenshots ? null : screenshots;
        string? trimmed = string.IsNullOrWhiteSpace(server) ? null : server.Trim().TrimEnd('/');
        if (trimmed is not null && (!Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri) || uri.Scheme is not ("http" or "https")))
        {
            _sessions.FirstOrDefault()?.View.Toast($"\"{trimmed}\" is not an http(s) address; the server was not changed.");
            trimmed = _state.Server;
        }
        bool serverChanged = trimmed != _state.Server;
        _state.Server = trimmed == Options.ResolvedServer ? null : trimmed;
        if (serverChanged && _enabled)
        {
            _records.RemoveAll(r => !r.Pending);
            StartSync();
        }
        RenderAll();
    }

    // ---- test mode: a bundle zip -----------------------------------------------------------------------------------

    public async Task<string> PackageAsync(bool upload = true, CancellationToken cancellationToken = default)
    {
        string path = await PackageToFileAsync(cancellationToken);
        if (upload && Server is not null)
        {
            await UploadPackageAsync(path, cancellationToken);
        }

        return path;
    }

    /// <summary>Writes this device's notes to a bundle zip in the app's cache, off the main thread, and returns its path.</summary>
    private async Task<string> PackageToFileAsync(CancellationToken ct)
    {
        List<LocalAnnotation> mine = await MainThread.InvokeOnMainThreadAsync(() => _records
            .Where(r => r.Pending || Mode == NotatoMode.Test && r.Mine)
            .Select(r => new LocalAnnotation(r.Annotation, r.Assets ?? new Dictionary<string, string>()))
            .ToList());
        if (mine.Count == 0)
        {
            throw new InvalidOperationException("Nothing to package yet: make at least one note.");
        }

        return await BundleWriter.WriteAsync(mine, Options.Project, AuthorName, AppContextInfo.AppName(Options), AppContextInfo.AppVersion(Options), FileSystem.Current.CacheDirectory, ct);
    }

    /// <summary>
    /// Uploads a packaged zip from its file. One over the server's limit is not sent at all: the server would refuse
    /// it after the whole of it had gone.
    /// </summary>
    private async Task UploadPackageAsync(string path, CancellationToken ct)
    {
        long size = new FileInfo(path).Length;
        if (size > BundleWriter.ServerLimit)
        {
            throw new NotatoServerException($"the package is {MenuText.Megabytes(size)}, over the server's {MenuText.Megabytes(BundleWriter.ServerLimit)} limit. Share the zip instead.", 413);
        }

        NotatoClient uploader = new(_http, Server!, Options.TokenFor(Server));
        await uploader.UploadBundleAsync(Options.Project, path, ct);
    }

    /// <summary>Test mode: forget the notes kept on this device, once they have been packaged.</summary>
    internal async Task ClearLocalAsync()
    {
        _records.RemoveAll(r => r.Pending);
        if (_local is not null)
        {
            await _local.ClearAsync();
        }

        RaiseChanged();
    }

    internal async Task PackageFromMenuAsync(OverlaySession session)
    {
        try
        {
            string? uploadProblem = null;
            string path = await PackageToFileAsync(default);
            if (Server is not null)
            {
                try
                {
                    await UploadPackageAsync(path, default);
                }
                catch (NotatoServerException error)
                {
                    // The zip is written: it is shared all the same.
                    uploadProblem = error.Message;
                }
            }
            await Share.Default.RequestAsync(new ShareFileRequest { Title = "Notato feedback", File = new ShareFile(path, "application/zip") });
            session.View.Toast(uploadProblem is null
                ? Server is null ? "Packaged. Send the zip to the developer." : "Packaged and uploaded."
                : $"Packaged, but not uploaded: {uploadProblem}");
        }
        catch (Exception error)
        {
            session.View.Toast(error.Message);
        }
    }

    // ---- plumbing --------------------------------------------------------------------------------------------------

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

        Changed?.Invoke(this, EventArgs.Empty);
    }

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

    private static void Dispatch(Action action)
    {
        if (Application.Current?.Dispatcher is { } dispatcher)
        {
            if (dispatcher.IsDispatchRequired)
            {
                dispatcher.Dispatch(action);
            }
            else
            {
                action();
            }
        }
        else
        {
            action();
        }
    }

    public void Dispose()
    {
        StopSync();
        StopShake();
        _timer?.Stop();
        foreach (OverlaySession? session in _sessions.ToList())
        {
            Detach(session);
        }

        _http.Dispose();
    }
}
