using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;

namespace Notato.Maui.Tests;

/// <summary>What a note must never carry: passwords, private elements and, with MaskInputs, what is typed.</summary>
public class PrivacyTests
{
    private static T Masked<T>(T element, bool? mask) where T : BindableObject
    {
        Feedback.SetMask(element, mask);
        return element;
    }

    [Fact]
    public void A_private_element_has_no_text_and_no_name()
    {
        Label balance = Masked(new Label { Text = "£1,204.50" }, true);
        SemanticProperties.SetDescription(balance, "Balance £1,204.50");
        Assert.Null(ElementText.Of(balance, mask: false));
        Assert.Null(ElementText.NameOf(balance));
        Assert.True(Privacy.Hidden(balance, maskInputs: false));
    }

    [Fact]
    public void Nothing_inside_a_private_container_is_read_but_its_neighbours_are()
    {
        Label name = new() { Text = "Ada Lovelace" };
        Label address = new() { Text = "12 Analytical Row" };
        VerticalStackLayout customer = Masked(new VerticalStackLayout { Children = { name, address } }, true);
        Label heading = new() { Text = "Visit" };
        Border card = new() { Content = new VerticalStackLayout { Children = { heading, customer } } };

        Assert.Null(ElementText.Visible(customer, mask: false));
        Assert.Null(ElementText.Of(address, mask: false));
        Assert.Equal("Visit", ElementText.Visible(card, mask: false));
        Assert.True(Privacy.Hidden(name, maskInputs: false));
        Assert.False(Privacy.Hidden(heading, maskInputs: false));
    }

    [Fact]
    public void An_input_can_opt_out_of_MaskInputs_but_a_password_never_can()
    {
        Entry search = Masked(new Entry { Text = "smoke detector" }, false);
        Assert.Equal("smoke detector", ElementText.Of(search, mask: true));
        Assert.False(Privacy.Hidden(search, maskInputs: true));

        Assert.Null(ElementText.Of(new Entry { Text = "dom@example.com" }, mask: true));
        Assert.True(Privacy.Hidden(new Editor { Text = "notes" }, maskInputs: true));

        Entry password = Masked(new Entry { Text = "hunter2", IsPassword = true }, false);
        Assert.Null(ElementText.Of(password, mask: false));
        // Covered in dev mode too: a password box is never in a screenshot.
        Assert.True(Privacy.Hidden(password, maskInputs: false));
    }

    [Fact]
    public void A_private_container_wins_over_an_input_inside_it_that_opts_out()
    {
        Entry search = Masked(new Entry { Text = "Ada" }, false);
        Masked(new VerticalStackLayout { Children = { search } }, true);
        Assert.Null(ElementText.Of(search, mask: false));
        Assert.True(Privacy.Hidden(search, maskInputs: false));
    }

    /// <summary>Where elements are, as a host would say: anything not listed is not on screen.</summary>
    private sealed class Geometry(Dictionary<VisualElement, Rect> where) : IElementGeometry
    {
        public Rect? BoundsOf(VisualElement element) => where.TryGetValue(element, out Rect r) ? r : null;

        public Rect? VisibleBoundsOf(VisualElement element) => BoundsOf(element);
    }

    private static readonly Rect Screen = new(0, 0, 402, 874);

    [Fact]
    public void Screenshots_are_covered_on_the_page_under_a_sheet_too()
    {
        Entry password = new() { IsPassword = true };
        LoginPage login = new() { BackgroundColor = Colors.White, Content = new VerticalStackLayout { Children = { password } } };
        Label balance = Masked(new Label { Text = "£1,204.50" }, true);
        // A sheet that leaves the top of the page under it in view, as iOS's page sheet does.
        LoginPage sheet = new() { BackgroundColor = Colors.White, Content = new VerticalStackLayout { Children = { balance } } };
        Geometry geometry = new(new()
        {
            [login] = Screen,
            [password] = new Rect(16, 20, 370, 40),
            [sheet] = new Rect(0, 60, 402, 814),
            [balance] = new Rect(16, 120, 200, 20),
        });

        List<Rect> masks = Privacy.MaskRects([sheet, login], geometry, maskInputs: false);

        Assert.Equal([new Rect(16, 120, 200, 20), new Rect(16, 20, 370, 40)], masks);
    }

    [Fact]
    public void Under_an_opaque_page_what_cannot_be_seen_is_left_alone_but_part_of_it_is_still_covered()
    {
        Entry hidden = new() { IsPassword = true };
        Entry straddling = new() { IsPassword = true };
        LoginPage login = new() { Content = new VerticalStackLayout { Children = { hidden, straddling } } };
        LoginPage sheet = new() { Background = new SolidColorBrush(Colors.White), Content = new Label { Text = "Sheet" } };
        Geometry geometry = new(new()
        {
            [login] = Screen,
            [hidden] = new Rect(16, 300, 370, 40),
            [straddling] = new Rect(16, 40, 370, 40),
            [sheet] = new Rect(0, 60, 402, 814),
        });

        Assert.Equal([new Rect(16, 40, 370, 40)], Privacy.MaskRects([sheet, login], geometry, maskInputs: false));
    }

    [Fact]
    public void Under_a_see_through_modal_everything_is_covered()
    {
        Entry password = new() { IsPassword = true };
        LoginPage login = new() { Content = new VerticalStackLayout { Children = { password } } };
        LoginPage overlay = new() { BackgroundColor = Color.FromRgba(0, 0, 0, 0.4), Content = new Label { Text = "Loading" } };
        LoginPage unset = new() { Content = new Label { Text = "Unset background" } };
        Geometry geometry = new(new()
        {
            [login] = Screen,
            [password] = new Rect(16, 300, 370, 40),
            [overlay] = Screen,
            [unset] = Screen,
        });

        Assert.Single(Privacy.MaskRects([overlay, login], geometry, maskInputs: false));
        // A page that does not say what its background is might be clear.
        Assert.Single(Privacy.MaskRects([unset, login], geometry, maskInputs: false));
    }

    [Fact]
    public void An_agent_cannot_find_a_private_element_by_its_text()
    {
        Label balance = Masked(new Label { Text = "£1,204.50", AutomationId = "Balance" }, true);
        LoginPage page = new() { Content = new VerticalStackLayout { Children = { new Label { Text = "£9.99" }, balance } } };
        Assert.Empty(Selectors.Query(page, "Label:text(\"1,204\")"));
        Assert.Single(Selectors.Query(page, "#Balance"));
    }
}
