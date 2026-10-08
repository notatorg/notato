using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Overlay;

namespace Notato.Maui.Tests;

/// <summary>Which notes get a pin, and how pins find their elements again without walking the tree for each one.</summary>
public class PinTests
{
    private static NotatoController.Record Note(int n, string route = "/shop", string platform = "maui") =>
        new(Fixtures.Annotation() with
        {
            Id = $"N{n:000000}",
            Route = route,
            CreatedAt = $"2026-10-07T09:{n / 60 % 60:00}:{n % 60:00}.{n / 3600:000}Z",
            Environment = Fixtures.Annotation().Environment with { Platform = platform },
        });

    [Fact]
    public void Only_this_SDKs_notes_are_pinned_and_each_keeps_its_number_among_all_of_the_screens()
    {
        RecordSet records = [Note(1), Note(2, platform: "web"), Note(3), Note(4, route: "/cart")];

        Assert.Equal([(1, "N000001"), (2, "N000002"), (3, "N000003")], records.On("/shop").Select(x => (x.Number, x.Record.Annotation.Id)));
        // The web note is in the list, but a web selector means nothing here: no pin.
        Assert.Equal([(1, "N000001"), (3, "N000003")], records.PinnedOn("/shop").Select(x => (x.Number, x.Record.Annotation.Id)));
        Assert.Empty(records.PinnedOn("/nowhere"));
    }

    [Fact]
    public void A_screen_draws_at_most_150_pins_the_newest()
    {
        RecordSet records = [];
        // Added newest first, to show the order comes from when they were made.
        for (int n = 400; n >= 1; n--)
        {
            records.Add(Note(n));
        }

        IReadOnlyList<(int Number, NotatoController.Record Record)> pinned = records.PinnedOn("/shop");

        Assert.Equal(RecordSet.MaxPins, pinned.Count);
        Assert.Equal(150, RecordSet.MaxPins);
        Assert.Equal(251, pinned[0].Number);
        Assert.Equal("N000400", pinned[^1].Record.Annotation.Id);
        Assert.Equal(400, records.On("/shop").Count);
    }

    [Fact]
    public void A_screens_notes_are_worked_out_once_and_again_after_any_change()
    {
        RecordSet records = [];
        NotatoController.Record first = Note(1);
        records.Add(first);
        records.Add(Note(2));
        IReadOnlyList<(int, NotatoController.Record)> once = records.On("/shop");
        Assert.Same(once, records.On("/shop"));

        // A new copy of a note (from the server) can move it.
        first.Annotation = first.Annotation with { Route = "/cart" };
        Assert.Equal(["N000002"], records.On("/shop").Select(x => x.Record.Annotation.Id));
        Assert.Equal(["N000001"], records.On("/cart").Select(x => x.Record.Annotation.Id));

        records.Remove("N000002");
        Assert.Empty(records.On("/shop"));
        Assert.Null(records.Find("N000002"));
        Assert.Same(first, records.Find("N000001"));
    }

    [Fact]
    public void Several_selectors_are_found_in_one_walk_each_on_the_first_element_it_takes()
    {
        Label title = new() { Text = "Basket" };
        Button pay = new() { Text = "Pay", AutomationId = "Pay" };
        Entry email = new() { StyleId = "Email" };
        Label total = new() { Text = "£12" };
        LoginPage page = new() { Content = new VerticalStackLayout { Children = { title, email, total, pay } } };
        List<IReadOnlyList<Selectors.Step>> wanted =
        [
            Selectors.ParseCached("LoginPage Button#Pay"),
            Selectors.ParseCached("Entry[x:Name=Email]"),
            Selectors.ParseCached("LoginPage Label"),
            Selectors.ParseCached("Switch"),
            Selectors.ParseCached("*[x:Name=Email]"),
        ];
        // The first Label is turned down: the next one that matches is taken.
        Element?[] found = Selectors.QueryFirst(page, wanted, mask: true, (_, e) => !ReferenceEquals(e, title));

        Assert.Equal<Element?>([pay, email, total, null, email], found);
    }

