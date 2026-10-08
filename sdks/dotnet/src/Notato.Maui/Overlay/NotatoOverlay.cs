using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Layouts;
using Notato.Maui.Model;

namespace Notato.Maui.Overlay;

/// <summary>A pin as the overlay draws it: where, which number, what state.</summary>
internal sealed record PinPlacement(string Id, int Number, string Status, Rect Rect, bool Detached, bool Pending);

/// <summary>What the overlay needs to show a selection.</summary>
internal sealed record SelectionView(IReadOnlyList<Rect> Rects, string Title, string? Subtitle);

/// <summary>
/// Everything Notato draws over the app, built from MAUI controls: the toolbar, the annotate hint, the selection, the
/// note being written, the pins, and the sheets. Empty areas let touches through to the app (the layouts are input
/// transparent; only the controls themselves take touches).
/// </summary>
internal sealed partial class NotatoOverlay : Grid
{
    private readonly NotatoController _controller;
    private readonly OverlaySession _session;

    private readonly ContentView _pickSurface;
    private readonly AbsoluteLayout _marks;
    private readonly AbsoluteLayout _pins;
    private readonly Border _hint;
    private readonly AbsoluteLayout _toolbarLayer;
    private readonly Border _toolbar;
    private readonly Border _annotateButton;
    private readonly View _annotateGlyph;
    private readonly Label _annotateLabel;
    private readonly Border _annotateBadge;
    private readonly Label _annotateCount;
    private readonly Border _moreButton;
    private readonly Ellipse _connectionDot;
    private readonly ContentView _backdrop;
    private readonly ContentView _sheetHost;
    private readonly Border _toast;
    private readonly Label _toastText;

    private Thickness _safe;
    private double _keyboard;
    private Point? _dragStart;
    private bool _dragMoved;
    private long _dragEndedAt;
    /// <summary>
    /// Where the toolbar is while it is dragged, as a fraction; saved when the drag ends. Placement reads this, because
    /// the host lays the overlay out again during a drag (on iOS, every frame) and must not put it back mid-drag.
    /// </summary>
    private Point? _dragFraction;
    private CancellationTokenSource? _toastTimer;
    private readonly Dictionary<string, Border> _pinViews = [];
    /// <summary>What each pin was last drawn as, and where: a pin that has not changed or moved is left alone.</summary>
    private readonly Dictionary<string, (PinPlacement Placement, Point At)> _pinShown = [];
    /// <summary>The pins last asked for, and the room they were laid out in.</summary>
    private IReadOnlyList<PinPlacement> _pinsAsked = [];
    private (double Width, double Height, double Top) _pinRoom;

