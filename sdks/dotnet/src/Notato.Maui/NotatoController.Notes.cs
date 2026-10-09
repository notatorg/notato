using Microsoft.Extensions.Logging;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Capture;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Native;
using Notato.Maui.Runtime;
using Notato.Maui.Util;
using System.Text.Json;

namespace Notato.Maui;

// Making a note: from the composer, from the app's code (AnnotateAsync), or for an agent (see AnswerRelayAsync). A
// note is kept on the device, screenshots and all, before it is sent.
internal sealed partial class NotatoController
{
    private readonly SemaphoreSlim _creating = new(1, 1);

    /// <summary>The composer's Send. Returns what went wrong, fit to show under it, or null.</summary>
    internal async Task<string?> SubmitAsync(OverlaySession session, string comment, string? intent, string? severity, bool peopleOnly)
    {
        if (session.Selection is not { } selection)
        {
            return "Select something first.";
        }

        try
        {
            // The note takes the picture (once it is taken: a quick Send waits for it), and disposes it once its
            // screenshots are drawn: sending again after a failure goes without one.
            CapturedScreen? screen = await selection.TakeScreenAsync();
            NoteRecord record = await CreateAsync(session, selection.Elements, screen, comment, intent, severity, Author.Human(AuthorName), ModeName, null, peopleOnly);
            ClearSelection(session);
            session.View.ShowSelection(null);
            session.View.CloseSheet();
            _annotating = false;
            RenderAll();
            SendResult sent = await SendAsync(record);
            session.View.Toast(sent.Problem ?? (HasServer ? "Sent" : "Saved on this device. Package it from the menu."));
            return null;
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not make the annotation");
            return error.Message;
        }
    }

    /// <summary>The mode a person's note is made in, as the schema writes it.</summary>
    private string ModeName => Options.Mode switch
    {
        NotatoMode.Test => Modes.Test,
        NotatoMode.Agent => Modes.Agent,
        _ => Modes.Dev,
    };

