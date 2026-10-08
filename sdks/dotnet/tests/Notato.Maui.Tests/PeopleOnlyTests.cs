using Microsoft.Extensions.DependencyInjection;
using Microsoft.Maui.Controls;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Notato.Maui.Tests;

/// <summary>
/// Everything people write reaches the agent unless they keep it from it: People only on a note, Aside on a reply.
/// </summary>
public class PeopleOnlyTests
{
    private const string Id = "01M46YHJA6PBM210JB4H2WMY14";
    private const string At = "2026-10-07T09:00:00.000Z";

    // ---- turning People only on and off with no server ---------------------------------------------------------

    [Fact]
    public void Turned_on_offline_the_note_says_so_and_the_thread_records_it_as_the_server_would()
    {
        Annotation on = PeopleOnlyToggle.Set(Fixtures.Annotation(), true, Author.Human("Dom"), "01M46YHK00ON00000000000001", At);

        Assert.True(on.PeopleOnly);
        Reply entry = Assert.Single(on.Thread);
        Assert.Equal(new Reply
        {
            Id = "01M46YHK00ON00000000000001",
            Author = Author.Human("Dom"),
            Body = "Made this people only: the agent won't see it.",
            CreatedAt = At,
            Automatic = true,
            PeopleOnly = true,
        }, entry);
        Assert.True(JsonNode.DeepEquals(
            JsonNode.Parse("""{"id":"01M46YHK00ON00000000000001","author":{"kind":"human","name":"Dom"},"body":"Made this people only: the agent won't see it.","createdAt":"2026-10-07T09:00:00.000Z","automatic":true,"peopleOnly":true}"""),
            JsonNode.Parse(JsonSerializer.Serialize(entry, NotatoJsonContext.Default.Reply))));
    }

    [Fact]
    public void Turned_off_offline_the_key_goes_and_the_entry_says_false()
    {
        Annotation on = PeopleOnlyToggle.Set(Fixtures.Annotation(), true, Author.Human("Dom"), "01M46YHK00ON00000000000001", At);
        Annotation off = PeopleOnlyToggle.Set(on, false, Author.Human(null), "01M46YHK00OFF0000000000002", At);

        Assert.Null(off.PeopleOnly);
        Assert.False(JsonNode.Parse(JsonSerializer.Serialize(off, NotatoJsonContext.Default.Annotation))!.AsObject().ContainsKey("peopleOnly"));
        Assert.Equal(2, off.Thread.Count);
        Reply entry = off.Thread[1];
        Assert.Equal((true, false, "Shared this with the agent."), (entry.Automatic, entry.PeopleOnly, entry.Body));
        // No name set: the person is still a person.
        Assert.Equal("""{"kind":"human"}""", JsonSerializer.Serialize(entry.Author, NotatoJsonContext.Default.Author));
    }

    [Fact]
    public void A_change_made_here_after_the_server_took_the_first_copy_is_made_again_and_nothing_else_is()
    {
        Annotation first = Fixtures.Annotation();
        Annotation on = PeopleOnlyToggle.Set(first, true, Author.Human("Sam"), "01M46YHK00ON00000000000001", At);

        // The server has the first copy only: the change made here goes again, as Sam.
        Assert.Equal((true, Author.Human("Sam")), PeopleOnlyToggle.ToReplay(on, first));
        // On and off again here: the same as the server's.
        Assert.Null(PeopleOnlyToggle.ToReplay(PeopleOnlyToggle.Set(on, false, Author.Human("Sam"), "01M46YHK00OFF0000000000002", At), first));
        // Made People only when it was written: nothing to make again.
        Assert.Null(PeopleOnlyToggle.ToReplay(first with { PeopleOnly = true }, first with { PeopleOnly = true }));
        // The server has this change already, and someone turned it off on the board since: the board's word stands.
        Annotation offOnTheBoard = PeopleOnlyToggle.Set(on, false, Author.Human("Dom"), "01M46YHK00OFF0000000000003", At);
        Assert.Null(PeopleOnlyToggle.ToReplay(on, offOnTheBoard));
    }

    [Fact]
    public void Nothing_is_recorded_when_nothing_changes()
    {
        Annotation note = Fixtures.Annotation();
        Assert.Same(note, PeopleOnlyToggle.Set(note, false, Author.Human("Dom"), "x", At));
        Annotation kept = Fixtures.PeopleOnlyAnnotation();
        Assert.Same(kept, PeopleOnlyToggle.Set(kept, true, Author.Human("Dom"), "x", At));
    }

