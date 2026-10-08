using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using MauiPath = Microsoft.Maui.Controls.Shapes.Path;

namespace Notato.Maui.Overlay;

/// <summary>
/// The overlay's look, and small builders for its controls. Every value is set on the control itself so the app's own
/// implicit styles (its Label, Border and Editor styles) cannot reach Notato's UI.
/// </summary>
internal static class Ui
{
    // ---- the toolbar: always dark --------------------------------------------------------------------------------
    public static readonly Color Bar = Color.FromArgb("#17181b");
    public static readonly Color BarText = Color.FromArgb("#eceded");
    public static readonly Color BarMuted = Color.FromArgb("#8b8f97");
    /// <summary>A pressed button, and the count's pill, on the bar.</summary>
    public static readonly Color BarPressed = Color.FromArgb("#2a2c31");
    public static readonly Color BarLine = Color.FromArgb("#33353a");
    /// <summary>Annotate while it is on, and the folded button's count.</summary>
    public static readonly Color BarAccent = Color.FromArgb("#45bfa8");
    public static readonly Color BarAccentText = Color.FromArgb("#0b1f1b");

    // ---- the app's accent and the other fixed colours ---------------------------------------------------------------
    /// <summary>Teal: buttons, the primary tile, selected chips, open pins. The board's brand colour.</summary>
    public static readonly Color Accent = Color.FromArgb("#1f8a78");
    public static readonly Color AccentPressed = Color.FromArgb("#187465");
    public static readonly Color Danger = Color.FromArgb("#d6453d");
    public static readonly Color Selection = Color.FromArgb("#e5484d");
    public static readonly Color Paper = Colors.White;
    /// <summary>The badge kind (for <see cref="Badge"/>) of a People only note.</summary>
    public const string PeopleOnlyBadge = "people_only";

    // ---- connection ---------------------------------------------------------------------------------------------------
    public static readonly Color ConnectedOnBar = Color.FromArgb("#55c487");
    public static readonly Color Connected = Color.FromArgb("#2e9a5b");
    public static readonly Color Connecting = Color.FromArgb("#e9b44c");
    public static readonly Color ConnectingText = Color.FromArgb("#d99a1e");
    public static readonly Color Offline = Color.FromArgb("#ef6b5e");

    // ---- sheets and cards: follow the system's light or dark setting --------------------------------------------------
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
        float Mix(float top, float bottom) => (float)(top * amount + bottom * (1 - amount));
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

