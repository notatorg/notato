using Microsoft.Maui.Graphics;
using Notato.Maui.Runtime;
using System.Globalization;

namespace Notato.Maui.Overlay;

/// <summary>
/// The toolbar folding into one round button, apart from drawing it, so its rules can be tested on plain net10.0:
/// whether it is folded (remembered next to where it was dragged), the side it folds to, opening for annotating and
/// folding again after, where it sits so that its held edge stays put, and the timings and easings it moves with,
/// which are the web toolbar's.
/// </summary>
internal sealed class ToolbarFold(RuntimeState state, Func<bool> configured)
{
    /// <summary>Opened because annotating started while it was folded: it folds again when annotating stops.</summary>
    public bool OpenedForAnnotating { get; private set; }

    /// <summary>Folded as the person (else the configuration) left it, whatever annotating does for the moment.</summary>
    public bool Remembered => state.ToolbarCollapsed ?? configured();

    /// <summary>Whether it shows folded now.</summary>
    public bool Collapsed => Remembered && !OpenedForAnnotating;

    /// <summary>
    /// A person folded or opened it: remembered, and the end of any opening for annotating. Returns whether what shows
    /// changed.
    /// </summary>
    public bool Set(bool collapsed)
    {
        bool before = Collapsed;
        OpenedForAnnotating = false;
        state.ToolbarCollapsed = collapsed;
        return Collapsed != before;
    }

    /// <summary>
    /// Annotating (or selecting) started or stopped, from the toolbar, the menu or the app's code. Folded, it opens so
    /// the mode shows, without forgetting that it was folded; it folds again after only if it opened for this.
    /// Returns whether what shows changed.
    /// </summary>
    public bool AnnotatingChanged(bool annotating)
    {
        bool before = Collapsed;
        if (!annotating)
        {
            OpenedForAnnotating = false;
        }
        else if (Remembered)
        {
            OpenedForAnnotating = true;
        }

        return Collapsed != before;
    }

    // ---- the side it is held to ------------------------------------------------------------------------------------

    /// <summary>
    /// The rule for whether it folds to (and grows from) the right: once dragged, the nearer side of where it was
    /// left, else the side of its configured corner. <see cref="HeldSide"/> is what to use; it keeps the answer.
    /// </summary>
    public static bool HeldRight(Point? dragged, ToolbarCorner corner) =>
        dragged is { } fraction ? fraction.X >= 0.5 : corner is ToolbarCorner.BottomRight or ToolbarCorner.TopRight;

    // Kept in memory only, until the person moves the toolbar. A wide bar opened from a circle just right of the
    // middle ends up with its fraction left of it, and a narrow screen can push the opened bar along to fit; without
    // these, the next fold would go the other way, or to another place, and the circle would not come back.
    private bool? _side;
    private double? _openAt, _foldedAt;

    /// <summary>The side it folds to and grows from now (the chevron points this way): kept from its first fold or opening until it is moved.</summary>
    public bool HeldSide(Point? dragged, ToolbarCorner corner) => _side ?? HeldRight(dragged, corner);

    /// <summary>
    /// A fold (<paramref name="collapsing"/>) or an opening starts from a settled bar at <paramref name="fraction"/>.
    /// Keeps its side, remembers where it leaves from, and says where it goes: back to where it last was folded (or
    /// open), else to where its held edge stays put, as far as the bar fits.
    /// </summary>
    public Trip Start(bool collapsing, Room room, double fraction, double fromWidth, double toWidth, Point? dragged, ToolbarCorner corner)
    {
        bool right = _side ??= HeldRight(dragged, corner);
        if (collapsing)
        {
            _openAt = fraction;
        }
        else
        {
            _foldedAt = fraction;
        }

        return TurnAround(collapsing, room, right, HeldEdge(room.LeftAt(fraction, fromWidth), fromWidth, right), toWidth);
    }

    /// <summary>A change of mind mid-way (or the rest of <see cref="Start"/>): from the held edge where it is now.</summary>
    public Trip TurnAround(bool collapsing, Room room, bool heldRight, double fromEdge, double toWidth)
    {
        if ((collapsing ? _foldedAt : _openAt) is { } back)
        {
            return new Trip(heldRight, fromEdge, HeldEdge(room.LeftAt(back, toWidth), toWidth, heldRight), back);
        }

        double edge = heldRight
            ? Math.Clamp(fromEdge, Math.Min(room.MinLeft + toWidth, room.MaxRight), room.MaxRight)
            : Math.Clamp(fromEdge, room.MinLeft, room.MaxLeft(toWidth));
        return new Trip(heldRight, fromEdge, edge, null);
    }