    public async Task<Annotation> AnnotateAsync(VisualElement element, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default)
    {
        options ??= new AnnotateOptions();
        if (string.IsNullOrWhiteSpace(comment))
        {
            throw new ArgumentException("A note needs a comment.", nameof(comment));
        }

        if (options.PeopleOnly && options.AgentName is not null)
        {
            throw new ArgumentException("Only a person's note can be People only: it is how people keep a note from the agent.", nameof(options));
        }

        cancellationToken.ThrowIfCancellationRequested();
        return await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            OverlaySession session = SessionForCode(element);
            CapturedScreen? screen = options.Screenshot ? await CaptureAsync(session) : null;
            // The last point at which nothing has been made.
            if (cancellationToken.IsCancellationRequested)
            {
                screen?.Dispose();
                cancellationToken.ThrowIfCancellationRequested();
            }

            Author author = options.AgentName is null ? Author.Human(AuthorName) : Author.Agent(options.AgentName);
            string mode = options.AgentName is null ? ModeName : Modes.Agent;
            NoteRecord record = await CreateAsync(session, [element], screen, comment, options.Intent, options.Severity, author, mode, options.Steps, options.PeopleOnly);
            RenderAll();
            SendResult sent = await SendAsync(record, cancellationToken);
            if (sent.Outcome != Sending.Sent && sent.Problem is not null)
            {
                _logger.LogWarning("Notato kept the annotation on the device: {Problem}", sent.Problem);
            }

            return record.Annotation;
        });
    }

    public Task<Annotation> AnnotateAsync(string selector, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default) =>
        MainThread.InvokeOnMainThreadAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            VisualElement element = Find(selector) ?? throw new InvalidOperationException($"No element on the screen matches \"{selector}\".");
            return await AnnotateAsync(element, comment, options, cancellationToken);
        });

    /// <summary>
    /// Makes one note at a time. A note's pin number is the count of notes on its screen plus one, and it only joins that
    /// list once its screenshot is drawn: two made at once (an agent relaying twice) would otherwise share a number.
    /// </summary>
    private async Task<NoteRecord> CreateAsync(OverlaySession session, IReadOnlyList<VisualElement> elements, CapturedScreen? screen, string comment,
        string? intent, string? severity, Author author, string mode, IReadOnlyList<AgentStep>? steps, bool peopleOnly)
    {
        try
        {
            await _creating.WaitAsync();
            try
            {
                return await CreateOneAsync(session, elements, screen, comment, intent, severity, author, mode, steps, peopleOnly);
            }
            finally
            {
                _creating.Release();
            }
        }
        finally
        {
            // Done with as soon as the screenshots are drawn; this is for a note that failed before then.
            screen?.Dispose();
        }
    }

    private async Task<NoteRecord> CreateOneAsync(OverlaySession session, IReadOnlyList<VisualElement> elements, CapturedScreen? screen, string comment,
        string? intent, string? severity, Author author, string mode, IReadOnlyList<AgentStep>? steps, bool peopleOnly)
    {
        NotatoOptions options = Options;
        IElementGeometry geometry = session.Host.Geometry;
        List<Rect> rects = [.. elements.Select(e => geometry.BoundsOf(e) ?? Rect.Zero)];
        Rect union = rects.Aggregate((a, b) => a.Union(b));
        (string route, string url, _, _, _) = AppContextInfo.RouteOf(session.Window);
        int pin = _records.On(route).Count + 1;
        bool mask = options.ResolvedMaskInputs;

        ComposedScreenshots? shots = null;
        try
        {
            if (screen is not null && ScreenshotsOn)
            {
                // Where the private parts were when the picture was taken, not where they are now.
                IReadOnlyList<Rect> masks = screen.Masks;
                double maxScale = options.MaxScreenshotScale;
                shots = await Task.Run(() => ScreenshotComposer.Compose(screen, rects, pin, masks, maxScale));
            }
        }
        finally
        {
            // The window's bitmap is done with: its PNGs are drawn (or there are none).
            screen?.Dispose();
        }

        Annotation annotation = new()
        {
            Id = Ulid.New(),
            ProjectId = options.Project,
            BundleId = null,
            Author = author,
            Mode = mode,
            CreatedAt = Timestamps.Now(),
            Url = url,
            Route = route,
            AppName = AppContextInfo.AppName(options),
            AppVersion = AppContextInfo.AppVersion(options),
            Environment = AppContextInfo.Environment(options, session.Host.Size),
            Target = new Target
            {
                Kind = elements.Count > 1 ? TargetKinds.Multi : TargetKinds.Element,
                Identity = [.. elements.Select(e => _inspector.Describe(e, mask))],
                Rect = new PageRect(Math.Round(union.X, 2), Math.Round(union.Y, 2), Math.Round(union.Width, 2), Math.Round(union.Height, 2)),
            },
            Comment = comment.Trim(),
            Severity = severity,
            Intent = intent,
            Screenshots = shots?.Refs,
            Steps = steps,
            Context = ContextFor(session, elements[0], pin, options),
            Status = Statuses.Open,
            Thread = [],
            PeopleOnly = PeopleOnlyToggle.Flag(peopleOnly),
        };

        // On the device first, screenshots and all: only where they are is kept in memory.
        LocalStore store = _local ?? UseProjectStore();
        IReadOnlyDictionary<string, string> assets = await store.SaveAsync(annotation, shots?.Assets);
        NoteRecord record = new(annotation)
        {
            Pending = true,
            Mine = true,
            Element = new PinTarget(elements[0]),
            Assets = assets,
        };
        _records.Add(record);
        RaiseChanged();
        return record;
    }

    /// <summary>
    /// A note's <c>context</c>: the app and device (<c>maui</c>), its pin's number, and the app's recent log and HTTP
    /// requests when there are any.
    /// </summary>
    private Dictionary<string, JsonElement> ContextFor(OverlaySession session, VisualElement element, int pin, NotatoOptions options)
    {
        Dictionary<string, JsonElement> context = new()
        {
            ["maui"] = JsonSerializer.SerializeToElement(AppContextInfo.Describe(session.Window, element, _inspector.Sources), ContextJson.Default.MauiContextInfo),
            ["screenshot"] = JsonSerializer.SerializeToElement(new PinContext { Pin = pin }, ContextJson.Default.PinContext),
        };
        if (options.CaptureLogs)
        {
            List<LogEntry> logs = LogRecorder.Shared.Entries.Snapshot();
            if (logs.Count > 0)
            {
                context["console"] = JsonSerializer.SerializeToElement(logs, NotatoJsonContext.Default.ListLogEntry);
            }
        }

        List<NetworkEntry> network = NotatoNetworkHandler.Entries.Snapshot();
        if (network.Count > 0)
        {
            context["network"] = JsonSerializer.SerializeToElement(network, NotatoJsonContext.Default.ListNetworkEntry);
        }

        return context;
    }
}
