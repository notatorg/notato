using Notato.Maui.Net;

namespace Notato.Maui.Tests;

/// <summary>Reading the server's event stream, and noticing when it goes quiet.</summary>
public class ServerSentEventTests
{
    [Fact]
    public async Task Events_are_split_on_blank_lines_and_comments_are_skipped()
    {
        string text = "event: hello\ndata: {\"projectId\":\"p\"}\n\n: ping\n\nevent: updated\ndata: {\"a\":1,\ndata: \"b\":2}\n\ndata: plain\n\n";
        List<ServerSentEvent> events = [];
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new StringReader(text)))
        {
            events.Add(e);
        }

        Assert.Equal([new ServerSentEvent("hello", "{\"projectId\":\"p\"}"), new ServerSentEvent("updated", "{\"a\":1,\n\"b\":2}"), new ServerSentEvent("message", "plain")], events);
    }

    /// <summary>A connection that sends what it is given and then nothing, as a half-open one does: no error, no end.</summary>
    private sealed class Silent(string text) : TextReader
    {
        private readonly StringReader _given = new(text);

        public override async ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            if (_given.ReadLine() is { } line)
            {
                return line;
            }
            // Ignores the token, as some platforms' network streams do.
            await Task.Delay(Timeout.Infinite, CancellationToken.None);
            return null;
        }
    }

    [Fact]
    public async Task A_stream_that_goes_quiet_ends_in_a_timeout_after_what_it_sent()
    {
        List<ServerSentEvent> events = [];
        Task reading = Task.Run(async () =>
        {
            await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new Silent("event: hello\ndata: {}\n\n: ping\n"), TimeSpan.FromMilliseconds(150)))
            {
                events.Add(e);
            }
        });

        Task first = await Task.WhenAny(reading, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(reading, first);
        TimeoutException error = await Assert.ThrowsAsync<TimeoutException>(() => reading);
        Assert.Contains("keep-alive", error.Message);
        Assert.Equal([new ServerSentEvent("hello", "{}")], events);
    }

    /// <summary>A connection with nothing to say but a keep-alive every <paramref name="every"/>, then one event.</summary>
    private sealed class Pinging(int pings, TimeSpan every) : TextReader
    {
        private readonly Queue<string> _lines = new([.. Enumerable.Repeat(new[] { ": ping", "" }, pings).SelectMany(l => l), "event: bye", "data: {}", ""]);

        public override async ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            if (_lines.Count == 0)
            {
                return null;
            }

            if (_lines.Peek().StartsWith(':'))
            {
                await Task.Delay(every, cancellationToken);
            }

            return _lines.Dequeue();
        }
    }

    [Fact]
    public async Task Keep_alives_keep_a_quiet_stream_open()
    {
        // Ten pings 40 ms apart: far longer than the 150 ms limit in all, but never 150 ms without a line.
        List<ServerSentEvent> events = [];
        await foreach (ServerSentEvent e in ServerSentEvents.ReadAsync(new Pinging(10, TimeSpan.FromMilliseconds(40)), TimeSpan.FromMilliseconds(150)))
        {
            events.Add(e);
        }

        Assert.Equal([new ServerSentEvent("bye", "{}")], events);
    }
}
