using Notato.Maui.Model;

namespace Notato.Maui.Tests;

/// <summary>The queue of notes to send, and what the device keeps once the server's list is in.</summary>
public class SendingTests
{
    private static async Task<List<string>> Flush(params (string Id, NotatoController.Sending Outcome)[] queue)
    {
        List<string> tried = [];
        await NotatoController.SendInOrderAsync(queue, item =>
        {
            tried.Add(item.Id);
            return Task.FromResult(item.Outcome);
        });
        return tried;
    }

    [Fact]
    public async Task A_refused_note_does_not_hold_up_the_ones_after_it()
    {
        List<string> tried = await Flush(("a", NotatoController.Sending.Refused), ("b", NotatoController.Sending.Sent), ("c", NotatoController.Sending.Sent));
        Assert.Equal(["a", "b", "c"], tried);
    }

    [Fact]
    public async Task A_note_that_has_to_wait_keeps_the_rest_waiting_in_order()
    {
        List<string> tried = await Flush(("a", NotatoController.Sending.Sent), ("b", NotatoController.Sending.Later), ("c", NotatoController.Sending.Sent));
        Assert.Equal(["a", "b"], tried);
        Assert.False(await NotatoController.SendInOrderAsync([NotatoController.Sending.Later], Task.FromResult));
        Assert.True(await NotatoController.SendInOrderAsync([NotatoController.Sending.Sent, NotatoController.Sending.Refused], Task.FromResult));
    }

    private static NoteRecord Record(string id, bool pending = false) => new(Fixtures.Annotation() with { Id = id }) { Pending = pending };

    private static StoredAnnotation Stored(string id) => new() { Annotation = Fixtures.Annotation() with { Id = id } };

    [Fact]
    public void Only_notes_the_server_had_when_the_list_was_asked_for_are_dropped_when_it_no_longer_has_them()
    {
        List<NoteRecord> records =
        [
            Record("kept"),
            Record("deleted-on-the-board"),
            Record("waiting-to-send", pending: true),
            // Sent while the pages were coming in: newer than the list.
            Record("sent-during-the-load"),
            // From an event, or made, after the list was asked for.
            Record("arrived-during-the-load"),
        ];
        HashSet<string> settledAtStart = ["kept", "deleted-on-the-board"];

        records.RemoveAll(NotatoController.Gone([Stored("kept")], settledAtStart));

        Assert.Equal(["kept", "waiting-to-send", "sent-during-the-load", "arrived-during-the-load"], records.Select(r => r.Annotation.Id));
    }

    [Fact]
    public void Notes_past_the_first_page_are_not_dropped()
    {
        List<StoredAnnotation> everyPage = [.. Enumerable.Range(0, 1200).Select(i => Stored($"N{i:0000}"))];
        List<NoteRecord> records = [.. everyPage.Select(s => Record(s.Annotation.Id))];
        HashSet<string> settledAtStart = [.. records.Select(r => r.Annotation.Id)];

        records.RemoveAll(NotatoController.Gone(everyPage, settledAtStart));

        Assert.Equal(1200, records.Count);
    }
}
