using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Maui.Graphics;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;

namespace Notato.Maui.Tests;

public class ToolbarFoldTests
{
    // ---- remembered next to the toolbar's place -----------------------------------------------------------------

    [Fact]
    public void Folding_is_kept_in_the_runtime_state_and_read_back_on_the_next_start()
    {
        // remember: true falls back to memory on plain net10.0, which has no preferences store.
        RuntimeState state = new(remember: true);
        ToolbarFold fold = new(state, () => false);
        Assert.False(fold.Collapsed);
        Assert.True(fold.Set(true));
        Assert.True(state.ToolbarCollapsed);

        ToolbarFold restarted = new(state, () => false);
        Assert.True(restarted.Collapsed);
        Assert.False(restarted.Set(true));
        Assert.True(restarted.Set(false));
        Assert.False(state.ToolbarCollapsed);
    }

    [Fact]
    public void The_configuration_decides_until_a_person_does_and_a_reset_goes_back_to_it()
    {
        RuntimeState state = new(remember: false);
        bool configured = true;
        ToolbarFold fold = new(state, () => configured);
        Assert.True(fold.Collapsed);
        Assert.Null(state.ToolbarCollapsed);

        fold.Set(false);
        configured = true;
        Assert.False(fold.Collapsed);

        state.ToolbarPosition = new Point(0.3, 0.4);
        state.Reset();
        Assert.Null(state.ToolbarPosition);
        Assert.Null(state.ToolbarCollapsed);
        Assert.True(fold.Collapsed);
    }

    // ---- annotating opens it, and folds it again after --------------------------------------------------------------

    [Fact]
    public void Annotating_opens_a_folded_bar_without_forgetting_and_folds_it_again_after()
    {
        RuntimeState state = new(remember: false);
        ToolbarFold fold = new(state, () => false);
        fold.Set(true);

        Assert.True(fold.AnnotatingChanged(true));
        Assert.False(fold.Collapsed);
        Assert.True(fold.OpenedForAnnotating);
        // Still folded as far as the next start is concerned.
        Assert.True(state.ToolbarCollapsed);

        Assert.True(fold.AnnotatingChanged(false));
        Assert.True(fold.Collapsed);
        Assert.False(fold.OpenedForAnnotating);
    }