    // 24x24 stroke icons, the design's drawings (the web toolbar's and the other native SDKs').
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
        System.Globalization.CultureInfo.InvariantCulture, $"M{c.X - r} {c.Y}a{r} {r} 0 1 0 {2 * r} 0a{r} {r} 0 1 0 {-2 * r} 0z")));

    public static T Plain<T>(T view) where T : VisualElement
    {
        // An explicit empty style: the app's implicit style for this type does not apply to Notato's controls.
        view.Style = new Style(typeof(T));
        if (view is Layout layout)
        {
            layout.SafeAreaEdges = SafeAreaEdges.None;
        }

        if (view is ContentView content)
        {
            content.SafeAreaEdges = SafeAreaEdges.None;
        }

        if (view is Border border)
        {
            border.SafeAreaEdges = SafeAreaEdges.None;
        }

        // A scroll view that reaches into a safe area (a bottom sheet over the home indicator) otherwise insets its
        // content for it, which moves it, which changes the inset: on iOS it is laid out again forever.
        if (view is ScrollView scroll)
        {
            scroll.SafeAreaEdges = SafeAreaEdges.None;
        }

        return view;
    }

    public static Label Text(string? text, double size = 14, Color? color = null, bool bold = false, int maxLines = -1, bool semibold = false)
    {
        Label label = Plain(new Label
        {
            Text = text,
            FontSize = size,
#if ANDROID
            // Android has a medium weight by name; elsewhere MAUI only has regular and bold.
            FontFamily = semibold && !bold ? "sans-serif-medium" : null,
            FontAttributes = bold ? FontAttributes.Bold : FontAttributes.None,
#else
            FontFamily = null,
            FontAttributes = bold || semibold ? FontAttributes.Bold : FontAttributes.None,
#endif
            TextColor = color ?? CardText,
            BackgroundColor = Colors.Transparent,
            LineBreakMode = maxLines == 1 ? LineBreakMode.TailTruncation : LineBreakMode.WordWrap,
            MaxLines = maxLines,
            Padding = 0,
            Margin = 0,
        });
        return label;
    }

    /// <summary>
    /// A 24×24 icon drawn at <paramref name="size"/>, keeping the drawing's own proportions and margins: stroked, or
    /// <paramref name="filled"/> (the dots).
    /// </summary>
    public static View Icon(string data, Color color, double size = 18, double stroke = 2, bool filled = false)
    {
        MauiPath path = Plain(new MauiPath
        {
            Data = (Geometry)new PathGeometryConverter().ConvertFromInvariantString(data)!,
            Stroke = filled ? null! : new SolidColorBrush(color),
            StrokeThickness = filled ? 0 : stroke,
            StrokeLineCap = PenLineCap.Round,
            StrokeLineJoin = PenLineJoin.Round,
            Fill = filled ? new SolidColorBrush(color) : null!,
            Aspect = Stretch.None,
            WidthRequest = 24,
            HeightRequest = 24,
            InputTransparent = true,
            Scale = size / 24,
        });
        Grid box = Plain(new Grid { WidthRequest = size, HeightRequest = size, InputTransparent = true, HorizontalOptions = LayoutOptions.Center, VerticalOptions = LayoutOptions.Center });
        path.HorizontalOptions = LayoutOptions.Center;
        path.VerticalOptions = LayoutOptions.Center;
        box.Children.Add(path);
        return box;
    }

    /// <summary>Gives an icon from <see cref="Icon"/> another colour.</summary>
    public static void Recolor(View icon, Color color)
    {
        if (icon is not Grid { Children: [MauiPath path] })
        {
            return;
        }

        if (path.StrokeThickness > 0)
        {
            path.Stroke = new SolidColorBrush(color);
        }
        else
        {
            path.Fill = new SolidColorBrush(color);
        }
    }

    private const string PotatoResource = "Notato.Maui.notato-potato.png";

    /// <summary>Notato's potato, tilted as the board and the web toolbar show it.</summary>
    public static Image Potato(double size) => Plain(new Image
    {
        Source = ImageSource.FromStream(() => typeof(Ui).Assembly.GetManifestResourceStream(PotatoResource)!),
        WidthRequest = size,
        HeightRequest = size,
        Aspect = Aspect.AspectFit,
        Rotation = -8,
        InputTransparent = true,
        HorizontalOptions = LayoutOptions.Center,
        VerticalOptions = LayoutOptions.Center,
    });

    public static Border Box(View? content, Color background, double radius, Thickness padding, Color? stroke = null, double strokeThickness = 0)
    {
        Border border = Plain(new Border
        {
            Content = content,
            BackgroundColor = background,
            Background = new SolidColorBrush(background),
            Stroke = stroke is null ? null : new SolidColorBrush(stroke),
            StrokeThickness = stroke is null ? 0 : strokeThickness,
            StrokeShape = new RoundRectangle { CornerRadius = radius },
            Padding = padding,
            Margin = 0,
        });
        return border;
    }

    public static void OnTap(View view, Action action)
    {
        TapGestureRecognizer tap = new();
        tap.Tapped += (_, _) => action();
        view.GestureRecognizers.Add(tap);
    }

    /// <summary>The note being written's Send: a teal pill beside a line of help, not a sheet's full-width button.</summary>
    public static Border PrimaryButton(string text, Action action)
    {
        Border box = Box(Text(text, 14, Colors.White, bold: true, maxLines: 1), Accent, 12, new Thickness(14, 9));
        box.MinimumHeightRequest = 38;
        OnTap(box, action);
        SemanticProperties.SetDescription(box, text);
        return box;
    }

    // ---- sheets: every one is drawn as the ⋯ menu is, the note being written apart -----------------------------------

    /// <summary>iOS's floating sheet has 34 corners; Material's bottom sheet 28.</summary>
    public static double SheetCorner =>
#if ANDROID
        28;
#else
        34;