    private static NotatoController Controller(NotatoMode mode, string? server = null)
    {
        IServiceCollection services = new ServiceCollection().AddLogging();
        services.AddNotato(configure: o =>
        {
            o.Project = "maui-sample";
            o.Mode = mode;
            o.Author = "Dom";
            o.Server = server;
            o.RememberRuntimeState = false;
        });
        return services.BuildServiceProvider().GetRequiredService<NotatoController>();
    }

    private static RecordSet Records(NotatoController controller) => controller.Records;

    [Fact]
    public async Task In_test_mode_the_note_on_the_device_changes_with_the_person_as_its_author()
    {
        NotatoController controller = Controller(NotatoMode.Test);
        Records(controller).Add(new NoteRecord(Fixtures.Annotation()) { Pending = true, Mine = true });

        await controller.SetPeopleOnlyAsync(Id, true);

        Annotation note = Assert.Single(controller.Annotations);
        Assert.True(note.PeopleOnly);
        Reply on = Assert.Single(note.Thread);
        Assert.Equal(Author.Human("Dom"), on.Author);
        Assert.Equal((true, true, PeopleOnlyToggle.TurnedOn), (on.Automatic, on.PeopleOnly, on.Body));
        Assert.True(Records(controller).Single().Pending);

        await controller.SetPeopleOnlyAsync(Id, false);

        note = Assert.Single(controller.Annotations);
        Assert.Null(note.PeopleOnly);
        Assert.Equal([true, false], note.Thread.Select(r => r.PeopleOnly!.Value));
    }

    [Fact]
    public async Task A_note_not_sent_yet_changes_on_the_device_even_with_a_server()
    {
        // Never contacted: the note has not gone yet, so the change goes with it.
        NotatoController controller = Controller(NotatoMode.Dev, "http://127.0.0.1:9");
        Records(controller).Add(new NoteRecord(Fixtures.Annotation()) { Pending = true, Mine = true });

        await controller.SetPeopleOnlyAsync(Id, true);

        Assert.True(Assert.Single(controller.Annotations).PeopleOnly);
    }

    // ---- what goes to the server ----------------------------------------------------------------------------------

