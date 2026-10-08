using Notato.Maui.Inspection;
using Notato.Maui.Model;
using System.Text.Json;

namespace Notato.Maui.Tests;

/// <summary>@ mentions call the server's plugins, such as @jira. None is built in: the agent gets everything without one.</summary>
public class MentionTests
{
    [Fact]
    public void Finds_mentions_as_the_server_does()
    {
        Assert.Equal(["design", "jira", "qa-team"], Mentions.In("@Design and @jira, then @design again (@qa-team)"));
        Assert.Empty(Mentions.In("mail me@jira.dev or @@jira"));
        Assert.True(Mentions.Has("Hey @Jira, file this?", "jira"));
    }

    [Fact]
    public void A_chip_puts_the_mention_first_or_takes_it_out()
    {
        Assert.Equal("@jira why is this blue?", Mentions.Toggle("why is this blue?", "jira"));
        Assert.Equal("@jira ", Mentions.Toggle("", "jira"));
        Assert.Equal("why is this blue?", Mentions.Toggle("@jira why is this blue?", "jira"));
        Assert.Equal("Thanks, can you file this?", Mentions.Toggle("Thanks @Jira, can you file this?", "jira"));
        Assert.Equal("file this", Mentions.Toggle("@jira: file this", "jira"));
        Assert.Equal("ping me@jira.dev", Mentions.Toggle("@jira ping me@jira.dev", "jira"));
    }

    [Fact]
    public void Reads_what_the_server_offers()
    {
        const string json = """{"screenshots":true,"agent":{"connected":true,"sessions":1,"watching":false},"mentions":[{"name":"jira","description":"File it in Jira","available":true}]}""";
        ServerConfig config = JsonSerializer.Deserialize(json, NotatoJsonContext.Default.ServerConfig)!;
        Assert.True(config.Agent!.Connected);
        Assert.Equal(new MentionInfo { Name = "jira", Description = "File it in Jira", Available = true }, config.Mentions!.Single());
        // The server's default: an agent is there, and nothing to mention.
        ServerConfig plain = JsonSerializer.Deserialize("""{"screenshots":true,"agent":{"connected":true,"sessions":1,"watching":true},"mentions":[]}""", NotatoJsonContext.Default.ServerConfig)!;
        Assert.True(plain.Agent!.Watching);
        Assert.Empty(plain.Mentions!);
        // An older server says nothing about either.
        ServerConfig old = JsonSerializer.Deserialize("""{"screenshots":false}""", NotatoJsonContext.Default.ServerConfig)!;
        Assert.Null(old.Mentions);
        Assert.Null(old.Agent);
    }
}
