using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Layouts;

namespace Notato.Maui.Overlay;

/// <summary>A pin as the overlay draws it: where, which number, what state.</summary>
internal sealed record PinPlacement(string Id, int Number, string Status, Rect Rect, bool Detached, bool Pending);

/// <summary>What the overlay needs to show a selection.</summary>
internal sealed record SelectionView(IReadOnlyList<Rect> Rects, string Title, string? Subtitle);

/// <summary>
/// Everything Notato draws over the app, built from MAUI controls: the toolbar, the annotate hint, the selection, the
/// note being written, the pins, and the sheets. Empty areas let touches through to the app (the layouts are input
/// transparent; only the controls themselves take touches). The toolbar, its folding, the pins and the sheets are in
/// the <c>NotatoOverlay.*.cs</c> files.
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
    private int _toastsShown;
    /// <summary>Whether Annotate was last drawn on; null before it was drawn at all.</summary>
    private bool? _shownAnnotating;

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

        _marks = Ui.Plain(new AbsoluteLayout { InputTransparent = true, CascadeInputTransparent = true, IsVisible = false });
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
        // Hidden as built: the first time each is asked for, it comes in.
        _reveals[_hint] = (false, 0);
        _reveals[_toast] = (false, 0);
        _reveals[_marks] = (false, 0);

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
        // Out of the way while a note is written: it shrinks into its own middle, and grows back once the note is sent
        // or cancelled.
        Reveal(_toolbarLayer, _controller.IsToolbarVisible && _sheet is not ComposerCard, scale: 0.9, anchor: ToolbarMiddle());
        Reveal(_pins, _controller.PinsVisible);
        bool annotating = _controller.IsAnnotating;
        _pickSurface.IsVisible = annotating;
        Reveal(_hint, annotating && _session.Selection is null && _sheet is null, dy: -16);
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
        bool menuOpen = _sheet is MenuSheet;
        _moreButton.Background = new SolidColorBrush(menuOpen ? Ui.BarPressed : Colors.Transparent);
        string? dot = ToolbarFold.DotColor(_controller.ShownConnection);
        _connectionDot.IsVisible = dot is not null;
        if (dot is not null)
        {
            _connectionDot.Fill = new SolidColorBrush(Color.FromArgb(dot));
        }

        (_sheet as MenuSheet)?.Refresh();
        if (!annotating && _session.Selection is null)
        {
            Reveal(_marks, false);
        }
    }

    /// <summary>The toolbar's middle, as a fraction of the overlay: what it shrinks into.</summary>
    private Point ToolbarMiddle()
    {
        Rect bar = AbsoluteLayout.GetLayoutBounds(_toolbar);
        return Width > 0 && Height > 0 && bar.Width > 0
            ? new Point((bar.X + (bar.Width / 2)) / Width, (bar.Y + (bar.Height / 2)) / Height)
            : new Point(0.5, 0.5);
    }

    // ---- selection ------------------------------------------------------------------------------------------------

    /// <summary>The outlines, one per selected element, kept and moved rather than built again; spares are hidden.</summary>
    private readonly List<Border> _outlines = [];
    private Border? _markLabel;
    private Label? _markText;
    /// <summary>Where the outlines were last put: a look that finds them there touches nothing.</summary>
    private IReadOnlyList<Rect> _marksAt = [];

    /// <summary>Shows a new selection (its title once, its outlines where they are now), or hides it when null.</summary>
    public void ShowSelection(SelectionView? view)
    {
        if (view is null)
        {
            Reveal(_marks, false);
            return;
        }

        if (_markLabel is null)
        {
            _markText = Ui.Text("", 12, Colors.White, maxLines: 1);
            _markLabel = Ui.Box(_markText, Ui.Selection, 5, new Thickness(7, 2));
            _markLabel.InputTransparent = true;
            AbsoluteLayout.SetLayoutBounds(_markLabel, new Rect(0, 0, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
            _marks.Children.Add(_markLabel);
        }

        _markText!.Text = view.Title;
        _markLabel.MaximumWidthRequest = Math.Max(120, Width - 16);
        _marksAt = [];
        MoveSelection(view.Rects);
        Reveal(_marks, true);
    }

    /// <summary>
    /// Puts the selection's outlines (and its title) where its elements are now. Called on every look while something
    /// is selected: when nothing moved, nothing is touched; what moved is moved, not laid out again. Returns whether
    /// anything moved.
    /// </summary>
    public bool MoveSelection(IReadOnlyList<Rect> rects)
    {
        if (rects.SequenceEqual(_marksAt))
        {
            return false;
        }

        _marksAt = [.. rects];
        for (int i = 0; i < rects.Count; i++)
        {
            if (i == _outlines.Count)
            {
                Border box = Ui.Box(null, Ui.Selection.WithAlpha(0.12f), 3, new Thickness(0), Ui.Selection, 2);
                box.InputTransparent = true;
                _outlines.Add(box);
                // Under the title.
                _marks.Children.Insert(i, box);
            }

            _outlines[i].IsVisible = true;
            Place(_outlines[i], rects[i]);
        }

        for (int i = rects.Count; i < _outlines.Count; i++)
        {
            _outlines[i].IsVisible = false;
        }

        if (_markLabel is not null)
        {
            _markLabel.IsVisible = rects.Count > 0;
            if (rects.Count > 0)
            {
                Rect first = rects[0];
                // Its size is known only once it is laid out: estimate to place it, and let it size itself.
                const double height = 20;
                double estimate = Math.Min(_markLabel.MaximumWidthRequest, 14 + (_markText!.Text.Length * 6.6));
                double x = Math.Clamp(first.X, 8, Math.Max(8, Width - estimate - 8));
                double y = first.Y - height - 4 < _safe.Top ? first.Bottom + 4 : first.Y - height - 4;
                _markLabel.TranslationX = x;
                _markLabel.TranslationY = y;
            }
        }

        return true;
    }

    /// <summary>
    /// Puts <paramref name="view"/> over <paramref name="rect"/>: laid out at its size from the corner, and moved there
    /// by translation, so following a scroll needs no layout pass.
    /// </summary>
    private static void Place(VisualElement view, Rect rect)
    {
        Rect laid = AbsoluteLayout.GetLayoutBounds(view);
        if (laid.X != 0 || laid.Y != 0 || laid.Width != rect.Width || laid.Height != rect.Height)
        {
            AbsoluteLayout.SetLayoutBounds(view, new Rect(0, 0, rect.Width, rect.Height));
        }

        view.TranslationX = rect.X;
        view.TranslationY = rect.Y;
    }

    public void Toast(string message)
    {
        _toastText.Text = message;
        // Drops in from the top, and goes back up; a newer toast takes the place of one already showing.
        Reveal(_toast, true, dy: -16);
        // A newer toast keeps its own time on screen: this one's timer then does nothing.
        int shown = ++_toastsShown;
        Dispatcher.DispatchDelayed(TimeSpan.FromSeconds(message.Length > 70 ? 5 : 2.8), () =>
        {
            if (shown == _toastsShown)
            {
                Reveal(_toast, false, dy: -16);
            }
        });
    }
}