    private sealed class Recorder : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Url, string Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Seen.Add((request.Method, request.RequestUri!.ToString(), request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken)));
            string stored = JsonSerializer.Serialize(new StoredAnnotation { Annotation = Fixtures.PeopleOnlyAnnotation(), Seq = 3 }, NotatoJsonContext.Default.StoredAnnotation);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(stored, Encoding.UTF8, "application/json") };
        }
    }

    [Fact]
    public async Task Turning_it_on_or_off_patches_the_note_as_the_person()
    {
        Recorder handler = new();
        NotatoClient client = new(new HttpClient(handler), "http://localhost:4791", null);

        StoredAnnotation stored = await client.SetPeopleOnlyAsync(Id, true, Author.Human("Dom"));
        await client.SetPeopleOnlyAsync(Id, false, Author.Human(null));

        Assert.True(stored.Annotation.PeopleOnly);
        Assert.Equal(
        [
            (HttpMethod.Patch, $"http://localhost:4791/annotations/{Id}", """{"peopleOnly":true,"author":{"kind":"human","name":"Dom"}}"""),
            (HttpMethod.Patch, $"http://localhost:4791/annotations/{Id}", """{"peopleOnly":false,"author":{"kind":"human"}}"""),
        ], handler.Seen);
    }

    [Fact]
    public async Task An_aside_is_sent_as_one_and_an_ordinary_reply_says_nothing_about_it()
    {
        Recorder handler = new();
        NotatoClient client = new(new HttpClient(handler), "http://localhost:4791", null);

        await client.ReplyAsync(Id, "Sam, ignore the agent for a sec.", Author.Human("Dom"), aside: true);
        await client.ReplyAsync(Id, "Thanks!", Author.Human("Dom"));
        await client.ReplyAsync(Id, "Thanks again!", Author.Human("Dom"), aside: false);

        Assert.All(handler.Seen, s => Assert.Equal((HttpMethod.Post, $"http://localhost:4791/annotations/{Id}/replies"), (s.Method, s.Url)));
        Assert.Equal(
        [
            """{"body":"Sam, ignore the agent for a sec.","author":{"kind":"human","name":"Dom"},"aside":true}""",
            """{"body":"Thanks!","author":{"kind":"human","name":"Dom"}}""",
            """{"body":"Thanks again!","author":{"kind":"human","name":"Dom"}}""",
        ], handler.Seen.Select(s => s.Body));
    }

    [Fact]
    public void Reads_people_only_and_asides_from_the_server()
    {
        const string json = """
            {"seq":4,"annotation":{"id":"A1","projectId":"p","bundleId":null,"author":{"kind":"human"},"mode":"dev","createdAt":"2026-10-07T09:00:00.000Z",
            "url":"maui://x/","route":"/","environment":{"userAgent":"x","viewport":{"w":1,"h":1},"dpr":1,"platform":"maui"},
            "target":{"kind":"element","identity":[{"selector":"Button","tag":"Button"}],"rect":{"x":0,"y":0,"w":1,"h":1}},
            "comment":"c","context":{},"status":"open","peopleOnly":true,
            "thread":[{"id":"R1","author":{"kind":"human","name":"Sam"},"body":"Made this people only: the agent won't see it.","createdAt":"2026-10-07T09:01:00.000Z","automatic":true,"peopleOnly":true},
                      {"id":"R2","author":{"kind":"human","name":"Dom"},"body":"Between us","createdAt":"2026-10-07T09:02:00.000Z","aside":true}]}}
            """;
        Annotation note = JsonSerializer.Deserialize(json, NotatoJsonContext.Default.StoredAnnotation)!.Annotation;
        Assert.True(PeopleOnlyToggle.IsOn(note));
        Assert.Equal((true, true, null), (note.Thread[0].Automatic, note.Thread[0].PeopleOnly, note.Thread[0].Aside));
        Assert.Equal((null, null, true), (note.Thread[1].Automatic, note.Thread[1].PeopleOnly, note.Thread[1].Aside));
    }

    [Fact]
    public async Task An_agents_note_cannot_be_made_people_only()
    {
        NotatoController controller = Controller(NotatoMode.Test);
        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            controller.AnnotateAsync(new Label(), "Contrast is low", new AnnotateOptions { AgentName = "Claude", PeopleOnly = true }));
        Assert.Contains("Only a person's note", error.Message);
    }

    // ---- the cards ---------------------------------------------------------------------------------------------

    private static IEnumerable<Element> All(Element root) => VisualTree.Descendants(root).Prepend(root);

    private static List<string> Words(Element root) =>
        [.. All(root).OfType<Label>().Select(l => l.FormattedText is { } f ? string.Concat(f.Spans.Select(s => s.Text)) : l.Text ?? "")];

    private static T Find<T>(Element root, string automationId) where T : VisualElement =>
        All(root).OfType<T>().Single(e => e.AutomationId == automationId);

    private static ComposerCard Composer(Func<string, string?, string?, bool, Task<string?>>? onSend = null) =>
        new("Border#PromoBanner", "“Autumn sale”", screenshotsOff: false, () => { }, () => { }, onSend ?? ((_, _, _, _) => Task.FromResult<string?>(null)));

    [Fact]
    public async Task The_composer_offers_people_only_off_by_default_and_sends_the_choice()
    {
        List<(string Comment, bool PeopleOnly)> sent = [];
        ComposerCard card = Composer((comment, _, _, peopleOnly) =>
        {
            sent.Add((comment, peopleOnly));
            return Task.FromResult<string?>(null);
        });
        Switch peopleOnly = Find<Switch>(card, "NotatoPeopleOnly");
        Assert.False(peopleOnly.IsToggled);
        Assert.Contains("People only", Words(card));
        Assert.Contains("Keep this between people: the agent won't see it.", Words(card));

        Find<Editor>(card, "NotatoComment").Text = "  Just checking with design first. ";
        await card.SendAsync();
        peopleOnly.IsToggled = true;
        await card.SendAsync();

        Assert.Equal([("Just checking with design first.", false), ("Just checking with design first.", true)], sent);
    }

    [Fact]
    public void No_mention_chips_are_offered_with_the_servers_default_and_none_is_built_in()
    {
        ComposerCard card = Composer();
        // What an older server, or one with no mention plugins (the default), gives.
        card.SetMentions([]);
        Assert.DoesNotContain(Words(card), w => w.StartsWith('@'));
        Assert.DoesNotContain(All(card), e => e is VisualElement { AutomationId: { } id } && id.StartsWith("NotatoMention-", StringComparison.Ordinal));

        // A plugin the server adds gets a chip, as any other would.
        card.SetMentions([new MentionInfo { Name = "jira", Description = "File it in Jira", Available = true }]);
        Assert.Contains("@jira", Words(card));
        Assert.DoesNotContain("@agent", Words(card));
    }

    [Fact]
    public void A_notes_card_shows_people_only_lets_it_be_turned_off_and_offers_an_aside()
    {
        // A server is set (never contacted) and the note is on it: the card has the reply box.
        NotatoController controller = Controller(NotatoMode.Dev, "http://127.0.0.1:9");
        NoteRecord record = new(Fixtures.PeopleOnlyAnnotation());
        PinCard card = new(controller, new OverlaySession(null!, null!), record, 1, () => { });

        Border badge = Find<Border>(card, "NotatoPeopleOnlyBadge");
        // Drawn as the web toolbar draws it: muted capitals on no fill, read out as the words.
        Label caps = (Label)badge.Content!;
        Assert.Equal("PEOPLE ONLY", caps.Text);
        Assert.Equal("People only", SemanticProperties.GetDescription(caps));
        Assert.Equal(Colors.Transparent, badge.BackgroundColor);
        Assert.True(Find<Switch>(card, "NotatoPeopleOnly").IsToggled);
        Switch aside = Find<Switch>(card, "NotatoAside");
        Assert.False(aside.IsToggled);
        List<string> words = Words(card);
        Assert.Contains("Aside", words);
        Assert.Contains("Just for people: the agent won't see this reply.", words);
        Assert.DoesNotContain(words, w => w.StartsWith('@'));
    }

    [Fact]
    public void A_note_that_is_not_people_only_has_no_badge_and_its_switch_is_off()
    {
        NotatoController controller = Controller(NotatoMode.Test);
        NoteRecord record = new(Fixtures.Annotation()) { Pending = true, Mine = true };
        PinCard card = new(controller, new OverlaySession(null!, null!), record, 1, () => { });

        Assert.DoesNotContain(All(card), e => e is VisualElement { AutomationId: "NotatoPeopleOnlyBadge" });
        Assert.False(Find<Switch>(card, "NotatoPeopleOnly").IsToggled);
        // No server: no reply box, so no Aside.
        Assert.DoesNotContain(All(card), e => e is VisualElement { AutomationId: "NotatoAside" });
        // And nothing waiting to be sent: the note goes out in a package.
        List<string> words = Words(card);
        Assert.Contains(PinCard.KeptHere, words);
        Assert.DoesNotContain(words, w => w.StartsWith("Not sent", StringComparison.Ordinal));
    }

    [Fact]
    public void A_long_thread_shows_its_last_four_and_says_how_many_more_the_board_has()
    {
        NotatoController controller = Controller(NotatoMode.Dev, "http://127.0.0.1:9");
        Annotation note = Fixtures.PeopleOnlyAnnotation();
        note = note with { Thread = [.. note.Thread, .. note.Thread.Take(2).Select(r => r with { Id = r.Id + "X" })] };
        PinCard card = new(controller, new OverlaySession(null!, null!), new NoteRecord(note), 1, () => { });

        Assert.Equal("2 earlier on the board.", Find<Label>(card, "NotatoEarlierReplies").Text);
        Assert.Null(PinCard.EarlierLine(4));
        Assert.Equal("1 earlier on the board.", PinCard.EarlierLine(5));
        PinCard shortOne = new(controller, new OverlaySession(null!, null!), new NoteRecord(Fixtures.PeopleOnlyAnnotation()), 1, () => { });
        Assert.DoesNotContain(All(shortOne), e => e is VisualElement { AutomationId: "NotatoEarlierReplies" });
    }

    [Fact]
    public void An_aside_is_labelled_in_the_thread_and_set_apart()
    {
        IReadOnlyList<Reply> thread = Fixtures.PeopleOnlyAnnotation().Thread;
        static string Said(Reply reply) => string.Concat(((Label)PinCard.ReplyView(reply).Content!).FormattedText.Spans.Select(s => s.Text));

        Assert.Equal("Claude: Looking at the contrast now.", Said(thread[0]));
        Assert.Equal("Aside · Dom: Sam, ignore the agent for a sec.", Said(thread[1]));
        // The automatic entries read like any other entry.
        Assert.Equal("Sam: Shared this with the agent.", Said(thread[2]));
        Assert.Equal("Dom: Made this people only: the agent won't see it.", Said(thread[3]));

        // An aside is outlined, not filled like the rest.
        Assert.Equal(0, PinCard.ReplyView(thread[0]).StrokeThickness);
        Assert.Equal(1, PinCard.ReplyView(thread[1]).StrokeThickness);
    }
}
