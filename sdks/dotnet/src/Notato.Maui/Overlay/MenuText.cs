using System.Globalization;

namespace Notato.Maui.Overlay;

/// <summary>What a row of the ⋯ sheet does when tapped.</summary>
internal enum MenuAction
{
    Annotate,
    TogglePins,
    Notes,
    Package,
    Clear,
    Settings,
    HideToolbar,
    TurnOff,
}

/// <summary>How a row's icon tile and title are drawn: the teal tile, a plain one, or red for what cannot be undone.</summary>
internal enum MenuRowKind
{
    Plain,
    Primary,
    Danger,
}

/// <summary>One row of the ⋯ sheet. Rows of a new <paramref name="Group"/> get a rule above them.</summary>
internal sealed record MenuRow(MenuAction Action, string Icon, string Title, string Subtitle, MenuRowKind Kind, bool Chevron, int Group);

/// <summary>What the ⋯ sheet's rows depend on.</summary>
internal readonly record struct MenuFacts(NotatoMode Mode, bool PinsVisible, int OnScreen, int All, int Pending, bool Shake);

/// <summary>
/// What the toolbar and its ⋯ sheet say and which colours they use, apart from drawing them, so it can be tested on
/// plain net10.0.
/// </summary>
internal static class MenuText
{
    /// <summary>The count on the bar's Annotate: always shown, "0" included, "99+" past 99.</summary>
    public static string BarCount(int count) =>
        count <= 0 ? "0" : count > 99 ? "99+" : count.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The connection as the toolbar shows it. After a failure the SDK keeps trying by itself (connecting, failing,
    /// waiting longer each time): those tries still show the failure, so the bar and the sheet do not flicker. A try the
    /// person asked for with Retry shows as connecting.
    /// </summary>
    public static NotatoConnection Shown(NotatoConnection connection, NotatoConnection? lastFailure, bool retrying) =>
        connection == NotatoConnection.Connecting && lastFailure is { } failure && !retrying ? failure : connection;

    /// <summary>The sheet's status pill and its colour: none when there is no server to be connected to.</summary>
    public static (string Label, string Color)? Pill(NotatoConnection shown, bool hasServer) => !hasServer ? null : shown switch
    {
        NotatoConnection.Connected => ("Connected", "#2e9a5b"),
        NotatoConnection.Connecting => ("Connecting…", "#d99a1e"),
        NotatoConnection.Offline => ("Offline", "#ef6b5e"),
        NotatoConnection.Refused => ("Refused", "#ef6b5e"),
        _ => null,
    };

    /// <summary>The server's host and port, as the sheet names it ("localhost:4792").</summary>
    public static string? Host(string? server) =>
        server is not null && Uri.TryCreate(server, UriKind.Absolute, out Uri? uri) ? uri.Authority : null;

    /// <summary>The line under "Notato": the mode, then the server, or where the notes stay without one.</summary>
    public static string SubLine(NotatoMode mode, string? server, string device) =>
        $"{mode} mode · " + (Host(server) ?? $"notes stay on this {device}");

    /// <summary>The banner when the server cannot be reached (or refused this app): its title and its line.</summary>
    public static (string Title, string Body) Banner(NotatoConnection failure, string? server, string? detail, string device)
    {
        string host = Host(server) ?? "The server";
        return failure == NotatoConnection.Refused
            ? ("The server refused this app", detail ?? $"{host} refused this app. Notes stay on this {device}.")
            : ("Can't reach the server", $"{host} isn't answering. Notes stay on this {device} and send when it's back.");
    }

    public static string PinsLine(int onScreen) => onScreen switch
    {
        <= 0 => "No pins on this screen",
        1 => "1 pin on this screen",
        _ => $"{onScreen} pins on this screen",
    };

    public static string NotesLine(int onScreen, int all) => $"{onScreen} on this screen · {all} in all";

    public static string ClearLine(int pending) =>
        pending == 1 ? "Removes the note on this device" : $"Removes all {pending} from this device";

    /// <summary>A size as people read it: <c>100 MB</c>, <c>104.9 MB</c>.</summary>
    public static string Megabytes(long bytes) =>
        (bytes / (1024.0 * 1024)).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + " MB";

    /// <summary>
    /// The sheet's rows, in their groups: what to do, then (in test mode, with notes to send) the package, then settings,
    /// then putting Notato away.
    /// </summary>
    public static List<MenuRow> Rows(MenuFacts facts)
    {
        List<MenuRow> rows =
        [
            new(MenuAction.Annotate, Ui.IconCrosshair, "Annotate", "Tap an element, write a note", MenuRowKind.Primary, false, 0),
            new(MenuAction.TogglePins, facts.PinsVisible ? Ui.IconEyeOff : Ui.IconEye, facts.PinsVisible ? "Hide pins" : "Show pins",
                PinsLine(facts.OnScreen), MenuRowKind.Plain, false, 0),
            new(MenuAction.Notes, Ui.IconList, "Notes", NotesLine(facts.OnScreen, facts.All), MenuRowKind.Plain, true, 0),
        ];
        if (facts.Mode == NotatoMode.Test && facts.Pending > 0)
        {
            rows.Add(new(MenuAction.Package, Ui.IconPackage, "Package and share", "Zip with screenshots, share anywhere", MenuRowKind.Plain, true, 1));
            rows.Add(new(MenuAction.Clear, Ui.IconTrash, "Clear notes", ClearLine(facts.Pending), MenuRowKind.Danger, false, 1));
        }
        rows.Add(new(MenuAction.Settings, Ui.IconSliders, "Settings", "Your name, screenshots, server", MenuRowKind.Plain, true, 2));
        rows.Add(new(MenuAction.HideToolbar, Ui.IconMinimize, "Hide toolbar", facts.Shake ? "Shake to bring it back" : "The app can bring it back", MenuRowKind.Plain, false, 3));
        rows.Add(new(MenuAction.TurnOff, Ui.IconPower, "Turn Notato off", "Until the app turns it on again", MenuRowKind.Danger, false, 3));
        return rows;
    }
}
