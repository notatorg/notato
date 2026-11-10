using Microsoft.Maui.Controls;
using Notato.Maui.Inspection;
using Notato.Maui.Overlay;

namespace Notato.Maui.Tests;

/// <summary>
/// The note being written, laid out as the web composer is: type chips, the comment, severity chips, then one
/// button saying who will see the note, which opens the two switches that decide it.
/// </summary>
public class ComposerTests
{
    private static IEnumerable<Element> All(Element root) => VisualTree.Descendants(root).Prepend(root);

    private static T Find<T>(Element root, string automationId) where T : VisualElement =>
        All(root).OfType<T>().Single(e => e.AutomationId == automationId);

    private static ComposerCard Composer(bool sharedByDefault = false) =>
        new("Border#PromoBanner", "“Autumn sale”", screenshotsOff: false, () => { }, () => { }, (_, _, _, _, _) => Task.FromResult<string?>(null), sharedByDefault);

    private static void Tap(View view)
    {
        TapGestureRecognizer tap = view.GestureRecognizers.OfType<TapGestureRecognizer>().Single();
        typeof(TapGestureRecognizer).GetMethod("SendTapped", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .Invoke(tap, [view, null]);
    }

    /// <summary>Whether <paramref name="view"/> is on screen: it and everything around it in the card are visible.</summary>
    private static bool Shown(Element view, Element card)
    {
        for (Element? at = view; at is not null && at != card; at = at.Parent)
        {
            if (at is VisualElement { IsVisible: false })
            {
                return false;
            }
        }

        return true;
    }

    [Theory]
    [InlineData(false, false, "You and your agent")]
    [InlineData(true, false, "Shared with project")]
    [InlineData(false, true, "Only you")]
    [InlineData(true, true, "Project, not agent")]
    public void The_visibility_button_says_who_will_see_the_note_and_follows_the_switches(bool shared, bool hidden, string label)
    {
        Assert.Equal(label, ComposerCard.VisibilityLabel(shared, hidden));

        ComposerCard card = Composer();
        Find<Switch>(card, "NotatoShared").IsToggled = shared;
        Find<Switch>(card, "NotatoPeopleOnly").IsToggled = hidden;

        Border button = Find<Border>(card, "NotatoVisibility");
        Assert.Contains(All(button).OfType<Label>(), l => l.Text == label);
        Assert.Equal("Visibility: " + label, SemanticProperties.GetDescription(button));
    }

    [Fact]
    public void The_switches_start_hidden_and_the_button_opens_and_closes_them()
    {
        ComposerCard card = Composer();
        Border button = Find<Border>(card, "NotatoVisibility");
        Switch shared = Find<Switch>(card, "NotatoShared");
        Switch hidden = Find<Switch>(card, "NotatoPeopleOnly");

        Assert.False(card.VisibilityOpen);
        Assert.False(Shown(shared, card));
        Assert.False(Shown(hidden, card));
        Assert.Equal("Collapsed", SemanticProperties.GetHint(button));

        Tap(button);

        Assert.True(card.VisibilityOpen);
        Assert.True(Shown(shared, card));
        Assert.True(Shown(hidden, card));
        Assert.Equal("Expanded", SemanticProperties.GetHint(button));
        // The switches sit directly under the button.
        VerticalStackLayout group = (VerticalStackLayout)button.Parent;
        Assert.Same(button, group.Children[0]);
        Assert.Contains(shared, All((Element)group.Children[1]));
        Assert.Contains(hidden, All((Element)group.Children[1]));

        Tap(button);

        Assert.False(card.VisibilityOpen);
        Assert.False(Shown(shared, card));
    }

    [Fact]
    public void The_label_changes_live_while_open_and_a_new_composer_starts_closed_with_tests_default()
    {
        ComposerCard card = Composer();
        Border button = Find<Border>(card, "NotatoVisibility");
        Tap(button);
        Find<Switch>(card, "NotatoShared").IsToggled = true;
        Assert.Equal("Visibility: Shared with project", SemanticProperties.GetDescription(button));
        Find<Switch>(card, "NotatoPeopleOnly").IsToggled = true;
        Assert.Equal("Visibility: Project, not agent", SemanticProperties.GetDescription(button));

        // Test mode starts shared; the composer still opens closed.
        ComposerCard next = Composer(sharedByDefault: true);
        Assert.False(next.VisibilityOpen);
        Assert.Equal("Visibility: Shared with project", SemanticProperties.GetDescription(Find<Border>(next, "NotatoVisibility")));
    }

    [Fact]
    public void Type_chips_come_before_the_comment_and_severity_after_with_no_headings()
    {
        ComposerCard card = Composer();
        List<Element> order = [.. All(card)];
        ChipRow[] rows = [.. order.OfType<ChipRow>()];
        Assert.Equal(["Feedback type", "Severity"], rows.Select(r => r.Group));
        int comment = order.IndexOf(Find<Editor>(card, "NotatoComment"));
        int mentions = order.IndexOf(order.OfType<MentionRow>().Single());
        Assert.True(order.IndexOf(rows[0]) < comment);
        Assert.True(comment < mentions && mentions < order.IndexOf(rows[1]));
        Assert.True(order.IndexOf(rows[1]) < order.IndexOf(Find<Border>(card, "NotatoVisibility")));

        // The group names are for screen readers only.
        string[] words = [.. All(card).OfType<Label>().Select(l => l.Text ?? "")];
        Assert.DoesNotContain("Feedback type", words);
        Assert.DoesNotContain("Severity", words);
        Assert.DoesNotContain("Visibility", words);
        Assert.All(All(rows[1]).OfType<Border>(), chip => Assert.Equal("Severity", SemanticProperties.GetHint(chip)));
    }
}
