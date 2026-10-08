using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Layouts;

namespace Notato.Maui.Overlay;

// ---- the toolbar folds into one round button and opens out of it again ------------------------------------------
// As the web toolbar does. It grows away from the side it is held to (the nearer side once dragged, else its corner,
// kept until it is moved: see ToolbarFold), so its buttons, held against that side, stay where they will be while the
// far edge sweeps over them. The held edge does not move: mid-way its place is worked out from that edge and the
// animated width together, and afterwards the stored fraction is the one that leaves it there. It moves only to go
// back to where the bar was last folded (or open), when the bar had to move over to fit, on the same curve.
internal sealed partial class NotatoOverlay
{
    /// <summary>The bar's height, which is the folded circle's diameter: 44 buttons, 5 in from its edge.</summary>
    private const double BarHeight = 54;
    /// <summary>From the bar's edge to its buttons: a 1 ring and 4 of padding.</summary>
    private const double BarInset = 5;
    /// <summary>The bar's buttons' height.</summary>
    private const double BarButton = BarHeight - 2 * BarInset;
    /// <summary>The open bar's corner; folded, it rounds into the circle.</summary>
    private const double BarCorner = 16;
    /// <summary>The round button inside the folded circle, holding the potato.</summary>
    private const double FabSize = BarButton;
    /// <summary>Room around the round button for its count and dot, which stand out past the circle's edge.</summary>
    private const double FacePad = 14;
    private const string FoldAnimation = "NotatoToolbarFold";

    private static readonly Easing Spring = new(ToolbarFold.Spring);
    private static readonly Easing Settle = new(ToolbarFold.Settle);
    private static readonly Easing EaseIn = new(ToolbarFold.EaseIn);

    private readonly HorizontalStackLayout _row;
    private readonly Border _collapseButton;
    /// <summary>The round button with its count and dot, over the bar's held end.</summary>
    private readonly Grid _fabFace;
    private readonly Border _fab;
    private readonly Border _fabCount;
    private readonly Label _fabCountText;
    private readonly Border _fabDot;

    /// <summary>Folded, or folding: what the toolbar shows, or is on its way to.</summary>
    private bool _shownCollapsed;
    private bool? _chevronRight;
    /// <summary>The sheet showing was opened from the toolbar's menu: folding closes it.</summary>
    private bool _sheetFromBar;
    private Morph? _morph;
    private int _morphRun;

    /// <summary>A fold or an opening under way: where it goes, and its held edge and width as they are on screen.</summary>
    private sealed class Morph(ToolbarFold.Trip trip, double width)
    {
        public ToolbarFold.Trip Trip { get; } = trip;
        public bool HeldRight => Trip.HeldRight;
        public double Edge { get; set; } = trip.FromEdge;
        public double Width { get; set; } = width;
        /// <summary>Android lays the bar out once at this width for the whole trip, room for the spring's overshoot included.</summary>
        public double LaidOut { get; init; }
    }

    /// <summary>Opacity, slide toward the held side, scale and turn: what is animated on each part.</summary>
    private readonly record struct Pose(double Opacity, double TranslationX = 0, double Scale = 1, double Rotation = 0);

    private Border CreateCollapseButton()
    {
        Border button = Ui.Box(null, Colors.Transparent, 12, new Thickness(0));
        button.WidthRequest = 28;
        button.HeightRequest = BarButton;
        Ui.OnTap(button, () =>
        {
            if (!JustDragged)
            {
                _controller.SetToolbarCollapsed(true);
            }
        });
        SemanticProperties.SetDescription(button, "Collapse the toolbar");
        button.AutomationId = "NotatoToolbarCollapse";
        return button;
    }

