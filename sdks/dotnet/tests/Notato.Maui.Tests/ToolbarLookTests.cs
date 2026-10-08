using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Maui;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Notato.Maui.Model;
using Notato.Maui.Overlay;

namespace Notato.Maui.Tests;

/// <summary>The toolbar and its ⋯ sheet as the design ("6e") has them: what they say, and in which colours.</summary>
public class ToolbarLookTests
{
    // ---- the bar ----------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(0, "0")]
    [InlineData(-2, "0")]
    [InlineData(1, "1")]
    [InlineData(99, "99")]
    [InlineData(100, "99+")]
    public void Annotates_count_is_always_shown_and_capped_at_99(int count, string expected) =>
        Assert.Equal(expected, MenuText.BarCount(count));

    [Fact]
    public void The_corner_is_16_open_and_rounds_into_the_circle_as_it_folds()
    {
        Assert.Equal(27, ToolbarFold.Corner(54, 54, 16));
        Assert.Equal(16, ToolbarFold.Corner(94, 54, 16));
        Assert.Equal(16, ToolbarFold.Corner(260, 54, 16));
        Assert.Equal(21.5, ToolbarFold.Corner(74, 54, 16), 9);
        double previous = double.MaxValue;
        for (double width = 54.0; width <= 260; width += 0.5)
        {
            double corner = ToolbarFold.Corner(width, 54, 16);
            Assert.True(corner <= previous);
            previous = corner;
        }
    }

    // ---- the connection, as shown -----------------------------------------------------------------------------------

    [Theory]
    // The SDK's own tries after a failure keep showing the failure: no flicker.
    [InlineData(NotatoConnection.Connecting, NotatoConnection.Offline, false, NotatoConnection.Offline)]
    [InlineData(NotatoConnection.Connecting, NotatoConnection.Refused, false, NotatoConnection.Refused)]
    // A try the person asked for (Retry) shows as connecting.
    [InlineData(NotatoConnection.Connecting, NotatoConnection.Offline, true, NotatoConnection.Connecting)]
    // The first try, before anything failed.
    [InlineData(NotatoConnection.Connecting, null, false, NotatoConnection.Connecting)]
    [InlineData(NotatoConnection.Offline, NotatoConnection.Offline, false, NotatoConnection.Offline)]
    [InlineData(NotatoConnection.Connected, null, false, NotatoConnection.Connected)]
    [InlineData(NotatoConnection.Local, null, false, NotatoConnection.Local)]
    public void Retries_after_a_failure_show_the_failure_unless_the_person_asked(
        NotatoConnection connection, NotatoConnection? lastFailure, bool retrying, NotatoConnection shown) =>
        Assert.Equal(shown, MenuText.Shown(connection, lastFailure, retrying));

    [Theory]
    [InlineData(NotatoConnection.Connected, "Connected", "#2e9a5b")]
    [InlineData(NotatoConnection.Connecting, "Connecting…", "#d99a1e")]
    [InlineData(NotatoConnection.Offline, "Offline", "#ef6b5e")]
    [InlineData(NotatoConnection.Refused, "Refused", "#ef6b5e")]
    public void The_status_pill_names_the_connection_in_its_colour(NotatoConnection shown, string label, string color) =>
        Assert.Equal((label, color), MenuText.Pill(shown, hasServer: true));

    [Fact]
    public void There_is_no_pill_without_a_server()
    {
        Assert.Null(MenuText.Pill(NotatoConnection.Local, hasServer: false));
        Assert.Null(MenuText.Pill(NotatoConnection.Connected, hasServer: false));
    }

    [Theory]
    [InlineData(NotatoMode.Dev, "http://localhost:4792", "Dev mode · localhost:4792")]
    [InlineData(NotatoMode.Test, null, "Test mode · notes stay on this phone")]
    [InlineData(NotatoMode.Agent, "https://notato.example.com/", "Agent mode · notato.example.com")]
    public void The_header_says_the_mode_and_the_server_or_where_notes_stay(NotatoMode mode, string? server, string expected) =>
        Assert.Equal(expected, MenuText.SubLine(mode, server, "phone"));

