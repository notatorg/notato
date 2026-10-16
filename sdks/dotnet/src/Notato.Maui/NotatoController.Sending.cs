using Microsoft.Extensions.Logging;
using Notato.Maui.Model;
using Notato.Maui.Net;
using Notato.Maui.Runtime;

namespace Notato.Maui;

// Sending notes made here to the server, oldest first: one at a time, again later when the server cannot take them
// yet, and set aside when it refuses one for good. Notes kept on the device from an earlier run are read in first.
internal sealed partial class NotatoController
{
    /// <summary>The longest wait between flushes that keep failing.</summary>
    private const int MaxRetrySeconds = 120;

    /// <summary>One send at a time, so the notes arrive in order and a send never overlaps a change made here.</summary>
    private readonly SemaphoreSlim _sending = new(1, 1);
    /// <summary>A flush that stopped is to be tried again; how many times in a row that has happened.</summary>
    private bool _retryPlanned;
    private int _retries;

    /// <summary>How a try at sending a note ended.</summary>
    internal enum Sending
    {
        /// <summary>The server has it (or had it already).</summary>
        Sent,

        /// <summary>The server turned this note down for good: the note says why, and the notes after it still go.</summary>
        Refused,

        /// <summary>Not now (no server, offline, not allowed, unknown project, busy): it and the notes after it wait.</summary>
        Later,
    }

    /// <summary>How a send ended, and what to tell the person (<c>Problem</c>) when there is something to tell.</summary>
    internal readonly record struct SendResult(Sending Outcome, string? Problem);

