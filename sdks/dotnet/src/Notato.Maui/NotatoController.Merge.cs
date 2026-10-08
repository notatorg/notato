using Notato.Maui.Model;
using Notato.Maui.Net;

namespace Notato.Maui;

// The server's copies of the notes, put in place: the whole list on connecting, and the events after it, gathered so
// a burst of them is one change.
internal sealed partial class NotatoController
{
    /// <summary>How long events gather before they are applied together: a burst (an agent working through notes) is one change.</summary>
    internal static readonly TimeSpan EventBatch = TimeSpan.FromMilliseconds(100);

    private readonly Lock _eventsGate = new();
    private readonly List<QueuedEvent> _events = [];
    private bool _drainPlanned;

    /// <summary>A note's new copy (<c>created</c>, <c>updated</c>, <c>replied</c>), or the id of one deleted, from the loop with <c>Token</c>.</summary>
    internal readonly record struct QueuedEvent(Annotation? Annotation, string? Deleted, CancellationToken Token);

    /// <summary>
    /// Which notes to drop once the server's whole list is in: those it had already taken when the list was asked for
    /// (<paramref name="settledAtStart"/>) and no longer has. A note still to be sent, or sent or made since, is kept.
    /// </summary>
    internal static Predicate<NoteRecord> Gone(IReadOnlyList<StoredAnnotation> items, IReadOnlySet<string> settledAtStart) =>
        Gone(new HashSet<string>(items.Select(i => i.Annotation.Id), StringComparer.Ordinal), settledAtStart);

    internal static Predicate<NoteRecord> Gone(IReadOnlySet<string> onServer, IReadOnlySet<string> settledAtStart) =>
        r => !r.Pending && settledAtStart.Contains(r.Annotation.Id) && !onServer.Contains(r.Annotation.Id);

    /// <summary>
    /// Puts the server's list in place: each note found by its id (not by searching the list), those gone from the
    /// server dropped, and one change raised for all of it. A note still waiting here whose People only change the
    /// server's copy lacks stays to be sent, and is sent (to <paramref name="client"/>) once this is done.
    /// </summary>
    internal void Merge(ServerList list, IReadOnlySet<string> settledAtStart, NotatoClient? client = null)
    {
        bool replay = false;
        foreach (Annotation annotation in list.Notes)
        {
            if (_records.WasDeleted(annotation.Id))
            {
                continue;
            }

            if (_records.Find(annotation.Id) is not { } existing)
            {
                _records.Add(new NoteRecord(annotation));
                continue;
            }

            // The list leaves out what only the agent reads; the copy here has it.
            Annotation incoming = annotation.Context.Count == 0 && existing.Annotation.Context.Count > 0
                ? annotation with { Context = existing.Annotation.Context, Steps = annotation.Steps ?? existing.Annotation.Steps }
                : annotation;
            replay |= !Adopt(existing, incoming);
        }

        // Gone from the server while we were away.
        _records.RemoveAll(Gone(list.Ids, settledAtStart));
        RaiseChanged();
        if (replay)
        {
            _ = FlushAsync(client);
        }
    }

    /// <summary>A copy of a note from the server: a new note, or the newer copy of one known here.</summary>
    private void Upsert(Annotation annotation, bool raise = true)
    {
        // Another project's, or deleted here: an event or answer on its way does not bring it back.
        if (annotation.ProjectId != Options.Project || _records.WasDeleted(annotation.Id))
        {
            return;
        }

        if (_records.Find(annotation.Id) is not { } existing)
        {
            _records.Add(new NoteRecord(annotation));
        }
        else if (!Adopt(existing, annotation))
        {
            _ = FlushAsync();
        }

        if (raise)
        {
            RaiseChanged();
        }
    }

    /// <summary>
    /// Takes the server's copy of a note known here. A note still waiting to be sent is the server's from now on, and
    /// leaves the device; unless People only was turned on or off here after the server took its first copy (whose
    /// answer was lost), which that copy lacks: then it stays to be sent, and sending makes the change again. False then.
    /// </summary>
    private bool Adopt(NoteRecord existing, Annotation server)
    {
        if (!existing.Pending)
        {
            existing.Annotation = server;
            return true;
        }

        if (existing.Error is null && PeopleOnlyToggle.ToReplay(existing.Annotation, server) is not null)
        {
            return false;
        }

        existing.Annotation = server;
        existing.Pending = false;
        existing.Error = null;
        existing.Held = null;
        existing.Assets = null;
        if (_local is not null)
        {
            _ = _local.RemoveAsync(server.Id);
        }

        return true;
    }

    /// <summary>
    /// Keeps an event to apply with the others that come within <see cref="EventBatch"/>: they are applied in order, on
    /// the main thread, and the overlay is drawn and <see cref="Changed"/> raised once for all of them.
    /// </summary>
    internal void QueueEvent(QueuedEvent e)
    {
        bool plan;
        lock (_eventsGate)
        {
            _events.Add(e);
            plan = !_drainPlanned;
            _drainPlanned = true;
        }

        if (plan)
        {
            _ = Task.Delay(EventBatch).ContinueWith(_ => Dispatch(DrainEvents), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }
    }

    /// <summary>Applies the events kept so far, and raises one change for them. Main thread.</summary>
    internal void DrainEvents()
    {
        List<QueuedEvent> batch;
        lock (_eventsGate)
        {
            _drainPlanned = false;
            if (_events.Count == 0)
            {
                return;
            }

            batch = [.. _events];
            _events.Clear();
        }

        bool changed = false;
        HashSet<string> deleted = new(StringComparer.Ordinal);
        foreach (QueuedEvent e in batch)
        {
            // A stopped loop's events are of the last server: dropped, as its other news is.
            if (e.Token.IsCancellationRequested)
            {
                continue;
            }

            if (e.Annotation is { } annotation)
            {
                Upsert(annotation, raise: false);
                changed = true;
            }
            else if (e.Deleted is { } id)
            {
                deleted.Add(id);
            }
        }

        // All of them in one pass over the notes. One still to be sent here is not the server's to delete.
        if (deleted.Count > 0)
        {
            changed |= _records.RemoveAll(r => !r.Pending && deleted.Contains(r.Annotation.Id)) > 0;
        }

        if (changed)
        {
            RaiseChanged();
        }
    }
}