    [Fact]
    public void The_banner_says_the_server_is_not_answering_or_refused_this_app()
    {
        Assert.Equal(("Can't reach the server", "localhost:4792 isn't answering. Notes stay on this phone and send when it's back."),
            MenuText.Banner(NotatoConnection.Offline, "http://localhost:4792", "Lost the server", "phone"));
        Assert.Equal(("The server refused this app", "The token is not valid."),
            MenuText.Banner(NotatoConnection.Refused, "http://localhost:4792", "The token is not valid.", "phone"));
    }

    // ---- the sheet's rows -------------------------------------------------------------------------------------------

    [Fact]
    public void Dev_mode_has_annotate_pins_notes_then_settings_then_hide_and_off()
    {
        List<MenuRow> rows = MenuText.Rows(new MenuFacts(NotatoMode.Dev, PinsVisible: true, OnScreen: 2, All: 7, Pending: 0, Shake: true));
        Assert.Equal(["Annotate", "Hide pins", "Notes", "Settings", "Hide toolbar", "Turn Notato off"], rows.Select(r => r.Title));
        Assert.Equal(["Tap an element, write a note", "2 pins on this screen", "2 on this screen · 7 in all", "Your name, screenshots, server",
            "Shake to bring it back", "Until the app turns it on again"], rows.Select(r => r.Subtitle));
        Assert.Equal([0, 0, 0, 2, 3, 3], rows.Select(r => r.Group));
        Assert.Equal(["Notes", "Settings"], rows.Where(r => r.Chevron).Select(r => r.Title));
        Assert.Equal(MenuRowKind.Primary, rows[0].Kind);
        Assert.Equal(["Turn Notato off"], rows.Where(r => r.Kind == MenuRowKind.Danger).Select(r => r.Title));
        Assert.Equal([MenuAction.Annotate, MenuAction.TogglePins, MenuAction.Notes, MenuAction.Settings, MenuAction.HideToolbar, MenuAction.TurnOff],
            rows.Select(r => r.Action));
    }

    [Fact]
    public void Test_mode_with_notes_to_send_adds_package_and_clear_in_their_own_group()
    {
        List<MenuRow> rows = MenuText.Rows(new MenuFacts(NotatoMode.Test, PinsVisible: true, OnScreen: 2, All: 7, Pending: 7, Shake: false));
        Assert.Equal(["Annotate", "Hide pins", "Notes", "Package and share", "Clear notes", "Settings", "Hide toolbar", "Turn Notato off"],
            rows.Select(r => r.Title));
        MenuRow package = rows.Single(r => r.Action == MenuAction.Package);
        MenuRow clear = rows.Single(r => r.Action == MenuAction.Clear);
        Assert.True(package.Chevron);
        Assert.Equal("Zip with screenshots, share anywhere", package.Subtitle);
        Assert.Equal(MenuRowKind.Danger, clear.Kind);
        Assert.Equal("Removes all 7 from this device", clear.Subtitle);
        Assert.Equal(1, package.Group);
        Assert.Equal(1, clear.Group);
        Assert.Equal("The app can bring it back", rows.Single(r => r.Action == MenuAction.HideToolbar).Subtitle);

        // As before: nothing to package, no package rows.
        Assert.DoesNotContain(MenuText.Rows(new MenuFacts(NotatoMode.Test, true, 0, 0, 0, false)), r => r.Action is MenuAction.Package or MenuAction.Clear);
    }

    [Fact]
    public void Hidden_pins_offer_to_show_them()
    {
        MenuRow pins = MenuText.Rows(new MenuFacts(NotatoMode.Dev, PinsVisible: false, OnScreen: 1, All: 1, Pending: 0, Shake: true))[1];
        Assert.Equal("Show pins", pins.Title);
        Assert.Equal(Ui.IconEye, pins.Icon);
        Assert.Equal("1 pin on this screen", pins.Subtitle);
        Assert.Equal("No pins on this screen", MenuText.PinsLine(0));
    }

