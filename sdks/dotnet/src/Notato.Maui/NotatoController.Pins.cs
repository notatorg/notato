using Microsoft.Maui.Controls;
using Microsoft.Maui.Dispatching;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;

namespace Notato.Maui;

// The overlay's rhythm: a few times a second each window's screen is checked, and its pins follow their elements.
internal sealed partial class NotatoController
{
    /// <summary>How often the pins and the selection are put where their elements are now.</summary>
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(150);

    /// <summary>The window on top is looked for again every this many ticks (a modal page's dialog, on Android).</summary>
    private const int HostRefreshTicks = 4;

    /// <summary>
    /// How long to wait before looking again for an element that was not on screen: searching for one that is not
    /// there is the costly case.
    /// </summary>
    private const long MissedRetryMs = 900;

    private IDispatcherTimer? _timer;

    private void EnsureTimer()
    {
        if (!_enabled || _sessions.Count == 0)
        {
            return;
        }

        if (_timer is null)
        {
            _timer = _sessions[0].Window.Dispatcher.CreateTimer();
            _timer.Interval = TickInterval;
            _timer.Tick += (_, _) => Tick();
        }

        if (!_timer.IsRunning)
        {
            _timer.Start();
        }
    }

    private void Tick()
    {
        foreach (OverlaySession session in _sessions.ToList())
        {
            session.Ticks++;
            if (session.Ticks % HostRefreshTicks == 0)
            {
                session.Host.Refresh();
            }

            string route = SafeRoute(session.Window);
            if (route != session.Route)
            {
                session.Route = route;
                session.Resolved.Clear();
                session.Missed.Clear();
                session.View.Render();
            }

            if (PinsVisible)
            {
                // Drawn again only where something moved or changed (see ShowPins).
                session.View.ShowPins(Placements(session));
            }

            if (session.Selection is { } selection)
            {
                session.View.ShowSelection(Describe(session, selection));
            }
        }
    }

    private static string SafeRoute(Window window)
    {
        try
        {
            return AppContextInfo.RouteOf(window).Route;
        }
        catch
        {
            return "/";
        }
    }

    private string RouteOf(OverlaySession session) => session.Route.Length > 0 ? session.Route : SafeRoute(session.Window);

    /// <summary>The notes on the session's screen, oldest first, numbered as their pins are.</summary>
    internal IReadOnlyList<(int Number, NoteRecord Record)> RecordsOnRoute(OverlaySession session) => _records.On(RouteOf(session));

    internal int CountOnRoute(OverlaySession session) => RecordsOnRoute(session).Count;

    /// <summary>
    /// Where each pin on the session's screen goes now. Only notes made with this SDK get one (see
    /// <see cref="RecordSet.PinnedOn"/>), the newest <see cref="RecordSet.MaxPins"/>. A pin whose element is known is
    /// put on it where it is now (a cheap look per pin); the ones whose element is not are looked for together, in one
    /// walk of the tree, about once a second.
    /// </summary>
    private List<PinPlacement> Placements(OverlaySession session)
    {
        IReadOnlyList<(int Number, NoteRecord Record)> shown = _records.PinnedOn(RouteOf(session));
        IElementGeometry geometry = session.Host.Geometry;
        bool mask = Options.ResolvedMaskInputs;
        Rect?[] rects = new Rect?[shown.Count];
        List<int> missing = [];
        for (int i = 0; i < shown.Count; i++)
        {
            rects[i] = KnownBounds(session, shown[i].Record, geometry, mask);
            if (rects[i] is null)
            {
                missing.Add(i);
            }
        }

        if (missing.Count > 0)
        {
            LookFor(session, shown, missing, rects, geometry, mask);
        }

        List<PinPlacement> list = new(shown.Count);
        for (int i = 0; i < shown.Count; i++)
        {
            (int number, NoteRecord record) = shown[i];
            Annotation a = record.Annotation;
            PageRect stored = a.Target.Rect;
            list.Add(new PinPlacement(a.Id, number, a.Status, rects[i] ?? new Rect(stored.X, stored.Y, stored.W, stored.H), rects[i] is null, record.Pending));
        }

        return list;
    }

    /// <summary>Where the note's element is now, when it is already known and still shows the note; null otherwise.</summary>
    private static Rect? KnownBounds(OverlaySession session, NoteRecord record, IElementGeometry geometry, bool mask)
    {
        ElementIdentity? identity = record.Annotation.Target.Identity.FirstOrDefault();
        if (record.Element is { } made)
        {
            if (Bounds(made, identity, geometry, mask) is { } rect)
            {
                return rect;
            }

            if (!made.Element.TryGetTarget(out VisualElement? element) || !made.StillShows(element, identity, mask))
            {
                // Gone, or a list's row that now shows another item: the pin is looked for by its selector instead.
                record.Element = null;
            }
        }

        if (session.Resolved.TryGetValue(record.Annotation.Id, out PinTarget? found))
        {
            if (Bounds(found, identity, geometry, mask) is { } rect)
            {
                return rect;
            }

            session.Resolved.Remove(record.Annotation.Id);
        }

        return null;
    }

    private static Rect? Bounds(PinTarget target, ElementIdentity? identity, IElementGeometry geometry, bool mask) =>
        target.Element.TryGetTarget(out VisualElement? element) && geometry.BoundsOf(element) is { } rect && target.StillShows(element, identity, mask)
            ? rect
            : null;

    /// <summary>
    /// Looks for the elements of the pins in <paramref name="missing"/> whose time to look again has come, all in one
    /// walk of what the window shows. Each is looked for about once a second at most (<see cref="MissedRetryMs"/>).
    /// Inside a list, an element must show the note's text to be taken.
    /// </summary>
    private static void LookFor(OverlaySession session, IReadOnlyList<(int Number, NoteRecord Record)> shown, List<int> missing, Rect?[] rects, IElementGeometry geometry, bool mask)
    {
        long now = Environment.TickCount64;
        List<int> due = [];
        List<IReadOnlyList<Selectors.Step>> selectors = [];
        foreach (int i in missing)
        {
            string id = shown[i].Record.Annotation.Id;
            if (session.Missed.TryGetValue(id, out long until) && now < until)
            {
                continue;
            }

            session.Missed[id] = now + MissedRetryMs;
            // A selector that is not a MAUI one (a newer SDK's) is never found: the stored rectangle will do.
            if (shown[i].Record.Annotation.Target.Identity.FirstOrDefault()?.Selector is { } selector && Selectors.TryParseCached(selector) is { Count: > 0 } steps)
            {
                due.Add(i);
                selectors.Add(steps);
            }
        }

        if (due.Count == 0)
        {
            return;
        }

        bool Takes(int index, Element element)
        {
            if (element is not VisualElement visual || geometry.BoundsOf(visual) is null)
            {
                return false;
            }

            ElementIdentity? identity = shown[due[index]].Record.Annotation.Target.Identity.FirstOrDefault();
            return identity?.Text is not { } text || !VisualTree.InList(visual) || ElementText.Visible(visual, mask) == text;
        }

        foreach (Element root in VisualTree.VisibleRoots(session.Window))
        {
            Element?[] found = Selectors.QueryFirst(root, selectors, mask, Takes);
            for (int k = 0; k < due.Count; k++)
            {
                if (found[k] is not VisualElement element || rects[due[k]] is not null)
                {
                    continue;
                }

                string id = shown[due[k]].Record.Annotation.Id;
                session.Resolved[id] = new PinTarget(element);
                session.Missed.Remove(id);
                rects[due[k]] = geometry.BoundsOf(element);
            }
        }
    }
}
