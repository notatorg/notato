using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Overlay;
using Notato.Maui.Util;

namespace Notato.Maui;

// What a person does with a note from its card, and the settings sheet: reply, People only, ask for a revert, delete.
internal sealed partial class NotatoController
{
    private NotatoClient Client => _client is not null && HasServer ? _client : throw new InvalidOperationException("Not connected to a Notato server.");

    private Author Me => Author.Human(AuthorName);

    /// <summary>
    /// Opens a note's card. <paramref name="back"/> is where its Back goes: the list of notes it was opened from; none
    /// when its pin was tapped.
    /// </summary>
    internal void OpenPin(OverlaySession session, string id, Action? back = null)
    {
        (int number, NoteRecord? record) = RecordsOnRoute(session).FirstOrDefault(x => x.Record.Annotation.Id == id);
        record ??= _records.Find(id);
        if (record is null)
        {
            return;
        }

        // A note from another screen has no number here: its card says "Note".
        PinCard card = new(this, session, record, number, session.View.CloseSheet, back);
        // Opened from the list, it was opened from the toolbar's menu: folding the toolbar closes it.
        session.View.ShowSheet(card, dim: true, fromBar: back is not null);
    }

    internal void Toast(OverlaySession session, string message) => session.View.Toast(message);

    /// <summary>Replies on a note. An <paramref name="aside"/> is for the people on the thread: the agent never gets it.</summary>
    internal async Task ReplyAsync(string id, string text, bool aside = false) => Upsert((await Client.ReplyAsync(id, text.Trim(), Me, aside)).Annotation);

    /// <summary>
    /// Turns People only on or off for a note, as the person. The server records the change in the thread. A note the
    /// server does not have yet (no server, test mode, or not sent yet) is changed here, with the same thread entry, so
    /// it goes (or is packaged) that way.
    /// </summary>
    internal async Task SetPeopleOnlyAsync(string id, bool on)
    {
        NoteRecord record = _records.Find(id) ?? throw new InvalidOperationException("That note is gone.");
        if (record.Pending)
        {
            // Waits for a send under way, so the change is not lost under the copy the server sends back.
            await _sending.WaitAsync();
            try
            {
                if (record.Pending)
                {
                    record.Annotation = PeopleOnlyToggle.Set(record.Annotation, on, Me, Ulid.New(), Timestamps.Now());
                    if (_local is not null)
                    {
                        // The note again; its screenshots are kept already.
                        await _local.SaveAsync(record.Annotation);
                    }

                    RaiseChanged();
                    return;
                }
            }
            finally
            {
                _sending.Release();
            }
        }

        Upsert((await Client.SetPeopleOnlyAsync(id, on, Me)).Annotation);
    }

    /// <summary>Asks the agent to undo a resolved note's change, saying why when the person did.</summary>
    internal async Task RequestRevertAsync(string id, string? reason) =>
        Upsert((await Client.SetStatusAsync(id, Statuses.RevertRequested, string.IsNullOrWhiteSpace(reason) ? "Please undo this change." : reason.Trim(), Me)).Annotation);

    internal async Task CancelRevertAsync(string id) =>
        Upsert((await Client.SetStatusAsync(id, Statuses.Resolved, "Revert request taken back.", Me)).Annotation);

    internal async Task DeleteAsync(string id)
    {
        NoteRecord? record = _records.Find(id);
        if (record is { Pending: false } && HasServer)
        {
            await Client.DeleteAsync(id);
        }

        // Remembered for the rest of the run: a copy of it on its way (an event, a list, the answer to a send under
        // way) does not bring it back, and a send under way deletes it on the server once it lands.
        _records.MarkDeleted(id);
        _records.Remove(id);
        if (_local is not null)
        {
            await _local.RemoveAsync(id);
        }

        RaiseChanged();
    }

    /// <summary>The settings sheet's Save. A server that is not an http(s) address is turned down, and said so.</summary>
    internal void SaveSettings(string? name, bool screenshots, string? server)
    {
        _state.Author = name;
        _state.Screenshots = screenshots == Options.Screenshots ? null : screenshots;
        string? trimmed = string.IsNullOrWhiteSpace(server) ? null : server.Trim().TrimEnd('/');
        if (trimmed is not null && !IsHttpUrl(trimmed))
        {
            _sessions.FirstOrDefault()?.View.Toast($"\"{trimmed}\" is not an http(s) address; the server was not changed.");
            trimmed = _state.Server;
        }

        bool serverChanged = trimmed != _state.Server;
        _state.Server = trimmed == Options.ResolvedServer ? null : trimmed;
        if (serverChanged && _enabled)
        {
            // The last server's notes go; those still to be sent here stay, and go to the new one.
            _records.RemoveAll(r => !r.Pending);
            StartSync();
        }

        RenderAll();
    }
}
