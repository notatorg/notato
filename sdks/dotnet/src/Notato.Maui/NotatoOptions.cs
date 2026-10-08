namespace Notato.Maui;

/// <summary>Who annotates, and where the notes go. Matches the web SDK's <c>mode</c>.</summary>
public enum NotatoMode
{
    /// <summary>The developer, live to a local <c>notato dev</c> server that your coding agent reads over MCP.</summary>
    Dev,
    /// <summary>A tester. Notes are kept on the device and packaged as a zip, and uploaded when a server is set.</summary>
    Test,
    /// <summary>An AI agent driving the app. Like dev, and the app also takes <c>notato_annotate</c> requests.</summary>
    Agent,
}

/// <summary>The corner of the window the toolbar starts in, until someone drags it.</summary>
public enum ToolbarCorner
{
    /// <summary>Bottom right, a little up so it is clear of a tab bar.</summary>
    BottomRight,
    /// <summary>Bottom left, a little up so it is clear of a tab bar.</summary>
    BottomLeft,
    /// <summary>Top right, below the status bar.</summary>
    TopRight,
    /// <summary>Top left, below the status bar.</summary>
    TopLeft,
}

/// <summary>
/// Settings for Notato, bound from configuration (the <c>Notato</c> section by default) and/or set in code in
/// <c>MauiProgram</c>. Values set at runtime (<see cref="INotato.Enable"/>, the settings sheet) are remembered on the
/// device and win over these until they are reset.
/// </summary>
public sealed class NotatoOptions
{
    /// <summary>The configuration section <c>UseNotato(IConfiguration)</c> binds when given the root.</summary>
    public const string SectionName = "Notato";

    /// <summary>The default server: what <c>notato dev</c> listens on.</summary>
    public const string DefaultServer = "http://localhost:4747";

    /// <summary>
    /// Whether Notato is on when the app starts. It can be switched at runtime with <see cref="INotato.Enable"/> and
    /// <see cref="INotato.Disable"/>, and that choice is remembered (see <see cref="RememberRuntimeState"/>). To ship
    /// nothing at all, leave <c>UseNotato</c> out of the build (for example behind <c>#if DEBUG</c>).
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Who annotates, and where the notes go: <see cref="NotatoMode.Dev"/> unless set.</summary>
    public NotatoMode Mode { get; set; } = NotatoMode.Dev;

    /// <summary>Project id on the server, e.g. <c>checkout-app</c>. Letters, digits and <c>. _ - @</c>. Required.</summary>
    public string Project { get; set; } = "";

    /// <summary>
    /// The Notato server. Defaults to <see cref="DefaultServer"/> in dev and agent mode and to none in test mode, where
    /// notes then only leave the device as a zip. Set it to an empty string to work with no server. When it is not set
    /// and the app was built while <c>notato dev --tunnel</c> ran, a phone (or the Android emulator) uses that dev
    /// tunnel and its device token, and the iOS simulator that server's local address.
    /// </summary>
    public string? Server { get; set; }

    /// <summary>
    /// A project token (<c>pft_…</c>) for a shared server (<c>notato serve</c>). Not needed for <c>notato dev</c>. It is
    /// only ever sent to the server configured here (its scheme, host and port), never to one typed into the settings
    /// sheet.
    /// </summary>
    public string? Token { get; set; }

    /// <summary>Recorded on every annotation. Defaults to the app's name.</summary>
    public string? AppName { get; set; }

    /// <summary>Recorded on every annotation. Defaults to the app's version and build.</summary>
    public string? AppVersion { get; set; }

    /// <summary>The name written on this person's notes and replies. They can change it in the settings sheet.</summary>
    public string? Author { get; set; }

    /// <summary>Take screenshots. A server that has them turned off wins either way.</summary>
    public bool Screenshots { get; set; } = true;

    /// <summary>
    /// Cover inputs (Entry, Editor, SearchBar) in screenshots and leave what is typed in them out of notes. Defaults to on
    /// in test and agent mode, off in dev mode. Password entries always are. Mark anything else private with
    /// <c>notato:Feedback.Mask="True"</c>, and opt an input out with <c>notato:Feedback.Mask="False"</c>.
    /// </summary>
    public bool? MaskInputs { get; set; }

