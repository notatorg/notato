using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Runtime;
using System.Net;

namespace Notato.Maui.Tests;

/// <summary>What the server allows (<c>/config</c>): screenshots, and a capture-only token that may only send notes.</summary>
public class ServerPolicyTests
{
    private const string Id = "01M46YHJA6PBM210JB4H2WMY14";

    private static Annotation Note(string id) => Fixtures.Annotation() with { Id = id };

    private static NotatoClient ClientFor(FakeServer server) => new(new HttpClient(server), "http://127.0.0.1:9", null);

    [Fact]
    public async Task No_screenshot_is_taken_until_the_server_says_so_and_a_lost_answer_keeps_its_last_word()
    {
        NotatoController controller = Fixtures.Controller();
        Assert.False(controller.ServerScreenshotsAllowed);

        bool down = false;
        FakeServer server = new((_, _) => down
            ? throw new HttpRequestException("no route to host")
            : Fixtures.Json(HttpStatusCode.OK, """{"screenshots":true}"""));
        Assert.NotNull(await controller.AskServerAsync(ClientFor(server), CancellationToken.None));
        Assert.True(controller.ServerScreenshotsAllowed);

        down = true;
        Assert.Null(await controller.AskServerAsync(ClientFor(server), CancellationToken.None));
        Assert.True(controller.ServerScreenshotsAllowed);

        // An answer that does not say is no answer for screenshots.
        down = false;
        FakeServer silent = new((_, _) => Fixtures.Json(HttpStatusCode.OK, "{}"));
        await controller.AskServerAsync(ClientFor(silent), CancellationToken.None);
        Assert.False(controller.ServerScreenshotsAllowed);
    }

    [Fact]
    public async Task A_capture_only_token_sends_the_waiting_notes_and_nothing_else()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NoteRecord(Note(Id)) { Pending = true, Mine = true });
        FakeServer server = new((request, _) => request.Method == HttpMethod.Post
            ? Fixtures.Stored(HttpStatusCode.Created, Note(Id))
            : Fixtures.Json(HttpStatusCode.OK, """{"screenshots":true,"captureOnly":true}"""));
        NotatoClient client = ClientFor(server);

        Assert.True((await controller.AskServerAsync(client, CancellationToken.None))?.CaptureOnly);
        Assert.True(controller.CaptureOnly);
        await controller.OnSendOnlyAsync(client, CancellationToken.None);

        Assert.Equal(["GET /config", "POST /projects/maui-sample/annotations"], server.Asked);
        Assert.Equal(0, controller.PendingCount);

        // Reading or changing what it sent is the board's.
        InvalidOperationException reply = await Assert.ThrowsAsync<InvalidOperationException>(() => controller.ReplyAsync(Id, "More"));
        Assert.Equal(NotatoController.OnTheBoard, reply.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SetPeopleOnlyAsync(Id, true));
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.DeleteAsync(Id));
        Assert.Equal(2, server.Seen.Count);
        Assert.Single(controller.Records);
    }

    [Fact]
    public async Task A_capture_only_token_takes_a_409_as_a_note_the_server_already_has()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NoteRecord(Note(Id)) { Pending = true, Mine = true });
        FakeServer server = new((request, _) => request.Method == HttpMethod.Post
            ? Fixtures.Json(HttpStatusCode.Conflict, """{"error":"annotation id already exists"}""")
            : Fixtures.Json(HttpStatusCode.OK, """{"screenshots":true,"captureOnly":true}"""));
        NotatoClient client = ClientFor(server);

        await controller.AskServerAsync(client, CancellationToken.None);
        await controller.OnSendOnlyAsync(client, CancellationToken.None);

        NoteRecord record = controller.Records.Single();
        Assert.False(record.Pending);
        Assert.Null(record.Error);
    }

    [Fact]
    public void A_recorded_request_keeps_neither_its_query_nor_a_user_name_and_password()
    {
        Assert.Equal("https://api.example.com/orders", NotatoNetworkHandler.Recorded(new Uri("https://dom:hunter2@api.example.com/orders?key=abc#top")));
        Assert.Equal("http://localhost:5000/cart", NotatoNetworkHandler.Recorded(new Uri("http://localhost:5000/cart?session=1")));
    }
}
