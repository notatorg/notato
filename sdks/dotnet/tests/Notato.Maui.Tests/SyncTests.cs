using Microsoft.Extensions.Logging.Abstractions;
using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Runtime;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Xunit.Abstractions;

namespace Notato.Maui.Tests;

/// <summary>Keeping the notes in step with the server: the list on connecting, the events after it, and sending.</summary>
public class SyncTests(ITestOutputHelper output)
{
    private const string Id = "01M46YHJA6PBM210JB4H2WMY14";

    private static Annotation Note(string id) => Fixtures.Annotation() with { Id = id };

    private static StoredAnnotation Stored(Annotation annotation) => new() { Annotation = annotation };

    // ---- the list on connecting ---------------------------------------------------------------------------------

    [Fact]
    public void Merging_a_list_of_10000_notes_finds_each_by_its_id()
    {
        NotatoController controller = Fixtures.Controller();
        // 10,000 notes here, the server's list of 10,000: half of them the same, half new; 2,500 here gone from it.
        for (int i = 0; i < 10_000; i++)
        {
            controller.Records.Add(new NotatoController.Record(Note($"N{i:000000}")) { Pending = i % 4 == 0 && i < 5_000 });
        }

        HashSet<string> settled = controller.Records.SettledIds();
        List<StoredAnnotation> items = [.. Enumerable.Range(5_000, 10_000).Select(i => Stored(Note($"N{i:000000}") with { Status = Statuses.Acknowledged, Context = new Dictionary<string, JsonElement>() }))];
        Stopwatch clock = Stopwatch.StartNew();
        ServerList list = new(items, "maui-sample");
        TimeSpan sorting = clock.Elapsed;
        controller.Merge(list, settled);
        TimeSpan merging = clock.Elapsed - sorting;
        output.WriteLine($"10,000 listed into 10,000 known: {sorting.TotalMilliseconds:0.0} ms to read the list, {merging.TotalMilliseconds:0.0} ms to merge");

        // Searching the notes for each of the server's, as it was, took 185-350 ms on a desktop (and several times that on
        // a phone); found by id it takes about 5.
        Assert.True(merging < TimeSpan.FromMilliseconds(100), $"merging took {merging.TotalMilliseconds:0} ms");
        // N0..N4999: kept only if still to be sent (1,250 of them); N5000..N14999: on the server.
        Assert.Equal(1_250 + 10_000, controller.Records.Count);
        Assert.All(controller.Records.Where(r => !r.Pending), r => Assert.Equal(Statuses.Acknowledged, r.Annotation.Status));
        // The list leaves out what only the agent reads: the copy here keeps it.
        Assert.NotEmpty(controller.Records.Find("N005000")!.Annotation.Context);
        Assert.Equal(11_250, controller.Annotations.Count);
        Assert.Equal(1_250, controller.PendingCount);
    }