    [Fact]
    public void Selectors_are_parsed_once_and_a_wrong_one_is_turned_down_each_time()
    {
        Assert.Same(Selectors.ParseCached("LoginPage Button#SignIn"), Selectors.ParseCached("LoginPage Button#SignIn"));
        FormatException first = Assert.Throws<FormatException>(() => Selectors.ParseCached("button[data-testid=\"pay\"]"));
        FormatException again = Assert.Throws<FormatException>(() => Selectors.ParseCached("button[data-testid=\"pay\"]"));
        Assert.Equal(first.Message, again.Message);
        Assert.Null(Selectors.TryParseCached("button[data-testid=\"pay\"]"));
    }

    [Fact]
    public void Typed_text_is_found_by_text_only_when_inputs_are_not_masked()
    {
        Entry email = new() { Text = "dom@example.com" };
        LoginPage page = new() { Content = new VerticalStackLayout { Children = { email, new Label { Text = "Sign in" } } } };

        Assert.Same(email, Assert.Single(Selectors.Query(page, "Entry:text(\"dom@\")", mask: false)));
        Assert.Empty(Selectors.Query(page, "Entry:text(\"dom@\")", mask: true));
        // Text people can see is still found either way.
        Assert.Single(Selectors.Query(page, "Label:text(\"sign\")", mask: true));
    }

    private sealed record Product(string Name);

    [Fact]
    public void A_pin_in_a_list_follows_its_item_and_not_a_recycled_row()
    {
        CollectionView list = new();
        Label row = new() { Text = "Wool scarf", BindingContext = new Product("Wool scarf"), Parent = list };
        ElementIdentity identity = new() { Selector = "CollectionView Label", Tag = "Label", Text = "Wool scarf" };
        PinTarget target = new(row);
        Assert.True(target.InList);
        Assert.True(target.StillShows(row, identity, mask: true));

        // Scrolled: the row is reused for another item.
        row.BindingContext = new Product("Rain jacket");
        row.Text = "Rain jacket";
        Assert.False(target.StillShows(row, identity, mask: true));

        // Bound again to an item that reads the same: still the note's.
        row.Text = "Wool scarf";
        Assert.True(target.StillShows(row, identity, mask: true));

        // Outside a list an element is never reused, so it is not checked.
        Label heading = new() { Text = "Changed since", BindingContext = new Product("x") };
        PinTarget plain = new(heading);
        heading.BindingContext = new Product("y");
        Assert.False(plain.InList);
        Assert.True(plain.StillShows(heading, identity, mask: true));
    }

    [Fact]
    public void Pins_that_did_not_move_or_change_are_left_alone()
    {
        NotatoOverlay overlay = new(Fixtures.Controller(), new OverlaySession(null!, null!));
        Notato.Maui.Native.OverlayHosts.ArrangeRoot(overlay, 402, 874);
        PinPlacement open = new("A", 1, Statuses.Open, new Rect(16, 200, 284, 40), Detached: false, Pending: false);
        overlay.ShowPins([open, open with { Id = "B", Number = 2, Rect = new Rect(16, 400, 284, 40) }]);
        Border pin = Pin(overlay, "Note 1, open");
        Rect at = AbsoluteLayout.GetLayoutBounds(pin);

        // Marked, to see whether the next look touches it.
        pin.Opacity = 0.2;
        overlay.ShowPins([open, open with { Id = "B", Number = 2, Rect = new Rect(16, 400, 284, 40) }]);
        Assert.Equal(0.2, pin.Opacity);

        // Scrolled: moved, not drawn again.
        overlay.ShowPins([open with { Rect = new Rect(16, 150, 284, 40) }, open with { Id = "B", Number = 2, Rect = new Rect(16, 400, 284, 40) }]);
        Assert.Equal(0.2, pin.Opacity);
        Assert.Equal(at.Y - 50, AbsoluteLayout.GetLayoutBounds(pin).Y);

        // Acknowledged: drawn again, the same view.
        overlay.ShowPins([open with { Status = Statuses.Acknowledged, Rect = new Rect(16, 150, 284, 40) }]);
        Assert.Same(pin, Pin(overlay, "Note 1, acknowledged"));
        Assert.Equal(1, pin.Opacity);
        Assert.DoesNotContain(VisualTree.Descendants(overlay), e => e is Border b && SemanticProperties.GetDescription(b) == "Note 2, open");
    }

    private static Border Pin(Element overlay, string description) =>
        VisualTree.Descendants(overlay).OfType<Border>().Single(b => SemanticProperties.GetDescription(b) == description);
}