    public NotatoOverlay(NotatoController controller, OverlaySession session)
    {
        _controller = controller;
        _session = session;
        Ui.Plain(this);
        InputTransparent = true;
        CascadeInputTransparent = false;
        BackgroundColor = Colors.Transparent;
        Padding = 0;

        _pickSurface = Ui.Plain(new ContentView { BackgroundColor = Color.FromRgba(0, 0, 0, 0.01), IsVisible = false });
        TapGestureRecognizer pick = new();
        pick.Tapped += (_, e) =>
        {
            if (e.GetPosition(_pickSurface) is { } point)
            {
                controller.OnPick(session, point);
            }
        };
        _pickSurface.GestureRecognizers.Add(pick);

        _marks = Ui.Plain(new AbsoluteLayout { InputTransparent = true, CascadeInputTransparent = true });
        _pins = Ui.Plain(new AbsoluteLayout { InputTransparent = true, CascadeInputTransparent = false });

        Label hintText = Ui.Text("Tap what you want to comment on", 14, Ui.BarText, maxLines: 1);
        Border done = Ui.Box(Ui.Text("Done", 14, Ui.BarAccentText, bold: true), Ui.BarAccent, 12, new Thickness(12, 5));
        Ui.OnTap(done, controller.StopAnnotating);
        _hint = Ui.Box(new HorizontalStackLayout { Spacing = 12, Children = { hintText, done } }, Ui.Bar, 20, new Thickness(15, 6, 6, 6), Ui.BarLine, 1);
        _hint.HorizontalOptions = LayoutOptions.Center;
        _hint.VerticalOptions = LayoutOptions.Start;
        _hint.Shadow = Ui.CardShadow();
        _hint.IsVisible = false;
        ((HorizontalStackLayout)_hint.Content!).VerticalOptions = LayoutOptions.Center;
        hintText.VerticalOptions = LayoutOptions.Center;

        // ---- toolbar: [grip][Annotate 0][⋯][fold], which folds into one round button ------------------------------
        // The grip only shows that the bar can be moved: a drag from anywhere on it moves it.
        Grid grip = Ui.Plain(new Grid { WidthRequest = 20, HeightRequest = BarButton, InputTransparent = true, Children = { Ui.Icon(Ui.IconGrip, Ui.BarMuted, 14, filled: true) } });

        _annotateGlyph = Ui.Icon(Ui.IconCrosshair, Ui.BarText, 18, 2.2);
        _annotateLabel = Ui.Text("Annotate", 15, Ui.BarText, bold: true, maxLines: 1);
        _annotateLabel.VerticalOptions = LayoutOptions.Center;
        // The notes on this screen, always shown: 0 included.
        _annotateCount = Ui.Text("0", 12.5, Ui.BarText, bold: true, maxLines: 1);
        _annotateCount.HorizontalOptions = LayoutOptions.Center;
        _annotateCount.VerticalOptions = LayoutOptions.Center;
        _annotateCount.HorizontalTextAlignment = TextAlignment.Center;
        _annotateBadge = Ui.Box(_annotateCount, Ui.BarPressed, 9, new Thickness(7, 0));
        _annotateBadge.HeightRequest = 18;
        _annotateBadge.MinimumWidthRequest = 22;
        _annotateBadge.VerticalOptions = LayoutOptions.Center;
        _annotateBadge.InputTransparent = true;
        _annotateButton = Ui.Box(Ui.Plain(new HorizontalStackLayout { Spacing = 8, VerticalOptions = LayoutOptions.Center, Children = { _annotateGlyph, _annotateLabel, _annotateBadge } }),
            Colors.Transparent, 12, new Thickness(12, 0, 10, 0));
        _annotateButton.HeightRequest = BarButton;
        Ui.OnTap(_annotateButton, controller.ToggleAnnotating);
        SemanticProperties.SetDescription(_annotateButton, "Annotate");
        _annotateButton.AutomationId = "NotatoToolbarAnnotate";

        _moreButton = Ui.Box(Ui.Icon(Ui.IconMore, Ui.BarText, 18, filled: true), Colors.Transparent, 12, new Thickness(0));
        _moreButton.WidthRequest = BarButton;
        _moreButton.HeightRequest = BarButton;
        Ui.OnTap(_moreButton, () => OpenMenu());
        SemanticProperties.SetDescription(_moreButton, "Notato menu");
        _moreButton.AutomationId = "NotatoToolbarMenu";
        // Only when something is wrong: connecting, or the server cannot be reached.
        _connectionDot = new Ellipse { WidthRequest = 11, HeightRequest = 11, Fill = new SolidColorBrush(Ui.Offline), Stroke = new SolidColorBrush(Ui.Bar), StrokeThickness = 1.5, HorizontalOptions = LayoutOptions.End, VerticalOptions = LayoutOptions.Start, Margin = new Thickness(0, 8, 8, 0), InputTransparent = true, IsVisible = false };
        Grid moreWithDot = Ui.Plain(new Grid { Children = { _moreButton, _connectionDot }, WidthRequest = BarButton, HeightRequest = BarButton });
        _collapseButton = CreateCollapseButton();
        _row = Ui.Plain(new HorizontalStackLayout { Spacing = 2, Children = { grip, _annotateButton, moreWithDot, _collapseButton } });
        foreach (View part in _row.Children.OfType<View>())
        {
            part.VerticalOptions = LayoutOptions.Center;
        }
        // The buttons keep their full width inside the bar, held against one side; the bar's rounded shape clips them.
        AbsoluteLayout clip = Ui.Plain(new AbsoluteLayout { Children = { _row } });
        AbsoluteLayout.SetLayoutFlags(_row, AbsoluteLayoutFlags.XProportional);
        // A 1 ring inside it, then 4 of padding: the buttons sit 5 in from its edge.
        _toolbar = Ui.Box(clip, Ui.Bar, BarCorner, new Thickness(BarInset - 1), Ui.BarLine, 1);
#if !ANDROID
        _toolbar.Shadow = Ui.BarShadow();
#endif
        PanGestureRecognizer drag = new();
        drag.PanUpdated += OnDrag;
        _toolbar.GestureRecognizers.Add(drag);
#if ANDROID
        // Android gives a touch that starts on a button to that button alone, so the buttons carry the drag as well.
        foreach (View part in new View[] { _annotateButton, _moreButton, _collapseButton })
        {
            PanGestureRecognizer partDrag = new();
            partDrag.PanUpdated += OnDrag;
            part.GestureRecognizers.Add(partDrag);
        }
#endif
        _fabFace = CreateFab(out _fab, out _fabCount, out _fabCountText, out _fabDot);
#if ANDROID
        UseNativePill();
#endif
        _toolbarLayer = Ui.Plain(new AbsoluteLayout { InputTransparent = true, CascadeInputTransparent = false, Children = { _toolbar, _fabFace } });

        _backdrop = Ui.Plain(new ContentView { BackgroundColor = Color.FromRgba(0, 0, 0, 0.25), IsVisible = false });
        Ui.OnTap(_backdrop, CloseSheet);
        _sheetHost = Ui.Plain(new ContentView { VerticalOptions = LayoutOptions.End, HorizontalOptions = LayoutOptions.Fill, MaximumWidthRequest = 480, IsVisible = false });

        _toastText = Ui.Text("", 14, Ui.BarText);
        _toast = Ui.Box(_toastText, Ui.Bar, 18, new Thickness(15, 8), Ui.BarLine, 1);
        _toast.HorizontalOptions = LayoutOptions.Center;
        _toast.VerticalOptions = LayoutOptions.Start;
        _toast.Shadow = Ui.CardShadow();
        _toast.IsVisible = false;
        _toast.InputTransparent = true;
        _toast.MaximumWidthRequest = 460;

        Children.Add(_pickSurface);
        Children.Add(_marks);
        Children.Add(_pins);
        Children.Add(_hint);
        Children.Add(_toolbarLayer);
        Children.Add(_backdrop);
        Children.Add(_sheetHost);
        Children.Add(_toast);

        SizeChanged += (_, _) =>
        {
            SettleFold();
            controller.ToolbarRoomChanged();
            PlaceToolbar();
        };
        // The count comes and goes, and the bar is as wide as its buttons.
        _row.SizeChanged += (_, _) => PlaceToolbar();
        // A sheet's header or buttons can change size after it opens (a line of error, a wider window): fit it again.
        _sheetHost.SizeChanged += (_, _) => Dispatcher.Dispatch(FitSheet);

        // As it was left, without animating.
        _shownCollapsed = controller.ToolbarCollapsed;
        bool heldRight = HeldRight();
        AnchorRow(heldRight);
        SyncChevron(heldRight);
        ApplySettled();
    }