    private Grid CreateFab(out Border button, out Border count, out Label countText, out Border dot)
    {
        // The potato, at about 40 in the 54 circle, tilted.
        button = Ui.Box(Ui.Potato(40), Colors.Transparent, FabSize / 2, new Thickness(0));
        button.WidthRequest = FabSize;
        button.HeightRequest = FabSize;
        button.HorizontalOptions = LayoutOptions.Center;
        button.VerticalOptions = LayoutOptions.Center;
        Ui.OnTap(button, () =>
        {
            if (!JustDragged)
            {
                _controller.SetToolbarCollapsed(false);
            }
        });
        // A drag moves it and leaves it folded; a tap opens it.
        PanGestureRecognizer drag = new();
        drag.PanUpdated += OnDrag;
        button.GestureRecognizers.Add(drag);
        SemanticProperties.SetDescription(button, "Show the Notato toolbar");
        button.AutomationId = "NotatoToolbarExpand";

        // An 18 teal pill (at least) in a 2 ring of the bar's colour, 5 above the circle and 6 out past its right, as
        // the web's folded button has it.
        countText = Ui.Text("", 11, Ui.BarAccentText, bold: true, maxLines: 1);
        countText.HorizontalOptions = LayoutOptions.Center;
        countText.VerticalOptions = LayoutOptions.Center;
        countText.HorizontalTextAlignment = TextAlignment.Center;
        count = Ui.Box(countText, Ui.BarAccent, 11, new Thickness(5, 0), Ui.Bar, 2);
        count.HeightRequest = 22;
        count.MinimumWidthRequest = 22;
        count.HorizontalOptions = LayoutOptions.End;
        count.VerticalOptions = LayoutOptions.Start;
        count.Margin = new Thickness(0, FacePad - BarInset - 5 - 2, FacePad - BarInset - 6 - 2, 0);
        count.InputTransparent = true;
        count.IsVisible = false;
        count.AutomationId = "NotatoToolbarBadge";

        // A 10 dot in the same ring, at the circle's bottom left: only while something is wrong.
        dot = Ui.Box(null, Ui.Offline, 7, new Thickness(0), Ui.Bar, 2);
        dot.WidthRequest = 14;
        dot.HeightRequest = 14;
        dot.HorizontalOptions = LayoutOptions.Start;
        dot.VerticalOptions = LayoutOptions.End;
        dot.Margin = new Thickness(FacePad - BarInset - 2, 0, 0, FacePad - BarInset - 2);
        dot.InputTransparent = true;
        dot.IsVisible = false;

        return Ui.Plain(new Grid
        {
            WidthRequest = FabSize + 2 * FacePad,
            HeightRequest = FabSize + 2 * FacePad,
            InputTransparent = true,
            CascadeInputTransparent = false,
            Children = { button, count, dot },
        });
    }

    /// <summary>A drag of the round button (or the bar) just ended or is under way: its touch is not also a tap.</summary>
    private bool JustDragged => (_dragStart is not null && _dragMoved) || Environment.TickCount64 - _dragEndedAt < 300;

    /// <summary>The side it is held to: where it is being dragged, else where it was left.</summary>
    private bool HeldRight() => _dragFraction is { } dragging ? dragging.X >= 0.5 : _controller.ToolbarHeldRight;

    /// <summary>The full bar's width, from its buttons as they are laid out (they stay laid out while folded).</summary>
    private double NaturalWidth()
    {
        if (_row.Width > 0)
        {
            return _row.Width + 2 * BarInset;
        }

        Size measured = _row.Measure(double.PositiveInfinity, double.PositiveInfinity);
        return Math.Max(2 * BarHeight, measured.Width + 2 * BarInset);
    }

    /// <summary>Where the bar can go across the window, inside the safe area and the margin.</summary>
    private ToolbarFold.Room Room()
    {
        double minLeft = _safe.Left + ToolbarMargin;
        return new ToolbarFold.Room(minLeft, Math.Max(minLeft, Width - _safe.Right - ToolbarMargin));
    }

    /// <summary>The bar's width on screen: mid-way, the animated one.</summary>
    private double BarWidth() => _morph?.Width ?? (_shownCollapsed ? BarHeight : NaturalWidth());

    private void SyncChevron(bool heldRight)
    {
        if (_chevronRight == heldRight)
        {
            return;
        }

        _chevronRight = heldRight;
        // It points the way the bar folds.
        _collapseButton.Content = Ui.Icon(heldRight ? Ui.IconChevronRight : Ui.IconChevronLeft, Ui.BarMuted, 16, 2.2);
    }

    /// <summary>The buttons are held against the side the bar folds to, so the far side is what the edge cuts off.</summary>
    private void AnchorRow(bool heldRight) =>
        AbsoluteLayout.SetLayoutBounds(_row, new Rect(heldRight ? 1 : 0, 0, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));

    /// <summary>Puts the round button over the bar's held end.</summary>
    private void PlaceFab(double left, double top, double width, bool heldRight)
    {
        double x = heldRight ? left + width - BarInset - FabSize : left + BarInset;
        AbsoluteLayout.SetLayoutBounds(_fabFace, new Rect(x - FacePad, top + BarInset - FacePad, FabSize + 2 * FacePad, FabSize + 2 * FacePad));
    }

    private double _shownCorner = BarCorner;

    /// <summary>The bar's corner for its width now: 16 open, rounding into the circle as it folds.</summary>
    private void SyncCorner(double width)
    {
        double corner = ToolbarFold.Corner(width, BarHeight, BarCorner);
        if (Math.Abs(corner - _shownCorner) < 0.05)
        {
            return;
        }

        _shownCorner = corner;
        _toolbar.StrokeShape = new RoundRectangle { CornerRadius = corner };
    }

