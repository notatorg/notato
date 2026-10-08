namespace Notato.Maui.Net;

/// <summary>
/// A response body that may take as long as it needs while it keeps coming, but not stall: a read that gets nothing for
/// <c>limit</c> throws <see cref="TimeoutException"/>. A long list on a slow connection is read whole; one whose
/// connection died without closing is not waited on for ever.
/// </summary>
internal sealed class IdleTimeoutStream(Stream inner, TimeSpan limit) : Stream
{
    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        using CancellationTokenSource quiet = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task<int> read = inner.ReadAsync(buffer, quiet.Token).AsTask();
        Task idle = Task.Delay(limit, quiet.Token);
        // Not every platform's network stream stops a read when asked to, so the wait is raced rather than cancelled.
        if (await Task.WhenAny(read, idle).ConfigureAwait(false) == read)
        {
            await quiet.CancelAsync().ConfigureAwait(false);
            return await read.ConfigureAwait(false);
        }

        await quiet.CancelAsync().ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // The read ends when the caller closes the response; what it ends with no longer matters.
        _ = read.ContinueWith(static t => _ = t.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        throw new TimeoutException($"The server sent nothing more for {limit.TotalSeconds:0} s.");
    }

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
