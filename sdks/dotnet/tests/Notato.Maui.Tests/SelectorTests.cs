using Microsoft.Maui.Controls;
using Notato.Maui.Inspection;
using Notato.Maui.Model;

namespace Notato.Maui.Tests;

public sealed class LoginPage : ContentPage;

public sealed class Card : ContentView;

public class SelectorTests
{
    private readonly LoginPage _page;
    private readonly Button _signIn;
    private readonly Button _forgot;
    private readonly Entry _email;
    private readonly Label _secondTitle;
    private readonly List<Card> _cards = [];

    public SelectorTests()
    {
        _signIn = new Button { Text = "Sign in", AutomationId = "SignIn" };
        _forgot = new Button { Text = "Forgot password?" };
        _email = new Entry { Placeholder = "you@example.com", StyleId = "Email" };
        _secondTitle = new Label { Text = "Second" };
        VerticalStackLayout form = new() { AutomationId = "Form", Children = { new Label { Text = "First" }, _secondTitle, _email, _signIn, _forgot } };
        VerticalStackLayout list = [];
        for (int i = 0; i < 3; i++)
        {
            Card card = new() { Content = new Label { Text = $"Card {i}" } };
            _cards.Add(card);
            list.Children.Add(card);
        }
        _page = new LoginPage { Content = new Grid { Children = { form, list } } };
    }

    [Fact]
    public void An_AutomationId_makes_the_shortest_selector()
    {
        Assert.Equal("LoginPage Button#SignIn", Selectors.For(_signIn));
    }

    [Fact]
    public void An_x_Name_is_used_when_there_is_no_AutomationId()
    {
        Assert.Equal("LoginPage Entry[x:Name=Email]", Selectors.For(_email));
    }

    [Fact]
    public void Siblings_of_the_same_type_are_told_apart_by_position()
    {
        string selector = Selectors.For(_forgot);
        Assert.Equal(_forgot, Assert.Single(Selectors.Query(_page, selector)));
        Assert.Contains(":nth-of-type(2)", selector);
    }

    [Fact]
    public void Every_generated_selector_finds_exactly_its_element()
    {
        foreach (Element? element in VisualTree.Descendants(_page).Skip(1))
        {
            string selector = Selectors.For(element);
            List<Element> found = [.. Selectors.Query(_page, selector)];
            Assert.True(found.Count == 1 && ReferenceEquals(found[0], element), $"{selector} found {found.Count}");
        }
    }

    [Theory]
    [InlineData("#SignIn")]
    [InlineData("Button#SignIn")]
    [InlineData("[AutomationId=SignIn]")]
    [InlineData("[AutomationId=\"SignIn\"]")]
    [InlineData("Button:text(\"sign IN\")")]
    [InlineData("Button:has-text('Sign')")]
    [InlineData("LoginPage VerticalStackLayout#Form > Button:nth-of-type(1)")]
    [InlineData("LoginPage > Grid > VerticalStackLayout > Button#SignIn")]
    public void Agents_can_find_an_element_several_ways(string selector)
    {
        Assert.Same(_signIn, Selectors.Query(_page, selector).First());
    }

    [Fact]
    public void A_child_combinator_does_not_reach_grandchildren()
    {
        Assert.Empty(Selectors.Query(_page, "LoginPage > Button"));
        Assert.NotEmpty(Selectors.Query(_page, "LoginPage Button"));
    }

    [Theory]
    [InlineData("> Button")]
    [InlineData("Button >")]
    [InlineData("Button[Text=Sign in]")]
    [InlineData("Button:hover(1)")]
    [InlineData("Button:text(\"unclosed)")]
    public void Bad_selectors_say_what_is_wrong(string selector)
    {
        FormatException error = Assert.Throws<FormatException>(() => Selectors.Query(_page, selector).ToList());
        Assert.Contains(selector.Trim(), error.Message);
    }

    public static TheoryData<string> TrickyNames =>
    [
        "Login__Button", "Save_", "btn-", "_private", "a-.b", "item-1", "Form.Email", "com.app.Login", "a.", "a..b", "a._b",
        "-x", "1st", "with space", " padded ", "quote\"d", "back\\slash", "brack]et", "par(en)", "a#b", "a>b", "a:b", "a,b",
        "über", "日本語", "emoji😀", "x:Name=y",
    ];

    [Theory]
    [MemberData(nameof(TrickyNames))]
    public void Any_AutomationId_the_writer_writes_reads_back_to_the_same_element(string id)
    {
        Button target = new() { Text = "Go", AutomationId = id };
        LoginPage page = new() { Content = new VerticalStackLayout { Children = { new Button { Text = "Other", AutomationId = "Other" }, target } } };

        string selector = Selectors.For(target);

        Assert.Same(target, Assert.Single(Selectors.Query(page, selector)));
    }

    [Theory]
    [MemberData(nameof(TrickyNames))]
    public void Any_x_Name_the_writer_writes_reads_back_to_the_same_element(string name)
    {
        Entry target = new() { StyleId = name };
        LoginPage page = new() { Content = new VerticalStackLayout { Children = { new Entry { StyleId = "Other" }, target } } };

        string selector = Selectors.For(target);

        Assert.Same(target, Assert.Single(Selectors.Query(page, selector)));
    }

    [Theory]
    [InlineData("#Login__Button", "Login__Button")]
    [InlineData("Button#Save_", "Save_")]
    [InlineData("Button#btn- > Label", "btn-")]
    [InlineData("#Form.Email", "Form.Email")]
    public void Ids_with_doubled_or_trailing_underscores_and_dashes_parse(string selector, string id)
    {
        Assert.Equal(id, Selectors.Parse(selector)[0].Compound.Id);
    }

    [Fact]
    public void Ancestors_and_component_path_are_outermost_first()
    {
        Label inner = (Label)_cards[1].Content;
        Assert.Equal(["LoginPage", "Grid", "VerticalStackLayout", "Card"], ElementInspector.AncestorsOf(inner));
        ComponentInfo component = new ElementInspector(new SourceLocator(null)).ComponentOf(inner)!;
        Assert.Equal("Card", component.Name);
        Assert.Equal(["LoginPage", "Card"], component.Path);
    }
}
