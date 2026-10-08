using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;

namespace Notato.Maui.Overlay;

/// <summary>
/// The toolbar's ⋯ sheet: the potato, "Notato", the mode and server, the connection; a banner with Retry while the
/// server cannot be reached; then everything else Notato does, as rows in groups. It follows the connection while it is
/// open (<see cref="Refresh"/>), and the rest of it keeps working whatever the server does.
/// </summary>
internal sealed class MenuSheet : ContentView
{
    private readonly NotatoController _controller;
    private readonly OverlaySession _session;
    private readonly Action<MenuAction> _run;
    private readonly Label _sub;
    private readonly Border _pill;
    private readonly Border _pillDot;
    private readonly Label _pillText;
    private readonly Border _banner;
    private readonly Label _bannerTitle;
    private readonly Label _bannerBody;
    private readonly Border _retry;
    private readonly Label _retryText;
    private readonly VerticalStackLayout _rows;
    private string _shownRows = "";
    /// <summary>A refused connection fails at once: Retry shows that it tried for a moment at least.</summary>
    private long _retryShownUntil;

    /// <param name="controller">What the sheet shows, and Retry.</param>
    /// <param name="session">The window it is in: its screen's notes are counted.</param>
    /// <param name="run">Does what a row says; the sheet is closed first.</param>
    /// <param name="close">Closes it: pulled down by its grabber or header.</param>
    public MenuSheet(NotatoController controller, OverlaySession session, Action<MenuAction> run, Action close)
    {
        Ui.Plain(this);
        _controller = controller;
        _session = session;
        _run = run;

        // ---- header: potato, name and where it is, and the connection ------------------------------------------------
        _sub = Ui.SheetSubtitle("");

        _pillDot = Ui.Box(null, Ui.Connected, 3.5, new Thickness(0));
        _pillDot.WidthRequest = 7;
        _pillDot.HeightRequest = 7;
        _pillDot.VerticalOptions = LayoutOptions.Center;
        _pillDot.InputTransparent = true;
        _pillText = Ui.Text("", 12, Ui.CardText, bold: true, maxLines: 1);
        _pillText.VerticalOptions = LayoutOptions.Center;
        _pill = Ui.Box(Ui.Plain(new HorizontalStackLayout { Spacing = 6, VerticalOptions = LayoutOptions.Center, Children = { _pillDot, _pillText } }),
            Colors.Transparent, 12, new Thickness(10, 0));
        _pill.HeightRequest = 24;
        _pill.InputTransparent = true;
        _pill.AutomationId = "NotatoMenuStatus";

        Grid header = Ui.SheetHeader(Ui.Potato(38), "Notato", _sub, _pill);

        // ---- the banner while the server cannot be reached ---------------------------------------------------------
        _bannerTitle = Ui.Text("", 13, Ui.CardText, bold: true);
        _bannerBody = Ui.Text("", 13, Ui.CardMuted);
        _bannerBody.LineHeight = 1.15;
        _retryText = Ui.Text("Retry", 13, Ui.CardBackground, bold: true, maxLines: 1);
        _retryText.HorizontalOptions = LayoutOptions.Center;
        _retry = Ui.Box(_retryText, Ui.CardText, 10, new Thickness(12, 7));
        _retry.VerticalOptions = LayoutOptions.Start;
        _retry.AutomationId = "NotatoRetry";
        SemanticProperties.SetDescription(_retry, "Retry the server now");
        Ui.OnTap(_retry, Retry);
        VerticalStackLayout bannerText = Ui.Plain(new VerticalStackLayout { Spacing = 2, Children = { _bannerTitle, _bannerBody } });
        Grid bannerGrid = Ui.Plain(new Grid
        {
            ColumnDefinitions = { new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) },
            ColumnSpacing = 10,
            Children = { bannerText, _retry },
        });
        Grid.SetColumn(_retry, 1);
        _banner = Ui.Box(bannerGrid, Ui.Tint(Ui.Offline, 0.12), 16, new Thickness(12, 11));
        _banner.IsVisible = false;
        _banner.AutomationId = "NotatoOfflineBanner";

