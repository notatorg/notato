using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using System.Globalization;

namespace Notato.Maui.Overlay;

// Sheets: every one (the ⋯ menu, Notes, Settings, Clear notes, a note's card) is drawn as the menu is, the note being
// written apart. The same metrics as the Swift and Android SDKs' sheets.
internal static partial class Ui
{
    /// <summary>How far a sheet is pulled down before it closes when let go, as the Swift and Android sheets have it.</summary>
    public const double SheetDragToClose = 90;

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
    private static Border Pin(int number, string status, bool pending)
    {
        Label label = Text(number > 0 ? number.ToString(CultureInfo.InvariantCulture) : "", 12, Colors.White, bold: true, maxLines: 1);
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
        Border pin = Box(label, StatusColor(status), 12, new Thickness(0), pending ? Connecting : Colors.White, 2);
        pin.WidthRequest = PinLayout.Diameter;
        pin.HeightRequest = PinLayout.Diameter;
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
}