    /// <summary>Called from <see cref="Render"/>: folds or opens when the controller says so, whatever asked.</summary>
    private void SyncFold(int count)
    {
        bool collapsed = _controller.ToolbarCollapsed;
        if (collapsed != _shownCollapsed)
        {
            FoldTo(collapsed);
        }
        else
        {
            _fabFace.IsVisible = _controller.IsToolbarVisible;
        }

        string? badge = ToolbarFold.BadgeText(count);
        _fabCountText.Text = badge ?? "";
        _fabCount.IsVisible = badge is not null;
        string? dot = ToolbarFold.DotColor(_controller.ShownConnection);
        _fabDot.IsVisible = dot is not null;
        if (dot is not null)
        {
            Color color = Color.FromArgb(dot);
            _fabDot.BackgroundColor = color;
            _fabDot.Background = new SolidColorBrush(color);
        }
    }

    private void FoldTo(bool collapsed)
    {
        _shownCollapsed = collapsed;
        // A change of mind turns around from where everything is on screen now: each part starts from its current
        // pose, and the width from the one the stopped animation left.
        int run = ++_morphRun;
        this.AbortAnimation(FoldAnimation);
        if (collapsed && _sheetFromBar && SheetOpen)
        {
            CloseSheet();
        }

        SetReachable(collapsed);

        Rect bounds = AbsoluteLayout.GetLayoutBounds(_toolbar);
        if (Width <= 0 || Height <= 0 || bounds.Width <= 0)
        {
            // Not placed yet: nothing to animate from.
            _morph = null;
            ApplySettled();
            PlaceToolbar();
            return;
        }
        double toWidth = collapsed ? BarHeight : NaturalWidth();
        ToolbarFold.Room room = Room();
        double fromWidth = _morph?.Width ?? bounds.Width;
        ToolbarFold.Trip trip = _morph is { } turning
            ? _controller.TurnToolbarAround(collapsed, room, turning.HeldRight, turning.Edge, toWidth)
            : _controller.StartToolbarTrip(collapsed, room, fromWidth, toWidth, _dragFraction);
        bool heldRight = trip.HeldRight;

        bool faceWasShowing = _fabFace.IsVisible && _fabFace.Opacity > 0.01;
        double natural = NaturalWidth();
        Morph m = _morph = new Morph(trip, fromWidth) { LaidOut = natural + (natural - BarHeight) * 0.1 };
        AnchorRow(heldRight);
        SyncChevron(heldRight);
        _fabFace.IsVisible = _controller.IsToolbarVisible;
        if (!CanAnimate())
        {
            FinishMorph();
            return;
        }

        int toward = heldRight ? 1 : -1;
        List<View> items = ToolbarFold.NearestHeldFirst(_row.Children.OfType<View>().Where(v => v.IsVisible), heldRight);
        Timeline timeline = new();
        // The width and the place come from the same value in the same step, so the held edge never wobbles.
        timeline.Add(0, collapsed ? ToolbarFold.FoldMs : ToolbarFold.OpenMs, collapsed ? Settle : Spring, t =>
        {
            m.Width = fromWidth + (toWidth - fromWidth) * t;
            m.Edge = trip.EdgeAt(t);
            PlaceToolbar();
        });
        if (collapsed)
        {
            // The far buttons go first, as the edge comes in over them, then the button they fold into turns in.
            items.Reverse();
            for (int i = 0; i < items.Count; i++)
            {
                Tween(timeline, items[i], ToolbarFold.ItemOutDelay(i), ToolbarFold.ItemOutMs, EaseIn, new Pose(0, 8 * toward, 0.92));
            }

            if (!faceWasShowing)
            {
                SetPose(_fabFace, new Pose(0, 0, 0.5, -90 * toward));
                SetPose(_fabCount, new Pose(0, 0, 0.4));
            }
            Tween(timeline, _fabFace, ToolbarFold.FabInDelayMs, ToolbarFold.FabInMs, Spring, new Pose(1));
            if (_fabCount.Opacity < 1)
            {
                Tween(timeline, _fabCount, ToolbarFold.BadgeInDelayMs, ToolbarFold.BadgeInMs, Spring, new Pose(1));
            }
        }
        else
        {
            Tween(timeline, _fabFace, 0, ToolbarFold.FabOutMs, EaseIn, new Pose(0, 0, 0.5, -90 * toward));
            for (int i = 0; i < items.Count; i++)
            {
                // From hidden, each comes in from a little toward the held side, a little small.
                if (items[i].Opacity < 0.01)
                {
                    SetPose(items[i], new Pose(0, 10 * toward, 0.94));
                }

                Tween(timeline, items[i], ToolbarFold.ItemInDelay(i), ToolbarFold.ItemInMs, Settle, new Pose(1));
            }
        }
        timeline.Commit(this, FoldAnimation, () =>
        {
            // Superseded by a newer change, which has taken over.
            if (run == _morphRun)
            {
                FinishMorph();
            }
        });
    }

