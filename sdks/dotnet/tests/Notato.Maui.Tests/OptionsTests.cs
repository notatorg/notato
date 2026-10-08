using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Notato.Maui.Tests;

/// <summary>Binding the options from configuration and code, and what is wrong with them.</summary>
public class OptionsTests
{
    private static NotatoOptions Bind(Dictionary<string, string?> values, Action<NotatoOptions>? configure = null)
    {
        IConfigurationRoot configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        IServiceCollection services = new ServiceCollection().AddLogging();
        services.AddNotato(configuration.GetSection(NotatoOptions.SectionName), configure);
        return services.BuildServiceProvider().GetRequiredService<IOptions<NotatoOptions>>().Value;
    }

    [Fact]
    public void The_Notato_section_binds_and_code_adjusts_it()
    {
        NotatoOptions options = Bind(new()
        {
            ["Notato:Project"] = "checkout-app",
            ["Notato:Mode"] = "agent",
            ["Notato:Server"] = "https://notato.example.com/",
            ["Notato:Enabled"] = "false",
            ["Notato:ToolbarPosition"] = "TopLeft",
            ["Notato:MaskInputs"] = "false",
        }, o => o.Author = "Dom");
        Assert.Equal("checkout-app", options.Project);
        Assert.Equal(NotatoMode.Agent, options.Mode);
        Assert.False(options.Enabled);
        Assert.Equal(ToolbarCorner.TopLeft, options.ToolbarPosition);
        Assert.Equal("https://notato.example.com", options.ResolvedServer);
        Assert.False(options.ResolvedMaskInputs);
        Assert.Equal("Dom", options.Author);
    }

    [Fact]
    public void Defaults_suit_dev_mode()
    {
        NotatoOptions options = Bind(new() { ["Notato:Project"] = "app" });
        Assert.True(options.Enabled);
        Assert.Equal(NotatoOptions.DefaultServer, options.ResolvedServer);
        Assert.False(options.ResolvedMaskInputs);
        Assert.Null(NotatoController.Validate(options));
    }

    [Fact]
    public void Test_mode_has_no_server_unless_given_one_and_masks_inputs()
    {
        NotatoOptions options = Bind(new() { ["Notato:Project"] = "app", ["Notato:Mode"] = "Test" });
        Assert.Null(options.ResolvedServer);
        Assert.True(options.ResolvedMaskInputs);
    }

    [Theory]
    [InlineData("", null, "needs a project id")]
    [InlineData("has spaces", null, "may only use")]
    [InlineData("café", null, "may only use")]
    [InlineData("..", null, "not only dots")]
    [InlineData(".", null, "not only dots")]
    [InlineData("app", "ftp://x", "not an http(s) URL")]
    public void Bad_options_are_explained(string project, string? server, string expected)
    {
        string? problem = NotatoController.Validate(new NotatoOptions { Project = project, Server = server });
        Assert.Contains(expected, problem);
    }
}