    // ---- metrics -------------------------------------------------------------------------------------------------

    public void SetMetrics(Thickness safeInsets, double keyboardHeight)
    {
        _safe = safeInsets;
        _keyboard = keyboardHeight;
        _hint.Margin = new Thickness(16, _safe.Top + 8, 16, 0);
        _toast.Margin = new Thickness(16, _safe.Top + 56, 16, 0);
        ApplySheetPosition();
        // The keyboard came or went: what scrolls in the sheet has more room, or less.
        FitSheet();
        PlaceToolbar();
    }

    // ---- state from the controller --------------------------------------------------------------------------------

    public void Render()
    {
        Composer?.SetMentions(_controller.AvailableMentions);
        _toolbar.IsVisible = _controller.IsToolbarVisible;
        _pins.IsVisible = _controller.PinsVisible;
        bool annotating = _controller.IsAnnotating;
        _pickSurface.IsVisible = annotating;
        _hint.IsVisible = annotating && _session.Selection is null && _sheetHost.Content is null;
        if (annotating != _shownAnnotating)
        {
            // On, Annotate turns teal with dark ink, and its count goes faint dark.
            _shownAnnotating = annotating;
            Color back = annotating ? Ui.BarAccent : Colors.Transparent;
            _annotateButton.BackgroundColor = back;
            _annotateButton.Background = new SolidColorBrush(back);
            Color ink = annotating ? Ui.BarAccentText : Ui.BarText;
            Ui.Recolor(_annotateGlyph, ink);
            _annotateLabel.TextColor = ink;
            _annotateCount.TextColor = ink;
            Color badge = annotating ? Color.FromRgba(11, 31, 27, 41) : Ui.BarPressed;
            _annotateBadge.BackgroundColor = badge;
            _annotateBadge.Background = new SolidColorBrush(badge);
        }
        int count = _controller.CountOnRoute(_session);
        _annotateCount.Text = MenuText.BarCount(count);
        SyncFold(count);
        // The ⋯ looks pressed while its sheet is open.
        bool menuOpen = _sheetHost.Content is MenuSheet;
        _moreButton.Background = new SolidColorBrush(menuOpen ? Ui.BarPressed : Colors.Transparent);
        string? dot = ToolbarFold.DotColor(_controller.ShownConnection);
        _connectionDot.IsVisible = dot is not null;
        if (dot is not null)
        {
            _connectionDot.Fill = new SolidColorBrush(Color.FromArgb(dot));
        }

        (_sheetHost.Content as MenuSheet)?.Refresh();
        if (!annotating && _session.Selection is null && _marks.Children.Count > 0)
        {
            _marks.Children.Clear();
        }
    }