    /// <summary>The person moved the toolbar (a drag, a reset, a new configuration): its side and places are worked out afresh.</summary>
    public void Moved()
    {
        _side = null;
        ForgetPlaces();
    }

    /// <summary>The window changed size: where it was folded and open no longer hold, though its side does.</summary>
    public void ForgetPlaces() => _openAt = _foldedAt = null;

    /// <summary>Where the bar can go across the window: its left from <see cref="MinLeft"/>, its right up to <see cref="MaxRight"/>.</summary>
    public readonly record struct Room(double MinLeft, double MaxRight)
    {
        public double MaxLeft(double width) => Math.Max(MinLeft, MaxRight - width);
        public double LeftAt(double fraction, double width) => PlaceAt(fraction, MinLeft, MaxLeft(width));
        public double? FractionAt(double left, double width) => ToolbarFold.FractionAt(left, MinLeft, MaxLeft(width));
    }

    /// <summary>
    /// A fold or an opening: the side it is held to, and its held edge before and after. The edge moves only when it
    /// goes back to a place it was (<see cref="ToFraction"/>), or has to move over to fit.
    /// </summary>
    public readonly record struct Trip(bool HeldRight, double FromEdge, double ToEdge, double? ToFraction)
    {
        /// <summary>The held edge part-way, on the same curve as the width.</summary>
        public double EdgeAt(double t) => FromEdge + (ToEdge - FromEdge) * t;

        /// <summary>The fraction it ends at, at its new width.</summary>
        public double? Arrival(Room room, double width) => ToFraction ?? room.FractionAt(LeftFromEdge(ToEdge, width, HeldRight), width);
    }

    /// <summary>The items of the bar from left to right, reordered nearest the held side first: where the sweep starts.</summary>
    public static List<T> NearestHeldFirst<T>(IEnumerable<T> leftToRight, bool heldRight)
    {
        List<T> items = [.. leftToRight];
        if (heldRight)
        {
            items.Reverse();
        }

        return items;
    }

    // ---- where it sits ---------------------------------------------------------------------------------------------

    /// <summary>The bar's left (or top) at a fraction of the room it can move in, as the web's <c>placeAt</c>.</summary>
    public static double PlaceAt(double fraction, double min, double max) => min + (max - min) * fraction;

    /// <summary>The fraction for a left (or top): the inverse of <see cref="PlaceAt"/>. Null when there is no room to move in.</summary>
    public static double? FractionAt(double position, double min, double max) =>
        max > min ? Math.Clamp((position - min) / (max - min), 0, 1) : null;

    /// <summary>The edge that stays put while it folds or opens.</summary>
    public static double HeldEdge(double left, double width, bool heldRight) => heldRight ? left + width : left;

    /// <summary>The left of the bar at a width, with its held edge where it is.</summary>
    public static double LeftFromEdge(double edge, double width, bool heldRight) => heldRight ? edge - width : edge;

    // ---- the round button's badge and dot --------------------------------------------------------------------------

    /// <summary>The count on the round button: null (hidden) at none, "99+" past 99.</summary>
    public static string? BadgeText(int count) =>
        count <= 0 ? null : count > 99 ? "99+" : count.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The dot on the round button, and on the open bar's ⋯: it only speaks up when something is wrong. Null (no dot)
    /// when connected or with no server.
    /// </summary>
    public static string? DotColor(NotatoConnection connection) => connection switch
    {
        NotatoConnection.Connecting => "#e9b44c",
        NotatoConnection.Offline or NotatoConnection.Refused => "#ef6b5e",
        _ => null,
    };

    /// <summary>
    /// The bar's corner at <paramref name="width"/>: <paramref name="open"/> on the open bar, rounding into the circle
    /// (half its <paramref name="height"/>) over the last 40 of a fold.
    /// </summary>
    public static double Corner(double width, double height, double open) =>
        Math.Clamp(height / 2 - (width - height) * (height / 2 - open) / 40, open, height / 2);