    [Fact]
    public void The_sheet_builds_with_no_server_no_pill_and_no_banner()
    {
        NotatoController controller = new(new FixedOptions(new NotatoOptions
        {
            Project = "look-test",
            Server = "",
            RememberRuntimeState = false,
            CaptureLogs = false,
            ShakeToToggle = false,
        }), NullLogger<NotatoController>.Instance);
        controller.Start();
        MenuSheet sheet = new(controller, new OverlaySession(new Window(), null!), _ => { }, () => { });
        List<IVisualTreeElement> all = [.. Descendants(sheet)];

        Assert.Equal(["NotatoMenu-Annotate", "NotatoMenu-TogglePins", "NotatoMenu-Notes", "NotatoMenu-Settings", "NotatoMenu-HideToolbar", "NotatoMenu-TurnOff"],
            all.OfType<VisualElement>().Select(e => e.AutomationId).Where(id => id?.StartsWith("NotatoMenu-", StringComparison.Ordinal) == true));
        Assert.False(all.OfType<Border>().Single(b => b.AutomationId == "NotatoMenuStatus").IsVisible);
        Assert.False(all.OfType<Border>().Single(b => b.AutomationId == "NotatoOfflineBanner").IsVisible);
        Assert.Contains(all.OfType<Label>(), l => l.Text == "Dev mode · notes stay on this device");
        Assert.Contains(all.OfType<Image>(), i => i.Rotation == -8);
        // Rules between the groups: before Settings, and before Hide toolbar.
        Assert.Equal(2, all.OfType<BoxView>().Count(b => b.HeightRequest == 1));
        controller.Dispose();
    }

    private sealed class FixedOptions(NotatoOptions value) : Microsoft.Extensions.Options.IOptionsMonitor<NotatoOptions>
    {
        public NotatoOptions CurrentValue => value;
        public NotatoOptions Get(string? name) => value;
        public IDisposable? OnChange(Action<NotatoOptions, string?> listener) => null;
    }

    // ---- the other sheets are drawn as the menu is ------------------------------------------------------------------

    [Fact]
    public void A_notes_card_goes_back_to_the_list_it_came_from_and_shows_its_pin_otherwise()
    {
        NotatoController controller = new(new FixedOptions(new NotatoOptions
        {
            Project = "look-test",
            Server = "",
            RememberRuntimeState = false,
            CaptureLogs = false,
            ShakeToToggle = false,
        }), NullLogger<NotatoController>.Instance);
        controller.Start();
        NotatoController.Record record = new(Fixtures.Annotation()) { Pending = true, Mine = true };

        List<IVisualTreeElement> fromList = [.. Descendants(new PinCard(controller, new OverlaySession(null!, null!), record, 2, () => { }, () => { }))];
        List<IVisualTreeElement> fromPin = [.. Descendants(new PinCard(controller, new OverlaySession(null!, null!), record, 2, () => { }))];

        foreach (List<IVisualTreeElement> card in new[] { fromList, fromPin })
        {
            Assert.Contains(card.OfType<Label>(), l => l.Text == "Note 2");
            Assert.Single(card.OfType<Border>(), b => b.AutomationId == "NotatoClose");
            // Close is the header's: no Close button at the bottom any more.
            Assert.DoesNotContain(card.OfType<Border>(), b => SemanticProperties.GetDescription(b) == "Close" && b.AutomationId != "NotatoClose");
            Assert.Contains(card.OfType<Border>(), b => SemanticProperties.GetDescription(b) == "Delete" && b.HeightRequest == 50);
        }

        Assert.Single(fromList.OfType<Border>(), b => b.AutomationId == "NotatoBack");
        Assert.DoesNotContain(fromPin.OfType<Border>(), b => b.AutomationId == "NotatoBack");
        // Without Back, its pin leads the header, as on the screen.
        Assert.Contains(fromPin.OfType<Border>(), b => b is { WidthRequest: 38, Content: Border { WidthRequest: 24 } });
        controller.Dispose();
    }

