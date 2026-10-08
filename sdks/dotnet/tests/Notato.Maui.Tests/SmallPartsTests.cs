using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Runtime;
using Notato.Maui.Util;

namespace Notato.Maui.Tests;

/// <summary>Ids, routes, the log, element text and styles, and XAML paths.</summary>
public class SmallPartsTests
{
    [Fact]
    public void Ulids_are_26_crockford_characters_and_sort_by_time()
    {
        string earlier = Ulid.New(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
        string later = Ulid.New(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_001));
        Assert.Equal(26, earlier.Length);
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{26}$", earlier);
        Assert.True(string.CompareOrdinal(earlier, later) < 0);
        Assert.NotEqual(Ulid.New(), Ulid.New());
    }

    [Theory]
    [InlineData("D_FAULT_CheckoutPage10", "CheckoutPage")]
    [InlineData("IMPL_MainPage", "MainPage")]
    [InlineData("shop", "shop")]
    public void Generated_shell_route_names_become_page_names(string segment, string expected) =>
        Assert.Equal(expected, AppContextInfo.CleanShellSegment(segment));

    [Theory]
    [InlineData("Notato.Maui.NotatoController", true)]
    [InlineData("Notato.Maui.Native.AppleOverlayHost", true)]
    [InlineData("Notato.Maui.Sample.Views.AccountPage", false)]
    [InlineData("MyApp.LoginViewModel", false)]
    public void Only_Notatos_own_log_categories_are_left_out(string category, bool own) =>
        Assert.Equal(own, LogRecorder.IsNotatos(category));

    [Fact]
    public void The_log_keeps_the_newest_messages()
    {
        Ring<int> ring = new(3);
        for (int i = 0; i < 5; i++)
        {
            ring.Add(i);
        }

        Assert.Equal([2, 3, 4], ring.Snapshot());
    }

    [Fact]
    public void Containers_read_as_the_text_inside_them_and_passwords_are_never_read()
    {
        Border banner = new() { Content = new HorizontalStackLayout { Children = { new Label { Text = "Autumn sale:" }, new Label { Text = "20% off" } } } };
        Assert.Equal("Autumn sale: 20% off", ElementText.Visible(banner, mask: false));
        Assert.Null(ElementText.Of(new Entry { Text = "hunter2", IsPassword = true }, mask: false));
        Assert.Null(ElementText.Of(new Entry { Text = "dom@example.com" }, mask: true));
        Assert.Equal("dom@example.com", ElementText.Of(new Entry { Text = "dom@example.com" }, mask: false));
        Assert.Equal("button", ElementText.RoleOf(new Button()));
        Assert.Equal("heading", ElementText.RoleOf(new Label { Text = "Title" }.Also(l => SemanticProperties.SetHeadingLevel(l, SemanticHeadingLevel.Level1))));
    }

    [Fact]
    public void Styles_list_what_was_chosen_and_leave_defaults_out()
    {
        Label label = new() { TextColor = Color.FromArgb("#2563eb"), FontSize = 18, FontAttributes = FontAttributes.Bold, HorizontalTextAlignment = TextAlignment.End, Margin = new Thickness(4, 8) };
        IReadOnlyDictionary<string, string> styles = ElementInspector.StylesOf(label);
        Assert.Equal("#2563eb", styles["color"]);
        Assert.Equal("18", styles["font-size"]);
        Assert.Equal("700", styles["font-weight"]);
        Assert.Equal("end", styles["text-align"]);
        Assert.Equal("8 4", styles["margin"]);
        Assert.False(styles.ContainsKey("opacity"));
        Assert.False(styles.ContainsKey("background"));
    }

    [Fact]
    public void Xaml_paths_are_given_from_the_repository_root()
    {
        SourceLocator locator = new("src/MyApp");
        Assert.Equal("src/MyApp/Views/LoginPage.xaml", locator.FromRepositoryRoot("Views/LoginPage.xaml", null));
        Assert.Equal("src/MyApp/Views/LoginPage.xaml", locator.FromRepositoryRoot("Views\\LoginPage.xaml", null));
    }
}