    [Fact]
    public async Task On_connecting_the_waiting_notes_go_first_then_a_short_list_is_read()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NotatoController.Record(Note(Id)) { Pending = true, Mine = true });
        FakeServer server = new((request, _) => request.Method == HttpMethod.Post
            ? Fixtures.Stored(HttpStatusCode.Created, Note(Id))
            : request.RequestUri!.AbsolutePath == "/config"
                ? Fixtures.Json(HttpStatusCode.OK, "{\"screenshots\":true}")
                : Fixtures.List(Note(Id), Note("01M46YHJA6PBM210JB4H2WMY15")));
        NotatoClient client = new(new HttpClient(server), "http://127.0.0.1:9", null);

        await controller.OnServerEventAsync(client, new ServerSentEvent("hello", "{}"), CancellationToken.None);

        Assert.Equal(
        [
            "GET /config",
            "POST /projects/maui-sample/annotations",
            "GET /projects/maui-sample/annotations?limit=500&fields=summary",
        ], server.Asked);
        Assert.Equal(2, controller.Records.Count);
        Assert.Equal(0, controller.PendingCount);
    }

    // ---- sending ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task A_retry_the_server_had_already_gets_the_people_only_change_made_here_since()
    {
        NotatoController controller = Fixtures.Controller();
        // Sent once (the server took it, the answer was lost), then made People only here while it waited.
        Annotation here = PeopleOnlyToggle.Set(Note(Id), true, Author.Human("Sam"), "01M46YHK00ON00000000000001", "2026-10-07T09:00:00.000Z");
        controller.Records.Add(new NotatoController.Record(here) { Pending = true, Mine = true });
        Annotation serversFirst = Note(Id);
        Annotation changed = PeopleOnlyToggle.Set(serversFirst, true, Author.Human("Sam"), "01M46YHK00SERVERENTRY00001", "2026-10-07T09:01:00.000Z");
        FakeServer server = new((request, _) => (request.Method.Method, request.RequestUri!.AbsolutePath) switch
        {
            ("POST", "/projects/maui-sample/annotations") => Fixtures.Stored(HttpStatusCode.OK, serversFirst),
            ("PATCH", _) => Fixtures.Stored(HttpStatusCode.OK, changed),
            ("GET", "/config") => Fixtures.Json(HttpStatusCode.OK, "{}"),
            _ => Fixtures.List(changed),
        });

        await controller.OnServerEventAsync(new NotatoClient(new HttpClient(server), "http://127.0.0.1:9", null), new ServerSentEvent("hello", "{}"), CancellationToken.None);

        (HttpMethod method, string path, string body) = Assert.Single(server.Seen, s => s.Method == HttpMethod.Patch);
        Assert.Equal($"/annotations/{Id}", path);
        Assert.Equal("""{"peopleOnly":true,"author":{"kind":"human","name":"Sam"}}""", body);
        NotatoController.Record record = controller.Records.Single();
        Assert.False(record.Pending);
        Assert.True(record.Annotation.PeopleOnly);
    }

    [Fact]
    public async Task A_first_send_or_a_copy_that_agrees_changes_nothing_on_the_server()
    {
        NotatoController controller = Fixtures.Controller();
        Annotation here = PeopleOnlyToggle.Set(Note(Id), true, Author.Human("Sam"), "01M46YHK00ON00000000000001", "2026-10-07T09:00:00.000Z");
        controller.Records.Add(new NotatoController.Record(here) { Pending = true, Mine = true });
        FakeServer server = new((request, _) => request.Method == HttpMethod.Post
            ? Fixtures.Stored(HttpStatusCode.Created, here)
            : request.RequestUri!.AbsolutePath == "/config" ? Fixtures.Json(HttpStatusCode.OK, "{}") : Fixtures.List(here));

        await controller.OnServerEventAsync(new NotatoClient(new HttpClient(server), "http://127.0.0.1:9", null), new ServerSentEvent("hello", "{}"), CancellationToken.None);

        Assert.DoesNotContain(server.Seen, s => s.Method == HttpMethod.Patch);
        Assert.True(controller.Records.Single().Annotation.PeopleOnly);
    }

    [Fact]
    public async Task An_answer_that_lands_after_a_newer_copy_came_by_event_keeps_the_newer_copy()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NotatoController.Record(Note(Id)) { Pending = true, Mine = true });
        Annotation acknowledged = Note(Id) with { Status = Statuses.Acknowledged };
        FakeServer server = new((request, _) =>
        {
            if (request.Method == HttpMethod.Post)
            {
                // While the answer is on its way, the agent acknowledges it and the event arrives first.
                controller.QueueEvent(new NotatoController.QueuedEvent(acknowledged, null, CancellationToken.None));
                controller.DrainEvents();
                return Fixtures.Stored(HttpStatusCode.Created, Note(Id));
            }
            return request.RequestUri!.AbsolutePath == "/config" ? Fixtures.Json(HttpStatusCode.OK, "{}") : Fixtures.List(acknowledged);
        });

        await controller.OnServerEventAsync(new NotatoClient(new HttpClient(server), "http://127.0.0.1:9", null), new ServerSentEvent("hello", "{}"), CancellationToken.None);

        Assert.Equal(Statuses.Acknowledged, controller.Records.Single().Annotation.Status);
    }

    [Fact]
    public async Task A_note_deleted_while_it_is_sent_is_deleted_on_the_server_too_and_stays_gone()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NotatoController.Record(Note(Id)) { Pending = true, Mine = true });
        FakeServer server = new((request, _) =>
        {
            switch (request.Method.Method, request.RequestUri!.AbsolutePath)
            {
                case ("POST", _):
                    // Deleted here while it is on its way.
                    Assert.True(controller.DeleteAsync(Id).IsCompletedSuccessfully);
                    return Fixtures.Stored(HttpStatusCode.Created, Note(Id));
                case ("DELETE", _):
                    return new HttpResponseMessage(HttpStatusCode.NoContent);
                case ("GET", "/config"):
                    return Fixtures.Json(HttpStatusCode.OK, "{}");
                default:
                    // A list asked for before the server's delete went through still has it.
                    return Fixtures.List(Note(Id));
            }
        });

        await controller.OnServerEventAsync(new NotatoClient(new HttpClient(server), "http://127.0.0.1:9", null), new ServerSentEvent("hello", "{}"), CancellationToken.None);
        // And the event for it, on its way.
        controller.QueueEvent(new NotatoController.QueuedEvent(Note(Id), null, CancellationToken.None));
        controller.DrainEvents();

        Assert.Contains($"DELETE /annotations/{Id}", server.Asked);
        Assert.True(server.Asked.IndexOf($"DELETE /annotations/{Id}") > server.Asked.IndexOf("POST /projects/maui-sample/annotations"));
        Assert.Empty(controller.Records);
        Assert.Empty(controller.Annotations);
    }

    // ---- events ----------------------------------------------------------------------------------------------------

    [Fact]
    public async Task A_burst_of_events_is_applied_together_with_one_change()
    {
        NotatoController controller = Fixtures.Controller();
        controller.Records.Add(new NotatoController.Record(Note("GONE")));
        int changes = 0;
        TaskCompletionSource applied = new(TaskCreationOptions.RunContinuationsAsynchronously);
        controller.Changed += (_, _) =>
        {
            Interlocked.Increment(ref changes);
            applied.TrySetResult();
        };

        for (int i = 0; i < 50; i++)
        {
            controller.QueueEvent(new NotatoController.QueuedEvent(Note($"E{i:00}"), null, CancellationToken.None));
        }

        controller.QueueEvent(new NotatoController.QueuedEvent(null, "GONE", CancellationToken.None));
        // A stopped connection's event is dropped.
        controller.QueueEvent(new NotatoController.QueuedEvent(Note("STALE"), null, new CancellationToken(canceled: true)));

        await applied.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(NotatoController.EventBatch * 3);

        Assert.Equal(1, changes);
        Assert.Equal(50, controller.Records.Count);
        Assert.Null(controller.Records.Find("GONE"));
        Assert.Null(controller.Records.Find("STALE"));
        Assert.Equal(50, controller.Annotations.Count);
    }

    // ---- what other threads read -----------------------------------------------------------------------------------

    [Fact]
    public async Task Annotations_is_a_copy_made_at_each_change_that_nothing_can_alter()
    {
        NotatoController controller = Fixtures.Controller(NotatoMode.Test, server: null);
        controller.Records.Add(new NotatoController.Record(Note(Id)) { Pending = true, Mine = true });
        // Not published until the change is raised.
        Assert.Empty(controller.Annotations);

        await controller.SetPeopleOnlyAsync(Id, true);
        IReadOnlyList<Annotation> copy = controller.Annotations;
        Assert.True(Assert.Single(copy).PeopleOnly);
        Assert.Equal(1, controller.PendingCount);
        Assert.Throws<NotSupportedException>(() => ((IList<Annotation>)copy).Add(Note("x")));

        await controller.SetPeopleOnlyAsync(Id, false);
        // The copy handed out before stays as it was; the next read has the change.
        Assert.True(Assert.Single(copy).PeopleOnly);
        Assert.Null(Assert.Single(controller.Annotations).PeopleOnly);
    }

    // ---- notes kept on the device ----------------------------------------------------------------------------------

    [Fact]
    public async Task Notes_read_for_the_last_project_are_not_added_after_a_switch()
    {
        string folder = Directory.CreateTempSubdirectory("notato-switch-").FullName;
        try
        {
            NotatoController controller = Fixtures.Controller(NotatoMode.Test, server: null);
            LocalStore old = new(folder, "old-project", NullLogger.Instance);
            await old.SaveAsync(Note(Id));
            IReadOnlyList<LocalAnnotation> read = await old.LoadAsync();
            // The project changed while they were being read.
            controller.UseLocalStore(new LocalStore(folder, "new-project", NullLogger.Instance), "new-project");

            Assert.False(controller.AddLoaded(old, read));
            Assert.Empty(controller.Records);

            controller.UseLocalStore(old, "old-project");
            Assert.True(controller.AddLoaded(old, read));
            Assert.True(Assert.Single(controller.Records).Pending);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