    /// <summary>Ends a fold or an opening at once, as it would have ended: before a drag, or when the window changes size.</summary>
    private void SettleFold()
    {
        if (_morph is null)
        {
            return;
        }

        _morphRun++;
        this.AbortAnimation(FoldAnimation);
        FinishMorph();
    }

    private void FinishMorph()
    {
        // Gone first, so the width below is the settled bar's.
        Morph? morph = _morph;
        _morph = null;
        if (morph is not null && Width > 0)
        {
            // Store the fraction that leaves the bar where it arrived at its new width: its held edge where it was,
            // or the place it went back to. A bar in its corner (0 or 1) gets the same fraction, so stays undragged.
            Point current = _controller.ToolbarFraction;
            if (morph.Trip.Arrival(Room(), BarWidth()) is { } x && Math.Abs(x - current.X) > 1e-6)
            {
                _controller.ToolbarArrived(new Point(x, current.Y));
            }
        }

        ApplySettled();
        PlaceToolbar();
    }

    /// <summary>Every part as it is when folded, or when open, with nothing under way.</summary>
    private void ApplySettled()
    {
        foreach (View item in _row.Children.OfType<View>())
        {
            SetPose(item, new Pose(_shownCollapsed ? 0 : 1));
        }

        SetReachable(_shownCollapsed);
        // Open, the round button stays laid out and drawn, only see-through: shown for the first time at the start of a
        // fold, it cost Android a layout and a first draw there, and the fold's first frames were dropped.
        SetPose(_fabFace, new Pose(_shownCollapsed ? 1 : 0));
        SetPose(_fabCount, new Pose(1));
        _fabFace.IsVisible = _controller.IsToolbarVisible;
    }

    /// <summary>
    /// Which of the two takes touches and is read out: the round button (folded, or folding) or the bar's buttons. The
    /// folded bar's buttons are only see-through, so they are taken out of the accessibility tree as well.
    /// </summary>
    private void SetReachable(bool collapsed)
    {
        _row.InputTransparent = collapsed;
        AutomationProperties.SetExcludedWithChildren(_row, collapsed);
        _fab.InputTransparent = !collapsed;
        AutomationProperties.SetExcludedWithChildren(_fabFace, !collapsed);
    }

    private bool CanAnimate() =>
        Handler?.MauiContext is not null && _controller.IsToolbarVisible && _dragStart is null && !ReduceMotion();

    private static bool ReduceMotion()
    {
#if IOS || MACCATALYST
        return global::UIKit.UIAccessibility.IsReduceMotionEnabled;
#elif ANDROID
        // Animations turned off (or "Remove animations") sets the animator scale to 0.
        return OperatingSystem.IsAndroidVersionAtLeast(26) && !global::Android.Animation.ValueAnimator.AreAnimatorsEnabled();
#else
        return false;
#endif
    }

    private static void SetPose(VisualElement view, Pose pose)
    {
        view.Opacity = pose.Opacity;
        view.TranslationX = pose.TranslationX;
        view.Scale = pose.Scale;
        view.Rotation = pose.Rotation;
    }

    /// <summary>Moves <paramref name="view"/> from its pose now to <paramref name="to"/>.</summary>
    private static void Tween(Timeline timeline, VisualElement view, double delay, double duration, Easing easing, Pose to)
    {
        Pose from = new(view.Opacity, view.TranslationX, view.Scale, view.Rotation);
        timeline.Add(delay, duration, easing, t => SetPose(view, new Pose(
            Math.Clamp(from.Opacity + (to.Opacity - from.Opacity) * t, 0, 1),
            from.TranslationX + (to.TranslationX - from.TranslationX) * t,
            from.Scale + (to.Scale - from.Scale) * t,
            from.Rotation + (to.Rotation - from.Rotation) * t)));
    }

    /// <summary>Steps with their own delays, durations and easings, run as one named MAUI animation.</summary>
    private sealed class Timeline
    {
        private readonly List<(double Delay, double Duration, Easing Easing, Action<double> Step)> _steps = [];

        public void Add(double delay, double duration, Easing easing, Action<double> step) => _steps.Add((delay, duration, easing, step));

        public void Commit(IAnimatable owner, string name, Action finished)
        {
            double total = _steps.Max(s => s.Delay + s.Duration);
            Animation animation = [];
            foreach ((double delay, double duration, Easing easing, Action<double> step) in _steps)
            {
                animation.Add(delay / total, Math.Min(1, (delay + duration) / total), new Animation(step, 0, 1, easing));
            }

            animation.Commit(owner, name, 16, (uint)Math.Ceiling(total), Easing.Linear, (_, _) => finished());
        }
    }
}
