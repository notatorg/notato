using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Overlay;

// The overlay's colours and icons: the design's tokens, the same in every Notato SDK.
internal static partial class Ui
{
    // ---- the toolbar: always dark -----------------------------------------------------------------------------------

    public static readonly Color Bar = Color.FromArgb("#17181b");
    public static readonly Color BarText = Color.FromArgb("#eceded");
    public static readonly Color BarMuted = Color.FromArgb("#8b8f97");
    /// <summary>A pressed button, and the count's pill, on the bar.</summary>
    public static readonly Color BarPressed = Color.FromArgb("#2a2c31");
    public static readonly Color BarLine = Color.FromArgb("#33353a");
    /// <summary>Annotate while it is on, and the folded button's count.</summary>
    public static readonly Color BarAccent = Color.FromArgb("#45bfa8");
    public static readonly Color BarAccentText = Color.FromArgb("#0b1f1b");

    // ---- the accent and the other fixed colours ---------------------------------------------------------------------

    /// <summary>Teal: buttons, the primary tile, selected chips, open pins. The board's brand colour.</summary>
    public static readonly Color Accent = Color.FromArgb("#1f8a78");
    public static readonly Color Danger = Color.FromArgb("#d6453d");
    /// <summary>A note's card when the note has not reached the server yet.</summary>
    public static readonly Color NotSent = Color.FromArgb("#b45309");
    public static readonly Color Selection = Color.FromArgb("#e5484d");
    public static readonly Color Paper = Colors.White;

    // ---- connection -------------------------------------------------------------------------------------------------

    public static readonly Color Connected = Color.FromArgb("#2e9a5b");
    public static readonly Color Connecting = Color.FromArgb("#e9b44c");
    public static readonly Color Offline = Color.FromArgb("#ef6b5e");

    // ---- sheets and cards: follow the system's light or dark setting ------------------------------------------------

    private static bool Dark => Application.Current?.RequestedTheme == AppTheme.Dark;

    public static Color CardBackground => Dark ? Color.FromArgb("#1d1e21") : Paper;
    public static Color CardText => Dark ? Color.FromArgb("#e6e7ea") : Color.FromArgb("#1d1f22");
    public static Color CardMuted => Dark ? Color.FromArgb("#8f939b") : Color.FromArgb("#686c72");
    public static Color CardLine => Dark ? Color.FromArgb("#2f3136") : Color.FromArgb("#e4e4df");
    /// <summary>Icon tiles, replies, quiet fills.</summary>
    public static Color Soft => Dark ? Color.FromArgb("#26272b") : Color.FromArgb("#f2f2ef");

    /// <summary>A pin's colour for its status, as on the web board.</summary>
    public static Color StatusColor(string status) => Color.FromArgb(StatusHex(status));

    public static string StatusHex(string status) => status switch
    {
        Statuses.Acknowledged => "#d99a1e",
        Statuses.Resolved => "#2e9a5b",
        Statuses.RevertRequested => "#8b5cf6",
        Statuses.VariantChosen => "#0891b2",
        Statuses.Reverted => "#64748b",
        Statuses.Dismissed => "#9a9a9a",
        _ => "#1f8a78",
    };

    /// <summary><paramref name="color"/> at <paramref name="amount"/> over the card's background, as CSS's color-mix does.</summary>
    public static Color Tint(Color color, double amount)
    {
        Color under = CardBackground;
        float Mix(float top, float bottom) => (float)((top * amount) + (bottom * (1 - amount)));
        return new Color(Mix(color.Red, under.Red), Mix(color.Green, under.Green), Mix(color.Blue, under.Blue));
    }

    /// <summary>A status (or severity) badge: its colour, faintly behind it.</summary>
    public static (Color Back, Color Fore) BadgeColors(string value)
    {
        Color? color = value switch
        {
            Severities.Blocker => Danger,
            Statuses.Open or Statuses.Acknowledged or Statuses.Resolved or Statuses.RevertRequested or Statuses.Reverted
                or Statuses.VariantChosen or Statuses.Dismissed => StatusColor(value),
            _ => null,
        };
        return color is null ? (Soft, CardMuted) : (Tint(color, 0.14), color);
    }

    // ---- icons: 24x24 stroke drawings, the design's (the web toolbar's and the other native SDKs') ------------------

    public const string IconCrosshair = "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 1.5V6M12 18v4.5M1.5 12H6M18 12h4.5";
    public const string IconEye = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0";
    public const string IconEyeOff = "M2 2l20 20M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 1 0 4.2 4.2";
    public const string IconList = "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01";
    public const string IconPackage = "M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8";
    public const string IconTrash = "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2";
    public const string IconSliders = "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6";
    public const string IconMinimize = "M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3";
    public const string IconPower = "M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0";
    public const string IconClose = "M6 6l12 12M18 6L6 18";
    public const string IconUp = "M12 19V5M5 12l7-7 7 7";
    public const string IconChevronLeft = "M15 6l-6 6 6 6";
    public const string IconChevronRight = "M9 6l6 6-6 6";
    public const string IconCamera = "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3zM15 13a3 3 0 1 1-6 0a3 3 0 1 1 6 0";

    // Filled dots, as path data: the bar's grip and its "more" button.
    public static readonly string IconGrip = Dots(1.6, (9, 6), (15, 6), (9, 12), (15, 12), (9, 18), (15, 18));
    public static readonly string IconMore = Dots(1.8, (5, 12), (12, 12), (19, 12));

    private static string Dots(double r, params (double X, double Y)[] centres) => string.Concat(centres.Select(c => string.Create(
        CultureInfo.InvariantCulture, $"M{c.X - r} {c.Y}a{r} {r} 0 1 0 {2 * r} 0a{r} {r} 0 1 0 {-2 * r} 0z")));
}
