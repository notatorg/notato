using Microsoft.Extensions.Logging;
using Microsoft.Maui.Controls;
using Notato.Maui.Inspection;
using Notato.Maui.Native;
using Notato.Maui.Overlay;

namespace Notato.Maui;

// The overlay in each of the app's windows: put in when a window gets its content, kept on top of modal pages, and
// taken out when the window goes or Notato is switched off.
internal sealed partial class NotatoController
{
    /// <summary>When to look again for the window on top after a modal page comes or goes, in milliseconds.</summary>
    private static readonly int[] ModalRefreshDelays = [0, 120, 400];

    /// <summary>A window got its content: put the overlay in it (when on).</summary>
    internal void OnWindowContent(Window window)
    {
        Start();
        if (!_enabled)
        {
            return;
        }

        // After the current layout pass, so the native window is fully set up.
        window.Dispatcher.Dispatch(() => Attach(window));
    }

    private void Attach(Window window)
    {
        if (!_enabled || _sessions.Any(s => ReferenceEquals(s.Window, window)))
        {
            return;
        }

        if (window.Handler?.MauiContext is not { } context || OverlayHosts.Create(window) is not { } host)
        {
            return;
        }

        OverlaySession session = new(window, host);
        session.View = new NotatoOverlay(this, session);
        try
        {
            host.Attach(session.View, context);
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not put its overlay in the window");
            host.Dispose();
            return;
        }

        host.MetricsChanged += (_, _) => session.View.Dispatcher.Dispatch(() =>
        {
            session.View.SetMetrics(host.SafeInsets, host.KeyboardHeight);
            // The keyboard or a new size can move what the app shows.
            Follow(session);
        });
        host.ContentMoving += (_, _) => Follow(session);
        session.View.SetMetrics(host.SafeInsets, host.KeyboardHeight);
        window.ModalPushed += OnModalChanged;
        window.ModalPopped += OnModalChanged;
        window.Destroying += OnWindowDestroying;
        _sessions.Add(session);
        session.View.Render();
        Wake();
    }

    private void AttachAll()
    {
        foreach (Window window in Application.Current?.Windows.OfType<Window>() ?? [])
        {
            Attach(window);
        }
    }

    private void Detach(OverlaySession session)
    {
        ClearSelection(session);
        session.Window.ModalPushed -= OnModalChanged;
        session.Window.ModalPopped -= OnModalChanged;
        session.Window.Destroying -= OnWindowDestroying;
        session.Host.Dispose();
        _sessions.Remove(session);
    }

    private void OnModalChanged(object? sender, EventArgs e)
    {
        if (SessionFor(sender) is not { } session)
        {
            return;
        }

        // A modal page's dialog (Android) shows a moment after the event; look again then.
        foreach (int delay in ModalRefreshDelays)
        {
            session.Window.Dispatcher.DispatchDelayed(TimeSpan.FromMilliseconds(delay), () =>
            {
                session.Host.Refresh();
                session.Resolved.Clear();
                session.Missed.Clear();
                Tick();
            });
        }
    }

    private void OnWindowDestroying(object? sender, EventArgs e)
    {
        if (SessionFor(sender) is { } session)
        {
            Detach(session);
        }
    }

    private OverlaySession? SessionFor(object? window) => _sessions.FirstOrDefault(s => ReferenceEquals(s.Window, window));

    /// <summary>The session of the window <paramref name="element"/> is in, else the first one.</summary>
    private OverlaySession? SessionOf(Element element)
    {
        Window? window = VisualTree.SelfAndAncestors(element).OfType<Window>().FirstOrDefault() ?? (element as VisualElement)?.Window;
        return SessionFor(window) ?? _sessions.FirstOrDefault();
    }
}
