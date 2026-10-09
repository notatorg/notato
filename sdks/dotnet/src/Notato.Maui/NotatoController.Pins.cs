using Microsoft.Maui.Controls;
using Microsoft.Maui.Dispatching;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;

namespace Notato.Maui;

// The overlay's rhythm. While the app may be moving (a touch on it, a view scrolling) the pins and the selection follow
// their elements frame by frame. Otherwise a look now and then catches what moved on its own: often just after a
// change, less often once nothing moves, and not at all while nothing is selected and no pin is on screen. A page
// appearing, a modal page, or anything the overlay shows changing (see RaiseChanged) wakes it.
internal sealed partial class NotatoController
{
    /// <summary>How soon the next look is, just after something moved or changed.</summary>
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(150);

    /// <summary>How soon it is once <see cref="QuietTicks"/> looks in a row found nothing moved.</summary>
    private static readonly TimeSpan IdleInterval = TimeSpan.FromMilliseconds(600);

    private const int QuietTicks = 4;

    /// <summary>The window on top is looked for again every this many ticks (a modal page's dialog, on Android).</summary>
    private const int HostRefreshTicks = 4;

    /// <summary>
    /// How long to wait before looking again for an element that was not on screen, besides when the screen or the
    /// notes change: searching for one that is not there is the costly case.
    /// </summary>
    private const long MissedRetryMs = 3000;

    /// <summary>Following frame by frame stops once nothing has moved for this long.</summary>
    private const long FollowStillMs = 600;

    /// <summary>The look planned next: its number (a newer plan replaces it), and when it is due.</summary>
    private int _tickPlan;
    private long? _tickDue;
    private int _quietTicks;

    /// <summary>Plans a look soon: something changed, or may have moved.</summary>
    private void Wake()
    {
        _quietTicks = 0;
        PlanTick(TickInterval);
    }

    private void PlanTick(TimeSpan wait)
    {
        if (!_enabled || _sessions.Count == 0)
        {
            return;
        }

        long due = Environment.TickCount64 + (long)wait.TotalMilliseconds;
        // One is planned already, as soon or sooner.
        if (_tickDue is { } planned && planned <= due)
        {
            return;
        }

        int plan = ++_tickPlan;
        _tickDue = due;
        _sessions[0].Window.Dispatcher.DispatchDelayed(wait, () =>
        {
            if (plan == _tickPlan)
            {
                _tickDue = null;
                Tick();
            }
        });
    }

    /// <summary>No more looks until something wakes them.</summary>
    private void StopTicks()
    {
        _tickPlan++;
        _tickDue = null;
    }

    private void Tick()
    {
        bool moved = false, needed = false;
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
                moved = true;
            }

            // New notes, or changed ones: the pins not found are looked for again now, not at their next try.
            if (session.NotesVersion != _records.Version)
            {
                session.NotesVersion = _records.Version;
                session.Missed.Clear();
            }

            // The tree is searched for pins not found only while the app is still.
            if (Place(session, search: !session.Following))
            {
                moved = true;
                // Moving on its own (an animation, a scroll the app made): followed frame by frame until it stops.
                Follow(session);
            }

            needed |= HasWork(session);
        }

        if (!needed)
        {
            return;
        }

        _quietTicks = moved ? 0 : _quietTicks + 1;
        PlanTick(_quietTicks >= QuietTicks ? IdleInterval : TickInterval);
    }

    /// <summary>Whether there is anything to follow in the session: a selection, or a pin on its screen.</summary>
    private bool HasWork(OverlaySession session) =>
        session.Selection is not null || (PinsVisible && _records.PinnedOn(RouteOf(session)).Count > 0);

    /// <summary>
    /// Puts the session's selection and pins where their elements are now. With <paramref name="search"/>, the pins
    /// whose elements are not known are looked for in the tree (when due). Returns whether anything moved.
    /// </summary>
    private bool Place(OverlaySession session, bool search)
    {
        bool moved = false;
        if (session.Selection is { } selection)
        {
            moved |= session.View.MoveSelection(SelectionRects(session, selection));
        }

        if (PinsVisible)
        {
            // Drawn again only where something moved or changed (see ShowPins).
            moved |= session.View.ShowPins(Placements(session, search));
        }

        return moved;
    }

    /// <summary>
    /// What the app shows may be moving: the pins and the selection follow it on every frame, until nothing has moved
    /// for <see cref="FollowStillMs"/>. Then the timer takes over again.
    /// </summary>
    private void Follow(OverlaySession session)
    {
        session.MovedAt = Environment.TickCount64;
        if (session.Following || !_enabled || !HasWork(session))
        {
            return;
        }

        session.Following = true;
        session.Host.EveryFrame(() =>
        {
            if (!_enabled || !_sessions.Contains(session))
            {
                session.Following = false;
                return false;
            }

            long now = Environment.TickCount64;
            if (Place(session, search: false))
            {
                session.MovedAt = now;
            }

            if (now - session.MovedAt < FollowStillMs)
            {
                return true;
            }

            session.Following = false;
            // Still again: a look now finds the pins whose elements came into view.
            Wake();
            return false;
        });
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
    /// put on it where it is now (a cheap look per pin); with <paramref name="search"/>, the ones whose element is not
    /// are looked for together, in one walk of the tree (see <see cref="LookFor"/>).
    /// </summary>
    private List<PinPlacement> Placements(OverlaySession session, bool search)
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

        if (search && missing.Count > 0)
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
    /// walk of what the window shows. Each is looked for again after <see cref="MissedRetryMs"/>, or as soon as the
    /// screen or the notes change. Inside a list, an element must show the note's text to be taken.
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
