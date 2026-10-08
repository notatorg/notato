using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using System.Globalization;
using MauiPath = Microsoft.Maui.Controls.Shapes.Path;

namespace Notato.Maui.Overlay;

/// <summary>
/// The overlay's look, and small builders for its controls. Every value is set on the control itself so the app's own
/// implicit styles (its Label, Border and Editor styles) cannot reach Notato's UI. The colours and icons are in
/// <c>Ui.Palette.cs</c>, the sheets' parts in <c>Ui.Sheets.cs</c>.
/// </summary>
internal static partial class Ui
{
    /// <summary>The badge kind (for <see cref="Badge"/>) of a People only note.</summary>
    public const string PeopleOnlyBadge = "people_only";

    private const string PotatoResource = "Notato.Maui.notato-potato.png";

    /// <summary>The size the icons are drawn at; <see cref="Icon"/> scales them.</summary>
    private const double IconBox = 24;

    /// <summary>
    /// Shuts the app's styling out of <paramref name="view"/>: an explicit empty style, so the app's implicit style for
    /// its type does not apply, and no safe-area insets of its own (Notato places its parts itself).
    /// </summary>
    public static T Plain<T>(T view) where T : VisualElement
    {
        view.Style = new Style(typeof(T));
        switch (view)
        {
            case Layout layout:
                layout.SafeAreaEdges = SafeAreaEdges.None;
                break;
            case ContentView content:
                content.SafeAreaEdges = SafeAreaEdges.None;
                break;
            case Border border:
                border.SafeAreaEdges = SafeAreaEdges.None;
                break;
            case ScrollView scroll:
                // A scroll view that reaches into a safe area (a bottom sheet over the home indicator) otherwise insets
                // its content for it, which moves it, which changes the inset: on iOS it is laid out again forever.
                scroll.SafeAreaEdges = SafeAreaEdges.None;
                break;
        }

        return view;
    }

    public static Label Text(string? text, double size = 14, Color? color = null, bool bold = false, int maxLines = -1, bool semibold = false) => Plain(new Label
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

    /// <summary>
    /// A 24×24 icon drawn at <paramref name="size"/>, keeping the drawing's own proportions and margins: stroked, or
    /// <paramref name="filled"/> (the dots).
    /// </summary>
    public static View Icon(string data, Color color, double size = 18, double stroke = 2, bool filled = false)
    {
        MauiPath path = Plain(new MauiPath
        {
            Data = (Geometry)new PathGeometryConverter().ConvertFromInvariantString(data)!,
            StrokeThickness = filled ? 0 : stroke,
            StrokeLineCap = PenLineCap.Round,
            StrokeLineJoin = PenLineJoin.Round,
            Aspect = Stretch.None,
            WidthRequest = IconBox,
            HeightRequest = IconBox,
            InputTransparent = true,
            Scale = size / IconBox,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
        });
        Recolor(path, color);
        return Plain(new Grid
        {
            WidthRequest = size,
            HeightRequest = size,
            InputTransparent = true,
            HorizontalOptions = LayoutOptions.Center,
            VerticalOptions = LayoutOptions.Center,
            Children = { path },
        });
    }

    /// <summary>Gives an icon from <see cref="Icon"/> another colour.</summary>
    public static void Recolor(View icon, Color color)
    {
        if (icon is Grid { Children: [MauiPath path] })
        {
            Recolor(path, color);
        }
    }

    /// <summary>A stroked drawing's stroke, or a filled one's fill.</summary>
    private static void Recolor(MauiPath path, Color color)
    {
        if (path.StrokeThickness > 0)
        {
            path.Stroke = new SolidColorBrush(color);
        }
        else
        {
            path.Fill = new SolidColorBrush(color);
        }
    }

    /// <summary>Notato's potato, tilted as the board and the web toolbar show it.</summary>
    public static Image Potato(double size) => Plain(new Image
    {
        Source = ImageSource.FromStream(() => typeof(Ui).Assembly.GetManifestResourceStream(PotatoResource)),
        WidthRequest = size,
        HeightRequest = size,
        Aspect = Aspect.AspectFit,
        Rotation = -8,
        InputTransparent = true,
        HorizontalOptions = LayoutOptions.Center,
        VerticalOptions = LayoutOptions.Center,
    });

    public static Border Box(View? content, Color background, double radius, Thickness padding, Color? stroke = null, double strokeThickness = 0) => Plain(new Border
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

    /// <summary>A note's status, intent or severity, or <see cref="PeopleOnlyBadge"/>, as a small pill.</summary>
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

        (Color back, Color fore) = BadgeColors(kind);
        return Box(Text(text, 11, fore, bold: true, maxLines: 1), back, 9, new Thickness(7, 2));
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

    /// <summary>How long ago an ISO 8601 time was, as the board says it: "just now", "5m ago", "3d ago".</summary>
    public static string Ago(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out DateTimeOffset at))
        {
            return "";
        }

        TimeSpan span = DateTimeOffset.UtcNow - at;
        return span.TotalSeconds < 60 ? "just now"
            : span.TotalMinutes < 60 ? $"{(int)span.TotalMinutes}m ago"
            : span.TotalHours < 24 ? $"{(int)span.TotalHours}h ago"
            : $"{(int)span.TotalDays}d ago";
    }

    /// <summary>A schema value as words: <c>revert_requested</c> reads "revert requested".</summary>
    public static string Humanize(string value) => value.Replace('_', ' ');
}