    /// <summary>Sends one note now, to <paramref name="client"/> (the current server's unless given).</summary>
    /// <remarks>Safe from any thread: the note list and its records are only ever changed on the main thread.</remarks>
    private async Task<SendResult> SendAsync(NoteRecord record, CancellationToken ct = default, NotatoClient? client = null)
    {
        NotatoClient? c = client ?? _client;
        if (!HasServer || c is null)
        {
            return new SendResult(Sending.Later, null);
        }

        await _sending.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            (bool pending, Annotation annotation, IReadOnlyDictionary<string, string>? assets) =
                await OnMain(() => (record.Pending && !_records.WasDeleted(record.Annotation.Id), record.Annotation, record.Assets)).ConfigureAwait(false);
            if (!pending)
            {
                return new SendResult(Sending.Sent, null);
            }

            PostedAnnotation posted = await c.PostAnnotationAsync(annotation, assets ?? new Dictionary<string, string>(), ct).ConfigureAwait(false);
            Annotation stored = posted.Stored.Annotation;
            if (await OnMain(() => _records.WasDeleted(annotation.Id)).ConfigureAwait(false))
            {
                // Deleted here while it was on its way: it goes from the server too.
                await DeleteSentAsync(c, annotation.Id).ConfigureAwait(false);
                return new SendResult(Sending.Sent, null);
            }

            if (!posted.Created && PeopleOnlyToggle.ToReplay(annotation, stored) is { } replay)
            {
                stored = await ReplayPeopleOnlyAsync(c, annotation.Id, replay.On, replay.By, stored, ct).ConfigureAwait(false);
            }

            await OnMain(() =>
            {
                // The server's events may have brought a newer copy while the answer was on its way: that one stays.
                if (record.Pending)
                {
                    record.Annotation = stored;
                    record.Pending = false;
                }

                record.Error = null;
                record.Held = null;
                record.Assets = null;
                RaiseChanged();
            }).ConfigureAwait(false);
            if (_local is { } store)
            {
                await store.RemoveAsync(annotation.Id).ConfigureAwait(false);
            }

            return new SendResult(Sending.Sent, null);
        }
        catch (NotatoServerException error) when (error.Rejected)
        {
            _logger.LogWarning("The Notato server refused annotation {Id}: {Problem}", record.Annotation.Id, error.Message);
            await OnMain(() =>
            {
                record.Error = error.Message;
                record.Held = null;
                RaiseChanged();
            }).ConfigureAwait(false);
            // Remembered, so it is not sent first (and refused again) after every restart.
            if (_local is { } store)
            {
                await store.MarkRefusedAsync(record.Annotation.Id, error.Message).ConfigureAwait(false);
            }

            return new SendResult(Sending.Refused, "The server refused it: " + error.Message);
        }
        catch (NotatoServerException error) when (error.Status != 0)
        {
            // It answered, but not yet (an unknown project, a credential, too busy): say what it said, and keep the note.
            _logger.LogWarning("Notato kept annotation {Id} to send later: {Problem}", record.Annotation.Id, error.Message);
            await OnMain(() =>
            {
                record.Held = error.Message;
                RaiseChanged();
                RetryFlushLater();
            }).ConfigureAwait(false);
            return new SendResult(Sending.Later, "Saved on this device. The server said: " + error.Message);
        }
        catch (Exception error)
        {
            _logger.LogDebug(error, "Notato could not send annotation {Id} yet", record.Annotation.Id);
            await OnMain(RetryFlushLater).ConfigureAwait(false);
            return new SendResult(Sending.Later, "Saved. It's sent when the server can be reached.");
        }
        finally
        {
            _sending.Release();
        }
    }

    /// <summary>
    /// The server had the note already (the answer to an earlier send was lost) and People only was turned on or off
    /// here since: the change is made again on the server, as the person who made it, before its copy is taken. When
    /// the server will not take the change, its copy is taken as it is (and the person can turn it again); when it
    /// cannot be reached, the note waits and is sent again.
    /// </summary>
    private async Task<Annotation> ReplayPeopleOnlyAsync(NotatoClient c, string id, bool on, Author by, Annotation stored, CancellationToken ct)
    {
        try
        {
            return (await c.SetPeopleOnlyAsync(id, on, by, ct).ConfigureAwait(false)).Annotation;
        }
        catch (NotatoServerException error) when (error.Status != 0)
        {
            _logger.LogWarning("Notato could not turn People only {State} again on annotation {Id}: {Problem}", on ? "on" : "off", id, error.Message);
            return stored;
        }
    }

    /// <summary>A note deleted here while it was being sent: the server's new copy goes too, and the device's.</summary>
    private async Task DeleteSentAsync(NotatoClient c, string id)
    {
        try
        {
            await c.DeleteAsync(id).ConfigureAwait(false);
        }
        catch (NotatoServerException error)
        {
            _logger.LogWarning("Notato could not delete annotation {Id} on the server after it was sent: {Problem}", id, error.Message);
        }

        if (_local is { } store)
        {
            await store.RemoveAsync(id).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Sends the notes that are waiting, oldest first, to <paramref name="client"/> (the current server's unless given).
    /// A note the server refuses is set aside and the rest go on; when one cannot go yet, the rest wait with it and the
    /// flush is tried again in a while.
    /// </summary>
    private async Task FlushAsync(NotatoClient? client = null)
    {
        List<NoteRecord> waiting = await OnMain(() => _records.Where(r => r.Pending && r.Error is null).ToList()).ConfigureAwait(false);
        // A send that has to wait plans the next try itself.
        if (await SendInOrderAsync(waiting, async r => (await SendAsync(r, client: client).ConfigureAwait(false)).Outcome).ConfigureAwait(false))
        {
            await OnMain(() => _retries = 0).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Sends <paramref name="waiting"/> in order until one has to wait, which keeps the rest waiting behind it. One
    /// that is refused does not: the next is sent. True when none had to wait.
    /// </summary>
    internal static async Task<bool> SendInOrderAsync<T>(IEnumerable<T> waiting, Func<T, Task<Sending>> send)
    {
        foreach (T item in waiting)
        {
            if (await send(item).ConfigureAwait(false) == Sending.Later)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// A note could not go while the server is meant to be there: flush again after a wait that grows each time (2 s up
    /// to 2 min). Over a lost connection it does nothing: connecting again flushes.
    /// </summary>
    private void RetryFlushLater()
    {
        if (_retryPlanned || _sync is null || !HasServer)
        {
            return;
        }

        _retryPlanned = true;
        CancellationToken token = _sync.Token;
        TimeSpan wait = TimeSpan.FromSeconds(Math.Min(MaxRetrySeconds, 2 << Math.Min(_retries, 6)));
        _retries++;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(wait, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            bool go = await OnMain(() =>
            {
                // A stopped sync's retry is over; the new one plans its own.
                if (token.IsCancellationRequested)
                {
                    return false;
                }

                _retryPlanned = false;
                return _connection == NotatoConnection.Connected;
            }).ConfigureAwait(false);
            if (go)
            {
                await FlushAsync().ConfigureAwait(false);
            }
        });
    }

    /// <summary>
    /// Reads the notes kept on the device for the current project into memory, once per store. A load that fails is
    /// tried again the next time (Notato switched on, or the project changed back).
    /// </summary>
    private async Task LoadLocalAsync()
    {
        if (_local is not { } store || ReferenceEquals(_loadedFrom, store) || ReferenceEquals(_loadingFrom, store))
        {
            return;
        }

        _loadingFrom = store;
        try
        {
            IReadOnlyList<LocalAnnotation> items = await store.LoadAsync().ConfigureAwait(false);
            await OnMain(() => AddLoaded(store, items)).ConfigureAwait(false);
            if (HasServer && _connection == NotatoConnection.Connected)
            {
                await FlushAsync().ConfigureAwait(false);
            }
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Notato could not read the notes kept on this device");
        }
        finally
        {
            await OnMain(() =>
            {
                if (ReferenceEquals(_loadingFrom, store))
                {
                    _loadingFrom = null;
                }
            }).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Adds the notes read from <paramref name="store"/>, unless the project changed while they were read: then they
    /// belong to another project's store, and stay there. Returns whether they were added.
    /// </summary>
    internal bool AddLoaded(LocalStore store, IReadOnlyList<LocalAnnotation> items)
    {
        if (!ReferenceEquals(_local, store))
        {
            return false;
        }

        foreach (LocalAnnotation item in items)
        {
            if (_records.Find(item.Annotation.Id) is not null || _records.WasDeleted(item.Annotation.Id))
            {
                continue;
            }

            _records.Add(new NoteRecord(item.Annotation) { Pending = true, Mine = true, Assets = item.Assets, Error = item.Refused });
        }

        _loadedFrom = store;
        RaiseChanged();
        return true;
    }
}