    // ---- timings (ms), as the web toolbar has them ------------------------------------------------------------------

    /// <summary>Opening: the width springs out to the full bar.</summary>
    public const double OpenMs = 560;
    /// <summary>Folding: the width eases in to the round button.</summary>
    public const double FoldMs = 420;
    /// <summary>Opening: the round button turns away.</summary>
    public const double FabOutMs = 180;
    /// <summary>Opening: each button fades in, close behind the edge, which covers most of the way in the first 150ms.</summary>
    public const double ItemInMs = 280;
    /// <summary>Folding: each button fades out as the edge comes in over it, the far ones first.</summary>
    public const double ItemOutMs = 160;
    /// <summary>Folding: then the round button turns in.</summary>
    public const double FabInDelayMs = 170;
    public const double FabInMs = 460;
    /// <summary>Folding: and its count pops in last.</summary>
    public const double BadgeInDelayMs = 400;
    public const double BadgeInMs = 380;

    /// <summary>Opening: when the button at <paramref name="index"/> from the held side starts to fade in.</summary>
    public static double ItemInDelay(int index) => 25 + 18 * index;

    /// <summary>Folding: when the button at <paramref name="index"/> from the far side starts to fade out.</summary>
    public static double ItemOutDelay(int index) => 16 * index;

    // ---- easings -------------------------------------------------------------------------------------------------

    private const double Zeta = 0.68; // damping ratio
    private const double ZetaOmega = 6; // within 0.25% of the end by t = 1
    private static readonly double Damped = ZetaOmega / Zeta * Math.Sqrt(1 - Zeta * Zeta);
    private static readonly double SineWeight = Zeta / Math.Sqrt(1 - Zeta * Zeta);
    private static readonly double SpringEnd = RawSpring(1);

    private static double RawSpring(double t) => 1 - Math.Exp(-ZetaOmega * t) * (Math.Cos(Damped * t) + SineWeight * Math.Sin(Damped * t));

    /// <summary>
    /// A damped spring: quick off the mark, one small overshoot (about 5%, at about half way), settled by the end.
    /// Scaled so it ends exactly at 1.
    /// </summary>
    public static double Spring(double t) => t <= 0 ? 0 : t >= 1 ? 1 : RawSpring(t) / SpringEnd;

    /// <summary>CSS <c>cubic-bezier(0.32, 0.72, 0, 1)</c>: fast, then a long gentle settle.</summary>
    public static readonly Func<double, double> Settle = CubicBezier(0.32, 0.72, 0, 1);

    /// <summary>CSS <c>ease-in</c>.</summary>
    public static readonly Func<double, double> EaseIn = CubicBezier(0.42, 0, 1, 1);

    /// <summary>A CSS <c>cubic-bezier()</c> timing function.</summary>
    public static Func<double, double> CubicBezier(double x1, double y1, double x2, double y2)
    {
        double cx = 3 * x1;
        double bx = 3 * (x2 - x1) - cx;
        double ax = 1 - cx - bx;
        double cy = 3 * y1;
        double by = 3 * (y2 - y1) - cy;
        double ay = 1 - cy - by;
        double X(double s) => ((ax * s + bx) * s + cx) * s;
        double Y(double s) => ((ay * s + by) * s + cy) * s;
        double Slope(double s) => (3 * ax * s + 2 * bx) * s + cx;

        return t =>
        {
            if (t <= 0)
            {
                return 0;
            }

            if (t >= 1)
            {
                return 1;
            }
            // Newton's method is quick where the curve is steep enough; halving finishes the rest.
            double s = t;
            for (int i = 0; i < 8; i++)
            {
                double error = X(s) - t;
                if (Math.Abs(error) < 1e-7)
                {
                    return Y(s);
                }

                double slope = Slope(s);
                if (Math.Abs(slope) < 1e-6)
                {
                    break;
                }

                s -= error / slope;
            }
            double lo = 0, hi = 1;
            s = t;
            for (int i = 0; i < 60 && hi - lo > 1e-9; i++)
            {
                double x = X(s);
                if (Math.Abs(x - t) < 1e-7)
                {
                    break;
                }

                if (x < t)
                {
                    lo = s;
                }
                else
                {
                    hi = s;
                }

                s = (lo + hi) / 2;
            }
            return Y(s);
        };
    }
}
