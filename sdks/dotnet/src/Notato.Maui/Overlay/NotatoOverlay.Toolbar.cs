using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Layouts;

namespace Notato.Maui.Overlay;

// The toolbar is dragged anywhere, and remembered as a fraction of the window (see NotatoController.ToolbarFraction).
internal sealed partial class NotatoOverlay
{
    private Point? _dragStart;
    private bool _dragMoved;
    private long _dragEndedAt;
    /// <summary>
    /// Where the toolbar is while it is dragged, as a fraction; saved when the drag ends. Placement reads this, because
    /// the host lays the overlay out again during a drag (on iOS, every frame) and must not put it back mid-drag.
    /// </summary>
    private Point? _dragFraction;
    /// <summary>The bar (and its round button) are moved off their laid-out place by a drag under way.</summary>
    private bool _shifted;

    private const double ToolbarMargin = 12;

    /// <summary>The toolbar's size: the round button's when folded, the animated one while folding or opening.</summary>
    private Size ToolbarSize() => new(BarWidth(), BarHeight);

    private (double MinX, double MinY, double MaxX, double MaxY) ToolbarArea(Size size) => (
        _safe.Left + ToolbarMargin,
        _safe.Top + ToolbarMargin,
        Math.Max(_safe.Left + ToolbarMargin, Width - _safe.Right - ToolbarMargin - size.Width),
        Math.Max(_safe.Top + ToolbarMargin, Height - Math.Max(_safe.Bottom, _keyboard) - ToolbarMargin - size.Height));

    private void PlaceToolbar()
    {
        if (Width <= 0 || Height <= 0)
        {
            return;
        }

        Size size = ToolbarSize();
        (double minX, double minY, double maxX, double maxY) = ToolbarArea(size);
        Point fraction = _dragFraction ?? _controller.ToolbarFraction;
        // Folding or opening, it is placed from its held edge, which stays put, and the width of this very step.
        double x = _morph is { } m
            ? ToolbarFold.LeftFromEdge(m.Edge, size.Width, m.HeldRight)
            : ToolbarFold.PlaceAt(fraction.X, minX, maxX);
        double y = ToolbarFold.PlaceAt(fraction.Y, minY, maxY);
        if (_dragStart is not null && _morph is null && AbsoluteLayout.GetLayoutBounds(_toolbar) is { Width: > 0 } laid && laid.Width == size.Width)
        {
            // Dragged: moved by translation alone, with no layout pass (to which the iOS host answered by laying the
            // whole overlay out again, on every frame of the drag). It is laid out where it is let go.
            ShiftBar(x - laid.X, y - laid.Y);
            bool held = HeldRight();
            SyncChevron(held);
            AnchorRow(held);
            return;
        }

        if (_shifted)
        {
            ShiftBar(0, 0);
        }
#if ANDROID
        if (_morph is { } am)
        {
            // Laid out once, from where its held edge started; the width and the edge then move with no layout pass.
            double laidOut = Math.Max(am.LaidOut, am.Width);
            double left = ToolbarFold.LeftFromEdge(am.Trip.FromEdge, laidOut, am.HeldRight);
            SyncCorner(laidOut);
            AbsoluteLayout.SetLayoutBounds(_toolbar, new Rect(left, y, laidOut, size.Height));
            ShowPill(am.Width, am.HeldRight, am.Edge - am.Trip.FromEdge);
            PlaceFab(x, y, size.Width, am.HeldRight);
            return;
        }
        ShowPill(null, HeldRight(), 0);
#endif
        SyncCorner(size.Width);
        AbsoluteLayout.SetLayoutBounds(_toolbar, new Rect(x, y, size.Width, size.Height));
        bool heldRight = _morph?.HeldRight ?? HeldRight();
        PlaceFab(x, y, size.Width, heldRight);
        if (_morph is not null)
        {
            return;
        }
        // Dragged to the other half, it folds the other way.
        SyncChevron(heldRight);
        AnchorRow(heldRight);
    }

    private void ShiftBar(double dx, double dy)
    {
        _shifted = dx != 0 || dy != 0;
        _toolbar.TranslationX = dx;
        _toolbar.TranslationY = dy;
        _fabFace.TranslationX = dx;
        _fabFace.TranslationY = dy;
    }

    private void OnDrag(object? sender, PanUpdatedEventArgs e)
    {
        switch (e.StatusType)
        {
            case GestureStatus.Started:
                // Folding or opening ends where it was going, so the drag moves the bar as it is about to be.
                SettleFold();
                _dragStart = AbsoluteLayout.GetLayoutBounds(_toolbar).Location;
                _dragMoved = false;
                break;
            case GestureStatus.Running when _dragStart is { } start:
                if (e.TotalX != 0 || e.TotalY != 0)
                {
                    _dragMoved = true;
                }

                (double minX, double minY, double maxX, double maxY) = ToolbarArea(ToolbarSize());
                double x = Math.Clamp(start.X + e.TotalX, minX, maxX);
                double y = Math.Clamp(start.Y + e.TotalY, minY, maxY);
                _dragFraction = new Point(maxX > minX ? (x - minX) / (maxX - minX) : 1, maxY > minY ? (y - minY) / (maxY - minY) : 1);
                PlaceToolbar();
                break;
            case GestureStatus.Completed or GestureStatus.Canceled when _dragStart is not null:
                _dragStart = null;
                if (_dragFraction is { } fraction)
                {
                    _controller.ToolbarFraction = fraction;
                }

                if (_dragMoved)
                {
                    _dragEndedAt = Environment.TickCount64;
                    // Somewhere new: the side it folds to is worked out again from here.
                    _controller.ToolbarMoved();
                }
                _dragFraction = null;
                PlaceToolbar();
                break;
        }
    }
}
