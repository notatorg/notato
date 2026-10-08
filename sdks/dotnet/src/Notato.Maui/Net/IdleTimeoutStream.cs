namespace Notato.Maui.Net;

/// <summary>
/// A response body that may take as long as it needs while it keeps coming, but not stall: a read that gets nothing for
/// <c>limit</c> throws <see cref="TimeoutException"/>. A long list on a slow connection is read whole; one whose
/// connection died without closing is not waited on for ever.
/// </summary>
internal sealed class IdleTimeoutStream(Stream inner, TimeSpan limit) : Stream
{
    private readonly string _stalled = $"The server sent nothing more for {limit.TotalSeconds:0} s.";

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
        new(IdleTimeout.ReadAsync(token => inner.ReadAsync(buffer, token), limit, _stalled, cancellationToken));

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }
}

/// <summary>Reads from the network that give up when nothing at all arrives for a while.</summary>
internal static class IdleTimeout
{
    /// <summary>
    /// Waits for <paramref name="read"/>, but for <paramref name="limit"/> at most: then throws
    /// <see cref="TimeoutException"/> with <paramref name="message"/>. Not every platform's network stream stops a read
    /// when asked to, so the wait is raced rather than cancelled; the read that lost ends when the caller closes the
    /// stream, and what it ends with no longer matters.
    /// </summary>
    public static async Task<T> ReadAsync<T>(Func<CancellationToken, ValueTask<T>> read, TimeSpan limit, string message, CancellationToken ct)
    {
        using CancellationTokenSource quiet = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task<T> reading = read(quiet.Token).AsTask();
        Task idle = Task.Delay(limit, quiet.Token);
        if (await Task.WhenAny(reading, idle).ConfigureAwait(false) == reading)
        {
            await quiet.CancelAsync().ConfigureAwait(false);
            return await reading.ConfigureAwait(false);
        }

        await quiet.CancelAsync().ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        _ = reading.ContinueWith(static t => _ = t.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        throw new TimeoutException(message);
    }
}
