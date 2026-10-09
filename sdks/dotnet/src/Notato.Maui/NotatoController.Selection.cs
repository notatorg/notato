using Microsoft.Extensions.Logging;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using Notato.Maui.Native;
using Notato.Maui.Overlay;

namespace Notato.Maui;

// Selecting what a note is about: a tap while annotating, SelectAsync from the app, or Parent to widen the selection.
// The outline and the note being written come up at once; the window's picture is taken as soon as they have, so the
// note shows the screen as it was then, and taking it never holds them up.
internal sealed partial class NotatoController
{
    /// <summary>How much of an element's text its selection's title quotes.</summary>
    private const int TitleTextLength = 28;

    /// <summary>A tap on the pick surface while annotating: selects what is under it.</summary>
    /// <remarks>An event handler, so <c>async void</c>: it reports its own failures.</remarks>
    internal async void OnPick(OverlaySession session, Point point)
    {
        try
        {
            VisualElement? element = VisualTree.HitTest(session.Window, point, session.Host.Geometry, Ignored);
            if (element is null)
            {
                session.View.Toast("Nothing of the app is there.");
                return;
            }

            if (session.Selection is { } existing)
            {
                existing.Elements = [element];
                Select(session, existing);
                return;
            }

            await SelectNewAsync(session, element);
        }
        catch (Exception error)
        {
            _logger.LogError(error, "Notato could not select that element");
            session.View.Toast("Could not select that: " + error.Message);
        }
    }

    /// <summary>Marked <c>notato:Feedback.Ignore="True"</c>: the picker looks through it.</summary>
    private static bool Ignored(Element element) => Feedback.GetIgnore(element);

    public async Task SelectAsync(VisualElement element)
    {
        await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            OverlaySession session = SessionForCode(element);
            _annotating = true;
            await SelectNewAsync(session, element);
        });
    }

    /// <summary>
    /// Selects <paramref name="element"/> in place of what was selected, and takes the window's picture for it once the
    /// note being written has come in: iOS's overlay is a window of its own, and Android draws the app without it, so
    /// the picture never has the overlay in it. Done when the picture is taken; Send waits for it too.
    /// </summary>
    private async Task SelectNewAsync(OverlaySession session, VisualElement element)
    {
        ClearSelection(session);
        SelectionState selection = new([element], null);
        Select(session, selection);
        Task arrived = session.View.SheetArrived;
        if (!ScreenshotsOn)
        {
            await arrived;
            FocusComment();
            return;
        }

        selection.Taking = TakeAsync();
        await selection.Taking;
        FocusComment();

        // The keyboard comes up for the note only once the picture is taken: opening it can move the app under it.
        void FocusComment()
        {
            if (ReferenceEquals(session.Selection, selection))
            {
                session.View.Composer?.FocusComment();
            }
        }

        async Task TakeAsync()
        {
            await arrived;
            // Cancelled, or replaced, while the note came in: no picture is wanted.
            if (ReferenceEquals(session.Selection, selection))
            {
                selection.Receive(await CaptureAsync(session));
            }
        }
    }

    /// <summary>The session an element the app's code names is in. Throws, with what to do, when there is none.</summary>
    private OverlaySession SessionForCode(VisualElement element)
    {
        if (!_enabled)
        {
            throw new InvalidOperationException("Notato is off. Call Enable() first.");
        }

        return SessionOf(element) ?? throw new InvalidOperationException("That element is not in a window Notato is in.");
    }

    /// <summary>
    /// A picture of the window, when screenshots are on, with what to cover in it measured in the same moment: every
    /// private element on every page the picture shows. Without its covers there is no picture.
    /// </summary>
    private async Task<CapturedScreen?> CaptureAsync(OverlaySession session)
    {
        if (!ScreenshotsOn)
        {
            return null;
        }

        bool maskInputs = Options.ResolvedMaskInputs;
        try
        {
            return await session.Host.CaptureAsync(() => Privacy.MaskRects(VisualTree.AllRoots(session.Window), session.Host.Geometry, maskInputs));
        }
        catch (Exception error)
        {
            _logger.LogWarning(error, "Notato could not take the screenshot; the note goes without one");
            return null;
        }
    }

    private void Select(OverlaySession session, SelectionState selection)
    {
        session.Selection = selection;
        SelectionView view = Describe(session, selection);
        session.View.ShowSelection(view);
        session.View.OpenComposer(view, screenshotsOff: !ScreenshotsOn);
        RenderAll();
    }

    /// <summary>
    /// The selection as the overlay shows it: its outlines, and a title such as <c>Button “Sign in”</c>. Worked out once
    /// per selection; after that only its outlines are looked at (<see cref="SelectionRects"/>).
    /// </summary>
    private SelectionView Describe(OverlaySession session, SelectionState selection)
    {
        List<Rect> rects = SelectionRects(session, selection);
        VisualElement first = selection.Elements[0];
        string title = Selectors.Segment(first, withPosition: false);
        if (first is not Page && ElementText.Clip(ElementText.Visible(first, Options.ResolvedMaskInputs), TitleTextLength) is { } text)
        {
            title += $" “{text}”";
        }

        SourceLocation? where = _inspector.Sources.Locate(first);
        Page? page = VisualTree.PageOf(first);
        string subtitle = string.Join(" · ", new[]
        {
            page is null || ReferenceEquals(page, first) ? null : "in " + VisualTree.TypeName(page.GetType()),
            where is null ? null : $"{Path.GetFileName(where.File)}:{where.Line}",
        }.OfType<string>());
        return new SelectionView(rects, title, subtitle.Length == 0 ? null : subtitle);
    }

    /// <summary>Where the selected elements are on screen now.</summary>
    private static List<Rect> SelectionRects(OverlaySession session, SelectionState selection) =>
        [.. selection.Elements.Select(e => session.Host.Geometry.BoundsOf(e)).OfType<Rect>()];

    /// <summary>Parent: the selection widens to the nearest element around it that is drawn.</summary>
    internal void SelectParent(OverlaySession session)
    {
        if (session.Selection is not { } selection)
        {
            return;
        }

        IElementGeometry geometry = session.Host.Geometry;
        foreach (VisualElement parent in VisualTree.SelfAndAncestors(selection.Elements[0]).Skip(1).OfType<VisualElement>())
        {
            if (parent.Handler is null || geometry.BoundsOf(parent) is null)
            {
                continue;
            }

            selection.Elements = [parent];
            Select(session, selection);
            return;
        }

        session.View.Toast("That is the whole page.");
    }

    internal void CancelSelection(OverlaySession session)
    {
        ClearSelection(session);
        session.View.ShowSelection(null);
        _annotating = false;
        RenderAll();
    }

    /// <summary>The session's selection goes, and the picture taken for it with it.</summary>
    private static void ClearSelection(OverlaySession session)
    {
        session.Selection?.Dispose();
        session.Selection = null;
    }

    /// <summary>The first element on screen that the selector matches, in any window.</summary>
    /// <exception cref="FormatException">The selector cannot be read.</exception>
    private VisualElement? Find(string selector)
    {
        bool mask = Options.ResolvedMaskInputs;
        foreach (OverlaySession session in _sessions)
        {
            foreach (Element root in VisualTree.VisibleRoots(session.Window))
            {
                VisualElement? found = Selectors.Query(root, selector, mask).OfType<VisualElement>().FirstOrDefault(e => session.Host.Geometry.BoundsOf(e) is not null);
                if (found is not null)
                {
                    return found;
                }
            }
        }

        return null;
    }
}