    [Fact]
    public void An_open_bar_stays_open_when_annotating_stops()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        Assert.False(fold.AnnotatingChanged(true));
        Assert.False(fold.OpenedForAnnotating);
        Assert.False(fold.AnnotatingChanged(false));
        Assert.False(fold.Collapsed);
    }

    [Fact]
    public void Opening_or_folding_by_hand_while_annotating_is_what_stays()
    {
        RuntimeState state = new(remember: false);
        ToolbarFold fold = new(state, () => false);
        fold.Set(true);
        fold.AnnotatingChanged(true);
        // Opened for annotating, then opened by hand: it stays open when annotating stops.
        Assert.False(fold.Set(false));
        Assert.False(fold.OpenedForAnnotating);
        Assert.False(fold.AnnotatingChanged(false));
        Assert.False(fold.Collapsed);

        // Folded by hand mid-way: it stays folded, and the next annotating opens it again.
        fold.Set(true);
        fold.AnnotatingChanged(true);
        Assert.True(fold.Set(true));
        Assert.True(fold.Collapsed);
        Assert.False(fold.AnnotatingChanged(false));
        Assert.True(fold.Collapsed);
        Assert.True(fold.AnnotatingChanged(true));
        Assert.False(fold.Collapsed);
    }

    [Fact]
    public void Starting_annotating_from_the_apps_code_opens_the_folded_toolbar_and_stopping_folds_it()
    {
        NotatoOptions options = new()
        {
            Project = "fold-test",
            Server = "",
            RememberRuntimeState = false,
            ToolbarCollapsed = true,
            CaptureLogs = false,
            ShakeToToggle = false,
        };
        NotatoController controller = new(new FixedOptions(options), NullLogger<NotatoController>.Instance);
        controller.Start();
        Assert.True(controller.IsEnabled);
        Assert.True(controller.ToolbarCollapsed);

        controller.StartAnnotating();
        Assert.True(controller.IsAnnotating);
        Assert.False(controller.ToolbarCollapsed);
        controller.StopAnnotating();
        Assert.True(controller.ToolbarCollapsed);

        // Opened by hand while annotating: it stays open after.
        controller.StartAnnotating();
        controller.SetToolbarCollapsed(false);
        controller.StopAnnotating();
        Assert.False(controller.ToolbarCollapsed);

        // Switching Notato off stops annotating, which folds a bar that opened for it.
        controller.SetToolbarCollapsed(true);
        controller.StartAnnotating();
        Assert.False(controller.ToolbarCollapsed);
        controller.Disable();
        Assert.True(controller.ToolbarCollapsed);
        controller.Dispose();
    }

    private sealed class FixedOptions(NotatoOptions value) : IOptionsMonitor<NotatoOptions>
    {
        public NotatoOptions CurrentValue => value;
        public NotatoOptions Get(string? name) => value;
        public IDisposable? OnChange(Action<NotatoOptions, string?> listener) => null;
    }

    // ---- the side it folds to: where the chevron points ------------------------------------------------------------

    [Theory]
    [InlineData(ToolbarCorner.BottomRight, true)]
    [InlineData(ToolbarCorner.TopRight, true)]
    [InlineData(ToolbarCorner.BottomLeft, false)]
    [InlineData(ToolbarCorner.TopLeft, false)]
    public void Never_dragged_it_folds_to_its_corners_side(ToolbarCorner corner, bool right) =>
        Assert.Equal(right, ToolbarFold.HeldRight(null, corner));

    [Theory]
    [InlineData(0.5, ToolbarCorner.BottomLeft, true)]
    [InlineData(1, ToolbarCorner.TopLeft, true)]
    [InlineData(0.4999, ToolbarCorner.BottomRight, false)]
    [InlineData(0, ToolbarCorner.TopRight, false)]
    public void Dragged_it_folds_to_the_nearer_side(double x, ToolbarCorner corner, bool right) =>
        Assert.Equal(right, ToolbarFold.HeldRight(new Point(x, 0.5), corner));

    [Fact]
    public void The_sweep_starts_at_the_held_side()
    {
        string[] bar = ["annotate", "count", "more", "collapse"];
        Assert.Equal(bar, ToolbarFold.NearestHeldFirst(bar, heldRight: false));
        Assert.Equal(["collapse", "more", "count", "annotate"], ToolbarFold.NearestHeldFirst(bar, heldRight: true));
        Assert.Equal([25.0, 43, 61, 79], Enumerable.Range(0, 4).Select(ToolbarFold.ItemInDelay));
        Assert.Equal([0.0, 16, 32, 48], Enumerable.Range(0, 4).Select(ToolbarFold.ItemOutDelay));
    }

    // ---- the held edge stays put --------------------------------------------------------------------------------

    [Theory]
    [InlineData(0.7, true)]
    [InlineData(0.5, true)]
    [InlineData(0.3, false)]
    [InlineData(0.0001, false)]
    public void Folding_and_opening_again_keeps_the_held_edge_and_gives_the_fraction_back(double fraction, bool heldRight)
    {
        // A 390-wide phone with 12 of margin: the bar moves between 12 and 378 - its width.
        const double minLeft = 12, maxRight = 378, open = 130, folded = 44;
        double left = ToolbarFold.PlaceAt(fraction, minLeft, maxRight - open);
        double edge = ToolbarFold.HeldEdge(left, open, heldRight);

        double foldedLeft = ToolbarFold.LeftFromEdge(edge, folded, heldRight);
        Assert.Equal(edge, ToolbarFold.HeldEdge(foldedLeft, folded, heldRight), 9);
        double foldedFraction = ToolbarFold.FractionAt(foldedLeft, minLeft, maxRight - folded)!.Value;
        // Still on the same side, so it opens the same way.
        Assert.Equal(heldRight, ToolbarFold.HeldRight(new Point(foldedFraction, 0.5), ToolbarCorner.BottomLeft));

        double reopenedLeft = ToolbarFold.LeftFromEdge(ToolbarFold.HeldEdge(ToolbarFold.PlaceAt(foldedFraction, minLeft, maxRight - folded), folded, heldRight), open, heldRight);
        Assert.Equal(fraction, ToolbarFold.FractionAt(reopenedLeft, minLeft, maxRight - open)!.Value, 9);
    }

    [Theory]
    [InlineData(1.0, true)]
    [InlineData(0.0, false)]
    public void A_bar_in_its_corner_stays_in_it(double fraction, bool heldRight)
    {
        const double minLeft = 12, maxRight = 378;
        double edge = ToolbarFold.HeldEdge(ToolbarFold.PlaceAt(fraction, minLeft, maxRight - 130), 130, heldRight);
        double? folded = ToolbarFold.FractionAt(ToolbarFold.LeftFromEdge(edge, 44, heldRight), minLeft, maxRight - 44);
        Assert.Equal(fraction, folded!.Value, 9);
    }

    [Fact]
    public void No_room_to_move_gives_no_fraction() => Assert.Null(ToolbarFold.FractionAt(12, 12, 12));

    // ---- the side, and the places, are kept until it is moved ------------------------------------------------------

    // A 390 wide phone with 12 of margin, a wide bar, and the round button.
    private static readonly ToolbarFold.Room Phone = new(12, 378);
    private const double Wide = 300, Round = 44;

    /// <summary>Folds or opens a settled toolbar as the overlay does, and returns the fraction it is left at.</summary>
    private static double Toggle(ToolbarFold fold, bool collapsing, double fraction, Point? dragged = null)
    {
        (double from, double to) = collapsing ? (Wide, Round) : (Round, Wide);
        ToolbarFold.Trip trip = fold.Start(collapsing, Phone, fraction, from, to, dragged ?? new Point(fraction, 0.8), ToolbarCorner.BottomRight);
        return trip.Arrival(Phone, to)!.Value;
    }

    [Fact]
    public void Fold_open_fold_from_just_right_of_the_middle_brings_the_circle_back_exactly()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        const double circle = 0.6;
        // Opened, the wide bar does not fit left of the circle's edge (249.2, and it needs 312): it is pushed right
        // until it fits, against the left margin, so its fraction is past the middle.
        double open = Toggle(fold, collapsing: false, circle);
        Assert.Equal(0, open);
        Assert.False(ToolbarFold.HeldRight(new Point(open, 0.8), ToolbarCorner.BottomRight));
        // But it is still held right, which is where the chevron points and where it folds back to.
        Assert.True(fold.HeldSide(new Point(open, 0.8), ToolbarCorner.BottomRight));
        Assert.Equal(circle, Toggle(fold, collapsing: true, open));
        Assert.Equal(open, Toggle(fold, collapsing: false, circle));
        Assert.Equal(circle, Toggle(fold, collapsing: true, open));
    }

    [Fact]
    public void Open_fold_open_brings_the_bar_back_exactly()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        const double bar = 0.45;
        // A bar held left (dragged left of the middle) folds to a circle further left, and opens back to where it was.
        double circle = Toggle(fold, collapsing: true, bar);
        Assert.True(circle < bar);
        Assert.Equal(bar, Toggle(fold, collapsing: false, circle));
        Assert.Equal(circle, Toggle(fold, collapsing: true, bar));
        Assert.Equal(bar, Toggle(fold, collapsing: false, circle));
    }

    [Fact]
    public void Where_the_bar_fits_its_held_edge_does_not_move()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        // A circle far enough right that the wide bar fits to its left (its right edge at 329.7, the bar from 29.7).
        ToolbarFold.Trip trip = fold.Start(collapsing: false, Phone, 0.85, Round, Wide, new Point(0.85, 0.8), ToolbarCorner.BottomRight);
        Assert.True(trip.HeldRight);
        Assert.Equal(trip.FromEdge, trip.ToEdge);
        Assert.Equal(trip.FromEdge, trip.EdgeAt(0.5));
        Assert.Null(trip.ToFraction);
        // A wide bar opened from a circle right of the middle: its fraction ends up left of the middle, held right.
        double open = trip.Arrival(Phone, Wide)!.Value;
        Assert.True(open < 0.5);
        ToolbarFold.Trip back = fold.Start(collapsing: true, Phone, open, Wide, Round, new Point(open, 0.8), ToolbarCorner.BottomRight);
        Assert.True(back.HeldRight);
        Assert.Equal(trip.FromEdge, back.ToEdge, 9);
        Assert.Equal(0.85, back.Arrival(Phone, Round)!.Value, 9);
    }

    [Fact]
    public void Moving_it_works_the_side_and_the_places_out_afresh()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        double open = Toggle(fold, collapsing: false, 0.6);
        Assert.True(fold.HeldSide(new Point(open, 0.8), ToolbarCorner.BottomRight));

        fold.Moved();
        Assert.False(fold.HeldSide(new Point(open, 0.8), ToolbarCorner.BottomRight));
        // Now held left: it folds to the left end of the bar, not back to the old circle.
        double circle = Toggle(fold, collapsing: true, open);
        Assert.Equal(Phone.MinLeft + (Phone.MaxLeft(Wide) - Phone.MinLeft) * open, Phone.LeftAt(circle, Round), 9);
        Assert.False(fold.HeldSide(new Point(circle, 0.8), ToolbarCorner.BottomRight));
    }

    [Fact]
    public void A_new_window_size_forgets_the_places_but_keeps_the_side()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        double open = Toggle(fold, collapsing: false, 0.6);
        fold.ForgetPlaces();
        Assert.True(fold.HeldSide(new Point(open, 0.8), ToolbarCorner.BottomRight));
        ToolbarFold.Trip trip = fold.Start(collapsing: true, Phone, open, Wide, Round, new Point(open, 0.8), ToolbarCorner.BottomRight);
        Assert.True(trip.HeldRight);
        Assert.Null(trip.ToFraction);
        Assert.Equal(trip.FromEdge, trip.ToEdge);
    }

    [Fact]
    public void Never_moved_the_side_comes_from_the_corner_and_a_corner_bar_stays_in_its_corner()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        Assert.True(fold.HeldSide(null, ToolbarCorner.BottomRight));
        ToolbarFold.Trip trip = fold.Start(collapsing: true, Phone, 1, Wide, Round, null, ToolbarCorner.BottomRight);
        Assert.Equal(1, trip.Arrival(Phone, Round)!.Value, 9);
        ToolbarFold left = new(new RuntimeState(remember: false), () => false);
        ToolbarFold.Trip leftTrip = left.Start(collapsing: true, Phone, 0, Wide, Round, null, ToolbarCorner.TopLeft);
        Assert.False(leftTrip.HeldRight);
        Assert.Equal(0, leftTrip.Arrival(Phone, Round)!.Value);
    }

    [Fact]
    public void Turning_around_mid_way_goes_back_to_where_it_left_from()
    {
        ToolbarFold fold = new(new RuntimeState(remember: false), () => false);
        // Folding from a bar at 0.3 (held left), then a change of mind half way.
        ToolbarFold.Trip folding = fold.Start(collapsing: true, Phone, 0.3, Wide, Round, new Point(0.3, 0.8), ToolbarCorner.BottomRight);
        ToolbarFold.Trip back = fold.TurnAround(collapsing: false, Phone, folding.HeldRight, folding.EdgeAt(0.5), Wide);
        Assert.Equal(0.3, back.Arrival(Phone, Wide)!.Value);
        Assert.Equal(folding.FromEdge, back.ToEdge, 9);
    }

    // ---- the round button's badge and dot ---------------------------------------------------------------------------

    [Theory]
    [InlineData(0, null)]
    [InlineData(-1, null)]
    [InlineData(1, "1")]
    [InlineData(99, "99")]
    [InlineData(100, "99+")]
    [InlineData(1234, "99+")]
    public void The_count_is_hidden_at_none_and_capped_at_99(int count, string? expected) =>
        Assert.Equal(expected, ToolbarFold.BadgeText(count));

    [Theory]
    [InlineData(NotatoConnection.Connecting, "#e9b44c")]
    [InlineData(NotatoConnection.Offline, "#ef6b5e")]
    [InlineData(NotatoConnection.Refused, "#ef6b5e")]
    [InlineData(NotatoConnection.Connected, null)]
    [InlineData(NotatoConnection.Local, null)]
    [InlineData(NotatoConnection.Disabled, null)]
    public void Folded_the_dot_only_shows_trouble(NotatoConnection connection, string? color) =>
        Assert.Equal(color, ToolbarFold.DotColor(connection));

    // ---- easings ----------------------------------------------------------------------------------------------

    [Fact]
    public void The_spring_starts_and_ends_exactly_overshoots_about_5_percent_once_and_settles()
    {
        Assert.Equal(0, ToolbarFold.Spring(0));
        Assert.Equal(1, ToolbarFold.Spring(1));
        List<(double T, double X)> samples = [.. Enumerable.Range(0, 1001).Select(i => (T: i / 1000.0, X: ToolbarFold.Spring(i / 1000.0)))];
        (double T, double X) = samples.MaxBy(s => s.X);
        Assert.InRange(X, 1.04, 1.07);
        // At about half way: 270ms of 560.
        Assert.InRange(T, 0.43, 0.55);
        // Rising all the way to the peak, then never far from the end.
        for (int i = 1; i < samples.Count && samples[i].T <= T; i++)
        {
            Assert.True(samples[i].X > samples[i - 1].X);
        }

        Assert.All(samples.Where(s => s.T >= 0.85), s => Assert.InRange(s.X, 0.99, 1.01));
        // Never back below where it settles by much: one overshoot, not a wobble.
        Assert.All(samples.Where(s => s.T > T), s => Assert.True(s.X > 0.995));
    }

    [Fact]
    public void Cubic_beziers_match_css()
    {
        foreach (Func<double, double>? ease in new[] { ToolbarFold.Settle, ToolbarFold.EaseIn })
        {
            Assert.Equal(0, ease(0));
            Assert.Equal(1, ease(1));
            double previous = 0.0;
            for (int i = 1; i <= 100; i++)
            {
                double y = ease(i / 100.0);
                Assert.True(y >= previous - 1e-9, "never goes back");
                previous = y;
            }
        }
        // Known points of CSS ease-in, and of the settle curve worked out from its control points.
        Assert.Equal(0.3153, ToolbarFold.EaseIn(0.5), 3);
        Assert.Equal(0.0, ToolbarFold.EaseIn(0.001), 3);
        Assert.Equal(Bezier(0.72, 1, 1, 0.5), ToolbarFold.Settle(Bezier(0.32, 0, 1, 0.5)), 6);
        Assert.Equal(Bezier(0.72, 1, 1, 0.2), ToolbarFold.Settle(Bezier(0.32, 0, 1, 0.2)), 6);
        // Fast off the mark: most of the way there by a third of the time.
        Assert.True(ToolbarFold.Settle(1 / 3.0) > 0.75);

        static double Bezier(double p1, double p2, double p3, double s) =>
            3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s * p3;
    }
}