    [Theory]
    // Two short labels share a phone's width; a long one, or three that each need more than a third, stack.
    [InlineData(350, new[] { 100.0, 60.0 }, true)]
    [InlineData(350, new[] { 210.0, 60.0 }, false)]
    [InlineData(350, new[] { 110.0, 110.0, 110.0 }, true)]
    [InlineData(350, new[] { 120.0, 80.0, 80.0 }, false)]
    // Large text: what fits at normal size no longer does.
    [InlineData(300, new[] { 150.0, 90.0 }, false)]
    [InlineData(350, new[] { 400.0 }, true)]
    public void A_sheets_buttons_share_the_row_only_when_each_ones_words_fit_its_share(double width, double[] needed, bool sideBySide) =>
        Assert.Equal(sideBySide, ButtonRow.SideBySide(width, needed));

    [Fact]
    public void Every_sheet_can_be_pulled_down_by_its_grabber_and_header()
    {
        Border sheet = Ui.Sheet(Ui.Plain(new VerticalStackLayout { Children = { Ui.SheetHeader(Ui.Potato(38), "Notes", null, null), new Label() } }), () => { });
        List<IVisualTreeElement> all = [.. Descendants(sheet)];
        // The grabber's strip and the header each carry the drag; nothing else does, so what scrolls keeps scrolling.
        Assert.Equal(2, all.OfType<View>().Count(v => v.GestureRecognizers.OfType<PanGestureRecognizer>().Any()));
        Assert.True(all.OfType<Grid>().Single(g => g.ColumnDefinitions.Count == 3).GestureRecognizers.OfType<PanGestureRecognizer>().Any());
    }

    [Fact]
    public void One_note_to_clear_reads_as_in_the_other_sdks() =>
        Assert.Equal("Removes the note on this device", MenuText.ClearLine(1));

    private static IEnumerable<IVisualTreeElement> Descendants(IVisualTreeElement root)
    {
        foreach (IVisualTreeElement child in root.GetVisualChildren())
        {
            yield return child;
            foreach (IVisualTreeElement deeper in Descendants(child))
            {
                yield return deeper;
            }
        }
    }

    // ---- colours and drawings -------------------------------------------------------------------------------------

    [Theory]
    [InlineData(Statuses.Open, "#1f8a78")]
    [InlineData(Statuses.Acknowledged, "#d99a1e")]
    [InlineData(Statuses.Resolved, "#2e9a5b")]
    [InlineData(Statuses.RevertRequested, "#8b5cf6")]
    [InlineData(Statuses.VariantChosen, "#0891b2")]
    [InlineData(Statuses.Reverted, "#64748b")]
    [InlineData(Statuses.Dismissed, "#9a9a9a")]
    public void Pins_use_the_boards_status_colours(string status, string hex) => Assert.Equal(hex, Ui.StatusHex(status));

    [Fact]
    public void The_accent_is_the_boards_teal()
    {
        Assert.Equal("#1F8A78", Ui.Accent.ToRgbaHex());
        Assert.Equal("#17181B", Ui.Bar.ToRgbaHex());
        Assert.Equal("#45BFA8", Ui.BarAccent.ToRgbaHex());
    }

    [Fact]
    public void Every_icon_is_valid_path_data()
    {
        List<(string Name, string Data)> icons = [.. typeof(Ui).GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Where(f => f.Name.StartsWith("Icon", StringComparison.Ordinal) && f.FieldType == typeof(string))
            .Select(f => (f.Name, Data: (string)f.GetValue(null)!))];
        Assert.True(icons.Count >= 14);
        foreach ((string? name, string? data) in icons)
        {
            PathGeometry? geometry = new PathGeometryConverter().ConvertFromInvariantString(data) as PathGeometry;
            Assert.True(geometry is { Figures.Count: > 0 }, name);
        }
    }

    [Fact]
    public void The_potato_ships_in_the_library_at_120px()
    {
        using Stream? stream = typeof(Ui).Assembly.GetManifestResourceStream("Notato.Maui.notato-potato.png");
        Assert.NotNull(stream);
        byte[] header = new byte[24];
        stream.ReadExactly(header);
        Assert.Equal([0x89, (byte)'P', (byte)'N', (byte)'G'], header[..4]);
        // IHDR: width and height, big-endian, at 16 and 20.
        Assert.Equal(120, (header[16] << 24) | (header[17] << 16) | (header[18] << 8) | header[19]);
        Assert.Equal(120, (header[20] << 24) | (header[21] << 16) | (header[22] << 8) | header[23]);
    }
}