    /// <summary>Show the floating toolbar. Off still lets the app drive Notato through <see cref="INotato"/>.</summary>
    public bool ShowToolbar { get; set; } = true;

    /// <summary>Where the toolbar starts. People can drag it anywhere; that position is remembered.</summary>
    public ToolbarCorner ToolbarPosition { get; set; } = ToolbarCorner.BottomRight;

    /// <summary>
    /// Whether the toolbar starts folded into one round button, out of the app's way. People open it with a tap and
    /// fold it again with its chevron; that is remembered. It opens by itself while annotating.
    /// </summary>
    public bool ToolbarCollapsed { get; set; }

    /// <summary>Shaking the device shows or hides the toolbar (iOS and Android).</summary>
    public bool ShakeToToggle { get; set; } = true;

    /// <summary>Remember runtime choices (on or off, toolbar shown, name, a server set in the app) across launches.</summary>
    public bool RememberRuntimeState { get; set; } = true;

    /// <summary>
    /// Turn on MAUI's XAML source info so each annotation says which XAML file and line an element was written at. It
    /// applies to pages created after start-up, in builds that inflate XAML at runtime or with diagnostics (Debug).
    /// </summary>
    public bool XamlSourceInfo { get; set; } = true;

    /// <summary>
    /// The app project's folder from the repository root, e.g. <c>src/MyApp</c>, put in front of XAML paths. Worked
    /// out at build time by the package's MSBuild targets; set it when that guess is wrong.
    /// </summary>
    public string? ProjectPath { get; set; }

    /// <summary>Attach the app's recent warnings and errors (from <c>ILogger</c>) to each annotation.</summary>
    public bool CaptureLogs { get; set; } = true;

    /// <summary>How many log messages to keep.</summary>
    public int LogLimit { get; set; } = 50;

    /// <summary>The scale screenshots are stored at, at most. Phones are 3x; 2x is plenty to read and half the size.</summary>
    public double MaxScreenshotScale { get; set; } = 2;

    internal string? ResolvedServer => ResolveServer(Runtime.DeviceAccess.Recorded, Runtime.DeviceAccess.ReachesLoopback);

    internal string? ResolveServer(Runtime.DeviceAccess? device, bool reachesLoopback) => Server is null
        ? Mode == NotatoMode.Test ? null : device?.ServerFor(reachesLoopback) ?? DefaultServer
        : string.IsNullOrWhiteSpace(Server) ? null : Server.Trim().TrimEnd('/');

    /// <summary>
    /// The token for <paramref name="server"/>: the configured one when it is the configured server, else the device
    /// token when it is the dev tunnel that token belongs to. Any other server (one typed into the settings sheet, say)
    /// gets none, so a token never goes anywhere it was not meant for.
    /// </summary>
    internal string? TokenFor(string? server) => TokenFor(server, Runtime.DeviceAccess.Recorded, Runtime.DeviceAccess.ReachesLoopback);

    internal string? TokenFor(string? server, Runtime.DeviceAccess? device, bool reachesLoopback) =>
        !string.IsNullOrWhiteSpace(Token) && SameOrigin(server, ResolveServer(device, reachesLoopback)) ? Token : device?.TokenFor(server);

    /// <summary>Whether two addresses are the same origin: scheme, host (in any case) and port, the default port included.</summary>
    internal static bool SameOrigin(string? a, string? b) =>
        Uri.TryCreate(a, UriKind.Absolute, out Uri? x) && Uri.TryCreate(b, UriKind.Absolute, out Uri? y)
        && x.Scheme.Equals(y.Scheme, StringComparison.OrdinalIgnoreCase)
        && x.IdnHost.Equals(y.IdnHost, StringComparison.OrdinalIgnoreCase)
        && x.Port == y.Port;

    internal bool ResolvedMaskInputs => MaskInputs ?? Mode != NotatoMode.Dev;
}