    private bool? _shownAnnotating;

    // ---- the toolbar is dragged anywhere, and remembered as a fraction of the window --------------------------------

    private const double ToolbarMargin = 12;

    /// <summary>The toolbar's size: the round button's when folded, the animated one while folding or opening.</summary>
    private Size ToolbarSize() => new(BarWidth(), BarHeight);

    private (double MinX, double MinY, double MaxX, double MaxY) ToolbarArea(Size size) => (
        _safe.Left + ToolbarMargin,
        _safe.Top + ToolbarMargin,
        Math.Max(_safe.Left + ToolbarMargin, Width - _safe.Right - ToolbarMargin - size.Width),
        Math.Max(_safe.Top + ToolbarMargin, Height - Math.Max(_safe.Bottom, _keyboard) - ToolbarMargin - size.Height));

    private void PlaceToolbar()
    {
        if (Width <= 0 || Height <= 0)
        {
            return;
        }

        Size size = ToolbarSize();
        (double minX, double minY, double maxX, double maxY) = ToolbarArea(size);
        Point fraction = _dragFraction ?? _controller.ToolbarFraction;
        // Folding or opening, it is placed from its held edge, which stays put, and the width of this very step.
        double x = _morph is { } m
            ? ToolbarFold.LeftFromEdge(m.Edge, size.Width, m.HeldRight)
            : ToolbarFold.PlaceAt(fraction.X, minX, maxX);
        double y = ToolbarFold.PlaceAt(fraction.Y, minY, maxY);
#if ANDROID
        if (_morph is { } am)
        {
            // Laid out once, from where its held edge started; the width and the edge then move with no layout pass.
            double laidOut = Math.Max(am.LaidOut, am.Width);
            double left = ToolbarFold.LeftFromEdge(am.Trip.FromEdge, laidOut, am.HeldRight);
            SyncCorner(laidOut);
            AbsoluteLayout.SetLayoutBounds(_toolbar, new Rect(left, y, laidOut, size.Height));
            ShowPill(am.Width, am.HeldRight, am.Edge - am.Trip.FromEdge);
            PlaceFab(x, y, size.Width, am.HeldRight);
            return;
        }
        ShowPill(null, HeldRight(), 0);
#endif
        SyncCorner(size.Width);
        AbsoluteLayout.SetLayoutBounds(_toolbar, new Rect(x, y, size.Width, size.Height));
        bool heldRight = _morph?.HeldRight ?? HeldRight();
        PlaceFab(x, y, size.Width, heldRight);
        if (_morph is not null)
        {
            return;
        }
        // Dragged to the other half, it folds the other way.
        SyncChevron(heldRight);
        AnchorRow(heldRight);
    }

    private void OnDrag(object? sender, PanUpdatedEventArgs e)
    {
        switch (e.StatusType)
        {
            case GestureStatus.Started:
                // Folding or opening ends where it was going, so the drag moves the bar as it is about to be.
                SettleFold();
                _dragStart = AbsoluteLayout.GetLayoutBounds(_toolbar).Location;
                _dragMoved = false;
                break;
            case GestureStatus.Running when _dragStart is { } start:
            {
                if (e.TotalX != 0 || e.TotalY != 0)
                    {
                        _dragMoved = true;
                    }

                    (double minX, double minY, double maxX, double maxY) = ToolbarArea(ToolbarSize());
                    double x = Math.Clamp(start.X + e.TotalX, minX, maxX);
                    double y = Math.Clamp(start.Y + e.TotalY, minY, maxY);
                _dragFraction = new Point(maxX > minX ? (x - minX) / (maxX - minX) : 1, maxY > minY ? (y - minY) / (maxY - minY) : 1);
                PlaceToolbar();
                break;
            }
            case GestureStatus.Completed or GestureStatus.Canceled when _dragStart is not null:
                _dragStart = null;
                if (_dragFraction is { } fraction)
                {
                    _controller.ToolbarFraction = fraction;
                }

                if (_dragMoved)
                {
                    _dragEndedAt = Environment.TickCount64;
                    // Somewhere new: the side it folds to is worked out again from here.
                    _controller.ToolbarMoved();
                }
                _dragFraction = null;
                PlaceToolbar();
                break;
        }
    }