        _rows = Ui.Plain(new VerticalStackLayout { Spacing = 0 });

        Content = Ui.Sheet(Ui.Plain(new VerticalStackLayout { Spacing = 10, Children = { header, _banner, _rows } }), close);
        Refresh();
    }

    /// <summary>The phone, or the tablet: where notes stay without a server.</summary>
    private static string Device()
    {
        try
        {
            return DeviceInfo.Current.Idiom == DeviceIdiom.Phone ? "phone" : "device";
        }
        catch
        {
            return "device"; // plain net10.0
        }
    }

    private void Retry()
    {
        if (_controller.Retrying)
        {
            return;
        }

        _retryShownUntil = Environment.TickCount64 + RetryShownMs;
        _controller.RetryConnection();
        Refresh();
        Dispatcher.DispatchDelayed(TimeSpan.FromMilliseconds(RetryShownMs + 20), Refresh);
    }

    private const int RetryShownMs = 700;

    /// <summary>Follows the connection, the counts and the pins' visibility while the sheet is open.</summary>
    public void Refresh()
    {
        string device = Device();
        _sub.Text = MenuText.SubLine(_controller.Mode, _controller.Server, device);

        bool retrying = _controller.Retrying || (_controller.Unreachable is not null && Environment.TickCount64 < _retryShownUntil);
        NotatoConnection shown = retrying ? NotatoConnection.Connecting : _controller.ShownConnection;
        if (MenuText.Pill(shown, _controller.HasServer) is { } look)
        {
            Color color = Color.FromArgb(look.Color);
            _pill.IsVisible = true;
            _pill.BackgroundColor = Ui.Tint(color, 0.14);
            _pill.Background = new SolidColorBrush(Ui.Tint(color, 0.14));
            _pillDot.BackgroundColor = color;
            _pillDot.Background = new SolidColorBrush(color);
            _pillText.Text = look.Label;
            SemanticProperties.SetDescription(_pill, look.Label);
        }
        else
        {
            _pill.IsVisible = false;
        }

        if (_controller.Unreachable is { } failure)
        {
            (string? title, string? body) = MenuText.Banner(failure, _controller.Server, _controller.ConnectionDetail, device);
            _bannerTitle.Text = title;
            _bannerBody.Text = body;
            // Faded while it tries (the pill says "Connecting…"); the label stays, so the banner does not change size.
            _retry.Opacity = retrying ? 0.45 : 1;
            _banner.IsVisible = true;
        }
        else
        {
            _banner.IsVisible = false;
        }

        List<MenuRow> list = MenuText.Rows(new MenuFacts(_controller.Mode, _controller.PinsVisible, _controller.CountOnRoute(_session),
            _controller.Annotations.Count, _controller.PendingCount, _controller.ShakeAvailable));
        string key = string.Join("\n", list.Select(r => r.Title + "\t" + r.Subtitle));
        if (key == _shownRows)
        {
            return;
        }

        _shownRows = key;
        _rows.Children.Clear();
        for (int i = 0; i < list.Count; i++)
        {
            // A rule above the first row of each group after the first.
            if (i > 0 && list[i].Group != list[i - 1].Group)
            {
                _rows.Children.Add(Ui.Rule());
            }

            _rows.Children.Add(Row(list[i]));
        }
    }

    private View Row(MenuRow row)
    {
        MenuAction action = row.Action;
        Border box = Ui.SheetRow(Ui.IconTile(row.Icon, row.Kind), row.Title, row.Subtitle, () => _run(action), row.Chevron, row.Kind == MenuRowKind.Danger);
        box.AutomationId = "NotatoMenu-" + row.Action;
        return box;
    }
}