#endif

    /// <summary>
    /// A bottom sheet: a grabber, then <paramref name="content"/>, with the room the menu has. Pulled down by its grabber
    /// or its header (<paramref name="content"/>'s first line), it closes through <paramref name="close"/>; what scrolls
    /// is left to scroll.
    /// </summary>
    public static Border Sheet(View content, Action close)
    {
        Border grabber = Box(null, CardLine, 2.5, new Thickness(0));
        grabber.WidthRequest = 36;
        grabber.HeightRequest = 5;
        grabber.HorizontalOptions = LayoutOptions.Center;
        grabber.VerticalOptions = LayoutOptions.Start;
        grabber.InputTransparent = true;
        // The grabber's strip is the handle, not the 5 of the grabber alone: it takes in the 10 below it as well.
        Grid handle = Plain(new Grid { HeightRequest = 15, BackgroundColor = Colors.Transparent, Children = { grabber } });
        Border sheet = Box(Plain(new VerticalStackLayout { Spacing = 0, Children = { handle, content } }), CardBackground, SheetCorner, new Thickness(18, 10, 18, 24));
        sheet.Shadow = new Shadow { Brush = new SolidColorBrush(Colors.Black), Opacity = 0.3f, Radius = 24, Offset = new Point(0, -2) };
        DragToClose(handle, sheet, close);
        if (content is Layout { Count: > 0 } lines && lines[0] is View header)
        {
            DragToClose(header, sheet, close);
        }

        return sheet;
    }

    /// <summary>Dragging <paramref name="handle"/> down moves <paramref name="sheet"/> with it; far enough (or fast), it closes.</summary>
    private static void DragToClose(View handle, View sheet, Action close)
    {
        PanGestureRecognizer pan = new();
        pan.PanUpdated += async (_, e) =>
        {
            switch (e.StatusType)
            {
                case GestureStatus.Started:
                    sheet.AbortAnimation("TranslateTo");
                    break;
                case GestureStatus.Running:
                    sheet.TranslationY = Math.Max(0, e.TotalY);
                    break;
                case GestureStatus.Completed or GestureStatus.Canceled:
                    if (e.StatusType == GestureStatus.Completed && sheet.TranslationY > SheetDragToClose)
                    {
                        await sheet.TranslateToAsync(0, Math.Max(sheet.Height, sheet.TranslationY), 150, Easing.CubicIn);
                        close();
                    }
                    else
                    {
                        await sheet.TranslateToAsync(0, 0, 200, Easing.CubicOut);
                    }
                    break;
            }
        };
        handle.GestureRecognizers.Add(pan);
    }

    /// <summary>How far a sheet is pulled down before it closes when let go, as the Swift and Android sheets have it.</summary>
    public const double SheetDragToClose = 90;

    /// <summary>The line under a sheet's title: one line, cut short if it has to be.</summary>
    public static Label SheetSubtitle(string? text) => Text(text, 12, CardMuted, maxLines: 1);

    /// <summary>
    /// A sheet's first line, as the menu's: the potato, Back or a note's pin; the title over a line about it; then the
    /// connection, or Close.
    /// </summary>
    public static Grid SheetHeader(View leading, string title, Label? subtitle, View? trailing)
    {
        Label name = Text(title, 20, CardText, bold: true, maxLines: 1);
        name.CharacterSpacing = -0.4;
        SemanticProperties.SetHeadingLevel(name, SemanticHeadingLevel.Level2);
        VerticalStackLayout titles = Plain(new VerticalStackLayout { Spacing = 2, VerticalOptions = LayoutOptions.Center, Children = { name } });
        if (subtitle is not null)
        {
            titles.Children.Add(subtitle);
        }

        leading.VerticalOptions = LayoutOptions.Center;
        Grid header = Plain(new Grid
        {
            ColumnDefinitions = { new ColumnDefinition(GridLength.Auto), new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) },
            ColumnSpacing = 12,
            Padding = new Thickness(4, 2, 2, 6),
            Children = { leading, titles },
        });
        Grid.SetColumn(titles, 1);
        if (trailing is not null)
        {
            trailing.VerticalOptions = LayoutOptions.Center;
            header.Children.Add(trailing);
            Grid.SetColumn(trailing, 2);
        }

        return header;
    }

    /// <summary>Back to the sheet this one was opened from (38, where the menu has its potato), or Close (30).</summary>
    public static Border HeaderButton(bool back, Action action, string? automationId = null)
    {
        double size = back ? 38 : 30;
        Border button = Box(Icon(back ? IconChevronLeft : IconClose, back ? CardText : CardMuted, back ? 18 : 14, back ? 2.4 : 2.2), Soft, size / 2, new Thickness(0));
        button.WidthRequest = size;
        button.HeightRequest = size;
        OnTap(button, action);
        SemanticProperties.SetDescription(button, back ? "Back" : "Close");
        button.AutomationId = automationId ?? (back ? "NotatoBack" : "NotatoClose");
        return button;
    }

    /// <summary>A sheet's 40 tile: an icon on the soft fill, teal for the main action and red for what cannot be undone.</summary>
    public static Border IconTile(string icon, MenuRowKind kind = MenuRowKind.Plain)
    {
        Color iconColor = kind switch
        {
            MenuRowKind.Primary => Colors.White,
            MenuRowKind.Danger => Danger,
            _ => CardText,
        };
        return Tile(Icon(icon, iconColor, 19), kind == MenuRowKind.Primary ? Accent : Soft, 40);
    }

    /// <summary>A note's pin as the screen draws it, in a tile.</summary>
    public static Border PinTile(int number, string status, bool pending, double size = 40) => Tile(Pin(number, status, pending), Soft, size);

    /// <summary>A 24 circle in the status colour with the note's number, in a 2 ring: white, or amber while not sent.</summary>
    public static Border Pin(int number, string status, bool pending)
    {
        Label label = Text(number > 0 ? number.ToString(System.Globalization.CultureInfo.InvariantCulture) : "", 12, Colors.White, bold: true, maxLines: 1);
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
        Border pin = Box(label, StatusColor(status), 12, new Thickness(0), pending ? Connecting : Colors.White, 2);
        pin.WidthRequest = 24;
        pin.HeightRequest = 24;
        pin.HorizontalOptions = LayoutOptions.Center;
        pin.VerticalOptions = LayoutOptions.Center;
        pin.InputTransparent = true;
        return pin;
    }

    private static Border Tile(View glyph, Color fill, double size)
    {
        Border tile = Box(glyph, fill, 12, new Thickness(0));
        tile.WidthRequest = size;
        tile.HeightRequest = size;
        tile.VerticalOptions = LayoutOptions.Center;
        tile.InputTransparent = true;
        return tile;
    }

    /// <summary>
    /// A row of a sheet, as the menu's: a tile, a title over a line about it, and a chevron when it opens another sheet.
    /// </summary>
    public static Border SheetRow(View tile, string title, string subtitle, Action action, bool chevron = false, bool danger = false, int titleLines = 1)
    {
        Label name = Text(title, 15.5, danger ? Danger : CardText, maxLines: 1, semibold: true);
        name.MaxLines = titleLines;
        Label about = Text(subtitle, 12.5, CardMuted, maxLines: 1);
        VerticalStackLayout text = Plain(new VerticalStackLayout { Spacing = 2, VerticalOptions = LayoutOptions.Center, Children = { name, about } });
        Grid line = Plain(new Grid
        {
            ColumnDefinitions = { new ColumnDefinition(GridLength.Auto), new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) },
            ColumnSpacing = 14,
            Children = { tile, text },
        });
        Grid.SetColumn(text, 1);
        if (chevron)
        {
            Label mark = Text("›", 18, CardMuted, maxLines: 1);
            mark.VerticalOptions = LayoutOptions.Center;
            line.Children.Add(mark);
            Grid.SetColumn(mark, 2);
        }

        Border row = Box(line, Colors.Transparent, 14, new Thickness(4, 7));
        row.MinimumHeightRequest = 58;
        SemanticProperties.SetDescription(row, title);
        OnTap(row, action);
        return row;
    }

    /// <summary>The rule above a group of rows, in the middle of the room before it.</summary>
    public static BoxView Rule() => Plain(new BoxView { HeightRequest = 1, Color = CardLine, BackgroundColor = Colors.Transparent, InputTransparent = true, Margin = new Thickness(0, 4) });

    /// <summary>A label over a text field in a sheet.</summary>
    public static Label FieldLabel(string text)
    {
        Label label = Text(text, 12.5, CardMuted, maxLines: 1, semibold: true);
        label.Margin = new Thickness(4, 0);
        return label;
    }

    /// <summary>What a sheet's button is for: its fill and ink.</summary>
    public enum SheetButtonKind
    {
        Plain,
        Primary,
        /// <summary>Quiet, in red: deleting one note.</summary>
        Danger,
        /// <summary>Filled red: confirming what cannot be undone.</summary>
        Destructive,
    }

    /// <summary>A sheet's button: 50 tall, as wide as <see cref="ButtonRow"/> lets it be.</summary>
    public static Border SheetButton(string text, Action action, SheetButtonKind kind = SheetButtonKind.Plain)
    {
        Color back = kind switch
        {
            SheetButtonKind.Primary => Accent,
            SheetButtonKind.Destructive => Danger,
            _ => Soft,
        };
        Color fore = kind switch
        {
            SheetButtonKind.Primary or SheetButtonKind.Destructive => Colors.White,
            SheetButtonKind.Danger => Danger,
            _ => CardText,
        };
        Label label = Text(text, 15, fore, bold: kind is SheetButtonKind.Primary or SheetButtonKind.Destructive, maxLines: 1, semibold: true);
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
        Border button = Box(label, back, 14, new Thickness(14, 0));
        button.HeightRequest = 50;
        OnTap(button, action);
        SemanticProperties.SetDescription(button, text);
        return button;
    }

    /// <summary>A sheet's buttons side by side in equal widths; one above the other when their words would not fit.</summary>
    public static ButtonRow ButtonRow(params Border[] buttons)
    {
        ButtonRow row = Plain(new ButtonRow());
        foreach (Border button in buttons)
        {
            row.Children.Add(button);
        }

        return row;
    }

    /// <summary>A row with a switch at its end, as the menu's rows are drawn: tapping the words flips it.</summary>
    public static (Grid Row, Switch Switch) SwitchTileRow(View tile, string title, string hint, bool on, string automationId)
    {
        (Grid row, Switch toggle) = SwitchRow(title, hint, on, automationId);
        row.ColumnDefinitions.Insert(0, new ColumnDefinition(GridLength.Auto));
        foreach (View child in row.Children.OfType<View>())
        {
            Grid.SetColumn(child, Grid.GetColumn(child) + 1);
        }

        row.Children.Insert(0, tile);
        Grid.SetColumn(tile, 0);
        row.ColumnSpacing = 14;
        row.Padding = new Thickness(4, 7);
        row.MinimumHeightRequest = 58;
        return (row, toggle);
    }

    public static Border Badge(string text, string kind)
    {
        if (kind == PeopleOnlyBadge)
        {
            // As the web toolbar draws it: no fill, a hairline, small muted capitals. It is not a status, so it has no colour.
            Label caps = Text(text.ToUpperInvariant(), 10.5, CardMuted, bold: true, maxLines: 1);
            caps.CharacterSpacing = 0.4;
            // Read out as the words, not as capitals.
            SemanticProperties.SetDescription(caps, text);
            return Box(caps, Colors.Transparent, 9, new Thickness(7, 2), CardLine, 1);
        }

        (Color? back, Color? fore) = BadgeColors(kind);
        return Box(Text(text, 11, fore, bold: true, maxLines: 1), back, 9, new Thickness(7, 2));
    }

    /// <summary>A row of choices of which at most one is on; tapping the one that is on turns it off.</summary>
    public sealed class ChipRow : HorizontalStackLayout
    {
        private readonly List<(string Value, Border Box, Label Label)> _chips = [];

        public ChipRow(IEnumerable<(string Value, string Label)> options)
        {
            Plain(this);
            Spacing = 6;
            foreach ((string? value, string? label) in options)
            {
                Label text = Text(label, 13, CardText, maxLines: 1);
                Border box = Box(text, Colors.Transparent, 14, new Thickness(11, 6), CardLine, 1);
                OnTap(box, () => Selected = Selected == value ? null : value);
                SemanticProperties.SetDescription(box, label);
                _chips.Add((value, box, text));
                Children.Add(box);
            }
        }

        private string? _selected;

        public string? Selected
        {
            get => _selected;
            set
            {
                _selected = value;
                foreach ((string? v, Border? box, Label? label) in _chips)
                {
                    bool on = v == value;
                    box.BackgroundColor = on ? Accent : Colors.Transparent;
                    box.Background = new SolidColorBrush(on ? Accent : Colors.Transparent);
                    box.Stroke = new SolidColorBrush(on ? Accent : CardLine);
                    label.TextColor = on ? Colors.White : CardText;
                }
            }
        }
    }

    /// <summary>
    /// The server's mention plugins that can be called now, as chips under a text box: a tap puts <c>@name</c> at the
    /// start of the text, or takes it out. Hidden when there are none, which is the server's default: the agent gets
    /// everything people write without being mentioned.
    /// </summary>
    public sealed class MentionRow : HorizontalStackLayout
    {
        private readonly InputView _input;
        private readonly List<(string Name, Border Box, Label Label)> _chips = [];
        private string _shown = "";

        public MentionRow(InputView input)
        {
            Plain(this);
            Spacing = 6;
            IsVisible = false;
            _input = input;
            input.TextChanged += (_, _) => Refresh();
        }

        public void SetMentions(IReadOnlyList<Model.MentionInfo> available)
        {
            string key = string.Join(',', available.Select(m => m.Name));
            if (key == _shown)
            {
                return;
            }

            _shown = key;
            Children.Clear();
            _chips.Clear();
            foreach (MentionInfo mention in available)
            {
                Label text = Text("@" + mention.Name, 13, Accent, bold: true, maxLines: 1);
                Border box = Box(text, Colors.Transparent, 14, new Thickness(11, 6), Accent, 1);
                string name = mention.Name;
                OnTap(box, () => _input.Text = Inspection.Mentions.Toggle(_input.Text, name));
                SemanticProperties.SetDescription(box, $"@{mention.Name}: {mention.Description}");
                box.AutomationId = "NotatoMention-" + mention.Name;
                _chips.Add((name, box, text));
                Children.Add(box);
            }
            IsVisible = _chips.Count > 0;
            Refresh();
        }

        private void Refresh()
        {
            foreach ((string? name, Border? box, Label? label) in _chips)
            {
                bool on = Inspection.Mentions.Has(_input.Text, name);
                box.Background = new SolidColorBrush(on ? Accent : Colors.Transparent);
                label.TextColor = on ? Colors.White : Accent;
            }
        }
    }

    /// <summary>
    /// An on/off choice in a card: its name and a line saying what it does, with a switch at the end. Tapping the words
    /// flips it too.
    /// </summary>
    public static (Grid Row, Switch Switch) SwitchRow(string title, string hint, bool on, string automationId)
    {
        Switch toggle = Plain(new Switch
        {
            IsToggled = on,
            OnColor = Accent,
            ThumbColor = Colors.White,
            HorizontalOptions = LayoutOptions.End,
            VerticalOptions = LayoutOptions.Center,
            AutomationId = automationId,
        });
        SemanticProperties.SetDescription(toggle, title);
        SemanticProperties.SetHint(toggle, hint);
        VerticalStackLayout words = Plain(new VerticalStackLayout
        {
            Spacing = 2,
            VerticalOptions = LayoutOptions.Center,
            Children = { Text(title, 15, CardText, semibold: true, maxLines: 1), Text(hint, 12.5, CardMuted) },
        });
        OnTap(words, () => toggle.IsToggled = !toggle.IsToggled);
        Grid row = Plain(new Grid { ColumnDefinitions = { new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) }, ColumnSpacing = 10 });
        row.Children.Add(words);
        row.Children.Add(toggle);
        Grid.SetColumn(toggle, 1);
        return (row, toggle);
    }

    public static Shadow CardShadow() => new() { Brush = new SolidColorBrush(Colors.Black), Opacity = 0.28f, Radius = 18, Offset = new Point(0, 6) };

    /// <summary>The bar's soft drop shadow (the web's 0 14 34 -12 rgba(15,17,20,0.55), as near as MAUI's goes).</summary>
    public static Shadow BarShadow() => new() { Brush = new SolidColorBrush(Color.FromArgb("#0f1114")), Opacity = 0.45f, Radius = 16, Offset = new Point(0, 8) };

    /// <summary>
    /// The note being written: it floats away from what it is about, at the top or the bottom, so it is a sheet's surface
    /// without the grabber.
    /// </summary>
    public static Border Card(View content)
    {
        Border card = Box(content, CardBackground, 28, new Thickness(18, 16, 18, 18));
        card.Shadow = CardShadow();
        return card;
    }

    public static string Ago(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out DateTimeOffset at))
        {
            return "";
        }

        TimeSpan span = DateTimeOffset.UtcNow - at;
        return span.TotalSeconds < 60 ? "just now"
            : span.TotalMinutes < 60 ? $"{(int)span.TotalMinutes}m ago"
            : span.TotalHours < 24 ? $"{(int)span.TotalHours}h ago"
            : $"{(int)span.TotalDays}d ago";
    }

    public static string Humanize(string value) => value.Replace('_', ' ');
}