    // ---- selection ------------------------------------------------------------------------------------------------

    public void ShowSelection(SelectionView? view)
    {
        if (_marks.Children.Count > 0)
        {
            _marks.Children.Clear();
        }

        if (view is null)
        {
            return;
        }

        for (int i = 0; i < view.Rects.Count; i++)
        {
            Rect r = view.Rects[i];
            Border box = Ui.Box(null, Ui.Selection.WithAlpha(0.12f), 3, new Thickness(0), Ui.Selection, 2);
            box.InputTransparent = true;
            AbsoluteLayout.SetLayoutBounds(box, r);
            _marks.Children.Add(box);
        }
        if (view.Rects.Count == 0)
        {
            return;
        }

        Rect first = view.Rects[0];
        Border label = Ui.Box(Ui.Text(view.Title, 12, Colors.White, maxLines: 1), Ui.Selection, 5, new Thickness(7, 2));
        label.InputTransparent = true;
        label.MaximumWidthRequest = Math.Max(120, Width - 16);
        // Its size is known only once it is laid out: estimate to place it, and let it size itself.
        const double height = 20;
        double estimate = Math.Min(label.MaximumWidthRequest, 14 + view.Title.Length * 6.6);
        double x = Math.Clamp(first.X, 8, Math.Max(8, Width - estimate - 8));
        double y = first.Y - height - 4 < _safe.Top ? first.Bottom + 4 : first.Y - height - 4;
        AbsoluteLayout.SetLayoutBounds(label, new Rect(x, y, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
        _marks.Children.Add(label);
    }

    // ---- pins ------------------------------------------------------------------------------------------------------

    private const double PinSize = PinLayout.Diameter;

    /// <summary>
    /// Puts the pins where they go. Called often (the controller looks a few times a second, for scrolling): when no pin
    /// moved or changed and the overlay is the same size, nothing is touched; otherwise only the pins that moved or
    /// changed are.
    /// </summary>
    public void ShowPins(IReadOnlyList<PinPlacement> placements)
    {
        (double, double, double) room = (Width, Height, _safe.Top);
        if (room == _pinRoom && placements.SequenceEqual(_pinsAsked))
        {
            return;
        }

        _pinsAsked = placements;
        _pinRoom = room;
        HashSet<string> keep = [];
        List<Point> taken = [];
        foreach (PinPlacement p in placements)
        {
            keep.Add(p.Id);
            // Several notes on one element: side by side, not on top of each other.
            Point at = PinLayout.Place(p.Rect, taken, new Size(Width, Height), _safe.Top);
            taken.Add(at);
            bool known = _pinShown.TryGetValue(p.Id, out (PinPlacement Placement, Point At) shown);
            if (!_pinViews.TryGetValue(p.Id, out Border? view))
            {
                view = NewPin(p.Id);
                _pinViews[p.Id] = view;
                _pins.Children.Add(view);
            }

            if (!known || !SameLook(shown.Placement, p))
            {
                StylePin(view, p);
            }

            if (!known || shown.At != at)
            {
                AbsoluteLayout.SetLayoutBounds(view, new Rect(at.X, at.Y, PinSize, PinSize));
            }

            _pinShown[p.Id] = (p, at);
        }
        if (_pinViews.Count == keep.Count)
        {
            return;
        }

        foreach (string? gone in _pinViews.Keys.Where(k => !keep.Contains(k)).ToList())
        {
            _pins.Children.Remove(_pinViews[gone]);
            _pinViews.Remove(gone);
            _pinShown.Remove(gone);
        }
    }

    private static bool SameLook(PinPlacement a, PinPlacement b) =>
        a.Number == b.Number && a.Status == b.Status && a.Detached == b.Detached && a.Pending == b.Pending;

    private Border NewPin(string id)
    {
        // A 24 circle in its status colour, in a 2 white ring.
        Border view = Ui.Box(Ui.Text("", 12, Colors.White, bold: true, maxLines: 1), Ui.Accent, 12, new Thickness(0), Colors.White, 2);
        view.WidthRequest = PinSize;
        view.HeightRequest = PinSize;
        Label label = (Label)view.Content!;
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
        view.Shadow = new Shadow { Brush = new SolidColorBrush(Colors.Black), Opacity = 0.3f, Radius = 6, Offset = new Point(0, 2) };
        Ui.OnTap(view, () => _controller.OpenPin(_session, id));
        return view;
    }

    private static void StylePin(Border view, PinPlacement p)
    {
        ((Label)view.Content!).Text = p.Number.ToString(System.Globalization.CultureInfo.InvariantCulture);
        Color color = Ui.StatusColor(p.Status);
        view.BackgroundColor = color;
        view.Background = new SolidColorBrush(color);
        view.Opacity = p.Detached ? 0.55 : 1;
        view.Stroke = new SolidColorBrush(p.Pending ? Ui.Connecting : Colors.White);
        SemanticProperties.SetDescription(view, $"Note {p.Number}, {Ui.Humanize(p.Status)}");
    }

    // ---- sheets ---------------------------------------------------------------------------------------------------

    public bool SheetOpen => _sheetHost.Content is not null;

    private bool _sheetAtTop;

    /// <summary>The note goes in the half of the screen the selection is not in, so the outline stays in view.</summary>
    private void PlaceSheetAwayFrom(SelectionView selection)
    {
        if (selection.Rects.Count == 0 || Height <= 0)
        {
            return;
        }

        double middle = selection.Rects[0].Center.Y;
        _sheetAtTop = middle > Height / 2;
        ApplySheetPosition();
    }

    private void ApplySheetPosition()
    {
        // With the keyboard up, the bottom is taken: the sheet sits just above the keyboard instead.
        bool top = _sheetAtTop && _keyboard <= 0;
        _sheetHost.VerticalOptions = top ? LayoutOptions.Start : LayoutOptions.End;
#if IOS || MACCATALYST
        // A bottom sheet floats 8 off the screen's edge, over the home indicator's strip, as iOS's own sheets do; the
        // note being written stays clear of it.
        bool floating = _sheetHost.Content is not null and not ComposerCard;
        double bottom = _keyboard > 0 ? _keyboard + 10 : floating ? 8 : _safe.Bottom + 10;
#else
        double bottom = Math.Max(_safe.Bottom, _keyboard) + 10;
#endif
        _sheetHost.Margin = new Thickness(Math.Max(8, _safe.Left + 6), _safe.Top + 12, Math.Max(8, _safe.Right + 6), bottom);
    }

    /// <param name="card">What to show.</param>
    /// <param name="dim">Dim the app behind it, and close it on a tap there.</param>
    /// <param name="fromBar">Opened from the toolbar's menu: folding the toolbar closes it.</param>
    public void ShowSheet(View card, bool dim, bool fromBar = false)
    {
        if (card is not ComposerCard)
        {
            _sheetAtTop = false;
        }

        _sheetFromBar = fromBar;
        _sheetHost.Content = card;
        ApplySheetPosition();
        _sheetHost.IsVisible = true;
        _backdrop.IsVisible = dim;
        FitSheet();
        Render();
    }

    /// <summary>
    /// What scrolls in the sheet (its <see cref="SheetBody"/>) gets the room the rest of it leaves between the sheet's
    /// margins: the window less the status bar, and less the keyboard while it is up. The rest is measured, so stacked
    /// buttons, a long error or large text are allowed for.
    /// </summary>
    private void FitSheet()
    {
        if (_sheetHost.Content is not View sheet || Width <= 0 || Height <= 0
            || sheet.GetVisualTreeDescendants().OfType<SheetBody>().FirstOrDefault() is not { } body)
        {
            return;
        }

        Thickness margin = _sheetHost.Margin;
        double width = Math.Min(_sheetHost.MaximumWidthRequest, Width - margin.Left - margin.Right);
        double room = Height - margin.Top - margin.Bottom;
        // The whole sheet as tall as it wants to be, the body as it is now: the difference is everything else.
        double whole = ((IView)sheet).Measure(width, double.PositiveInfinity).Height;
        double rest = whole - body.DesiredSize.Height;
        double cap = Math.Max(SheetBody.Least, room - rest);
        // Only a real change: setting it lays the sheet out again, which fits it again.
        if (Math.Abs(cap - body.MaximumHeightRequest) > 0.5)
        {
            body.MaximumHeightRequest = cap;
        }
    }

    public void CloseSheet()
    {
        bool wasComposer = _sheetHost.Content is ComposerCard;
        _session.Host.ReturnFocus();
        _sheetHost.Content = null;
        _sheetFromBar = false;
        _sheetHost.IsVisible = false;
        _backdrop.IsVisible = false;
        _session.Host.ReturnFocus();
        if (wasComposer)
        {
            _controller.CancelSelection(_session);
        }

        Render();
    }

    public void Toast(string message)
    {
        _toastText.Text = message;
        _toast.IsVisible = true;
        _toastTimer?.Cancel();
        CancellationTokenSource cts = _toastTimer = new CancellationTokenSource();
        Dispatcher.DispatchDelayed(TimeSpan.FromSeconds(message.Length > 70 ? 5 : 2.8), () =>
        {
            if (!cts.IsCancellationRequested)
            {
                _toast.IsVisible = false;
            }
        });
    }

    public ComposerCard? Composer => _sheetHost.Content as ComposerCard;

    public void OpenComposer(SelectionView selection, bool screenshotsOff)
    {
        if (_sheetHost.Content is ComposerCard existing)
        {
            existing.SetTarget(selection.Title, selection.Subtitle);
            PlaceSheetAwayFrom(selection);
            return;
        }
        PlaceSheetAwayFrom(selection);
        ComposerCard card = new(selection.Title, selection.Subtitle, screenshotsOff,
            onParent: () => _controller.SelectParent(_session),
            onCancel: CloseSheet,
            onSend: (comment, intent, severity, peopleOnly) => _controller.SubmitAsync(_session, comment, intent, severity, peopleOnly));
        card.SetMentions(_controller.AvailableMentions);
        ShowSheet(card, dim: false);
    }

    private void OpenMenu()
    {
        MenuSheet menu = new(_controller, _session, action =>
        {
            CloseSheet();
            switch (action)
            {
                case MenuAction.Annotate: _controller.StartAnnotating(); break;
                case MenuAction.TogglePins: _controller.TogglePins(); break;
                case MenuAction.Notes: OpenList(); break;
                case MenuAction.Package: _ = _controller.PackageFromMenuAsync(_session); break;
                case MenuAction.Clear: ConfirmClear(); break;
                case MenuAction.Settings: OpenSettings(); break;
                case MenuAction.HideToolbar: _controller.HideToolbar(); break;
                case MenuAction.TurnOff: _controller.Disable(); break;
            }
        }, CloseSheet);
        ShowSheet(menu, dim: true, fromBar: true);
    }

    /// <summary>A sheet the menu opened: Back reopens the menu, Close closes it.</summary>
    private Grid SubHeader(string title, string? subtitle) =>
        Ui.SheetHeader(Ui.HeaderButton(back: true, OpenMenu), title, Ui.SheetSubtitle(subtitle), Ui.HeaderButton(back: false, CloseSheet));

    private void ConfirmClear()
    {
        Label note = Ui.Text("A package you already shared keeps them.", 13.5, Ui.CardMuted);
        note.Margin = new Thickness(4, 0);
        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                SubHeader("Clear notes?", MenuText.ClearLine(_controller.PendingCount)),
                note,
                Ui.ButtonRow(Ui.SheetButton("Keep them", CloseSheet), Ui.SheetButton("Clear", () => _ = ClearAsync(), Ui.SheetButtonKind.Destructive)),
            },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);

        async Task ClearAsync()
        {
            try
            {
                await _controller.ClearLocalAsync();
                CloseSheet();
                Toast("Notes cleared");
            }
            catch (Exception error)
            {
                // The notes are still on the device: say so, and leave the sheet open to try again.
                Toast($"Couldn't clear the notes: {error.Message}");
            }
        }
    }

    private void OpenList()
    {
        IReadOnlyList<(int Number, NotatoController.Record Record)> list = _controller.RecordsOnRoute(_session);
        VerticalStackLayout rows = Ui.Plain(new VerticalStackLayout { Spacing = 0 });
        if (list.Count == 0)
        {
            Border annotate = Ui.SheetRow(Ui.IconTile(Ui.IconCrosshair, MenuRowKind.Primary), "Annotate", "No notes on this screen yet", () =>
            {
                CloseSheet();
                _controller.StartAnnotating();
            });
            annotate.AutomationId = "NotatoNotesAnnotate";
            rows.Children.Add(annotate);
        }

        foreach ((int number, NotatoController.Record? record) in list.Take(10))
        {
            Annotation a = record.Annotation;
            string about = string.Join(" · ", new[] { Ui.Humanize(a.Status), PeopleOnlyToggle.IsOn(a) ? PeopleOnlyToggle.Label : null, Ui.Ago(a.CreatedAt) }
                .Where(s => !string.IsNullOrEmpty(s)));
            string id = a.Id;
            Border row = Ui.SheetRow(Ui.PinTile(number, a.Status, record.Pending), a.Comment, about, () => _controller.OpenPin(_session, id, back: OpenList),
                chevron: true, titleLines: 2);
            row.AutomationId = "NotatoNote-" + number.ToString(System.Globalization.CultureInfo.InvariantCulture);
            rows.Children.Add(row);
        }

        int others = _controller.Annotations.Count - list.Count;
        string more = string.Join(" ", new[]
        {
            list.Count > 10 ? $"{list.Count - 10} more here: tap their pins." : null,
            others > 0 ? $"{others} more on other screens." : null,
        }.Where(s => s is not null));
        if (more.Length > 0)
        {
            rows.Children.Add(Ui.Rule());
            Label footer = Ui.Text(more, 12.5, Ui.CardMuted);
            footer.Margin = new Thickness(4, 5, 4, 2);
            rows.Children.Add(footer);
        }

        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 10,
            Children = { SubHeader("Notes", MenuText.NotesLine(list.Count, _controller.Annotations.Count)), new SheetBody(rows) },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);
    }

    private void OpenSettings()
    {
        Entry name = Field(_controller.AuthorName, "Your name, on your notes");
        Entry server = Field(_controller.ServerOverride, _controller.ConfiguredServer ?? "No server: notes stay on this device");
        server.Keyboard = Keyboard.Url;
        (Grid shotsRow, Switch screenshots) = Ui.SwitchTileRow(Ui.IconTile(Ui.IconCamera), "Screenshots",
            _controller.ServerScreenshotsAllowed ? "Each note takes one of the screen" : "The server has them turned off",
            _controller.ScreenshotsWanted, "NotatoScreenshots");

        Label connection = Ui.Text(_controller.DescribeConnection(), 12, Ui.CardMuted);
        connection.Margin = new Thickness(4, 0);
        // The fields scroll when the keyboard leaves too little room for all of it; the header and buttons stay.
        VerticalStackLayout fields = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                Ui.Plain(new VerticalStackLayout { Spacing = 6, Children = { Ui.FieldLabel("Your name"), FieldBox(name) } }),
                Ui.Plain(new VerticalStackLayout { Spacing = 6, Children = { Ui.FieldLabel("Server"), FieldBox(server), connection } }),
                shotsRow,
            },
        });
        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                SubHeader("Settings", $"Project {_controller.Project} · {_controller.Mode} mode"),
                new SheetBody(fields),
                Ui.ButtonRow(
                    Ui.SheetButton("Reset", () =>
                    {
                        _controller.ResetRuntimeState();
                        CloseSheet();
                        Toast("Back to the app's configured settings");
                    }),
                    Ui.SheetButton("Save", () =>
                    {
                        _controller.SaveSettings(name.Text, screenshots.IsToggled, server.Text);
                        CloseSheet();
                    }, Ui.SheetButtonKind.Primary)),
            },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);
    }

    internal static Entry Field(string? text, string placeholder) => Ui.Plain<Entry>(new NotatoEntry
    {
        Text = text,
        Placeholder = placeholder,
        PlaceholderColor = Ui.CardMuted,
        TextColor = Ui.CardText,
        BackgroundColor = Colors.Transparent,
        FontSize = 15,
        FontFamily = null,
        ClearButtonVisibility = ClearButtonVisibility.WhileEditing,
        IsSpellCheckEnabled = false,
        IsTextPredictionEnabled = false,
    });

    internal static Border FieldBox(View field)
    {
        field.VerticalOptions = LayoutOptions.Center;
        Border box = Ui.Box(field, Ui.Soft, 12, new Thickness(12, 2));
        box.MinimumHeightRequest = 46;
        return box;
    }
}
