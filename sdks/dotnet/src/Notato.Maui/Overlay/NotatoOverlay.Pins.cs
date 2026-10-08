using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Overlay;

// The pins: each note's number on its element, moved as the page scrolls and drawn again only when it changes.
internal sealed partial class NotatoOverlay
{
    private readonly Dictionary<string, Border> _pinViews = [];
    /// <summary>What each pin was last drawn as, and where: a pin that has not changed or moved is left alone.</summary>
    private readonly Dictionary<string, (PinPlacement Placement, Point At)> _pinShown = [];
    /// <summary>The pins last asked for, and the room they were laid out in.</summary>
    private IReadOnlyList<PinPlacement> _pinsAsked = [];
    private (double Width, double Height, double Top) _pinRoom;

    private const double PinSize = PinLayout.Diameter;

    /// <summary>
    /// Puts the pins where they go. Called often (the controller looks a few times a second, for scrolling): when no pin
    /// moved or changed and the overlay is the same size, nothing is touched; otherwise only the pins that moved or
    /// changed are.
    /// </summary>
    public void ShowPins(IReadOnlyList<PinPlacement> placements)
    {
        (double, double, double) room = (Width, Height, _safe.Top);
        if (room == _pinRoom && placements.SequenceEqual(_pinsAsked))
        {
            return;
        }

        _pinsAsked = placements;
        _pinRoom = room;
        HashSet<string> keep = [];
        List<Point> taken = [];
        foreach (PinPlacement p in placements)
        {
            keep.Add(p.Id);
            // Several notes on one element: side by side, not on top of each other.
            Point at = PinLayout.Place(p.Rect, taken, new Size(Width, Height), _safe.Top);
            taken.Add(at);
            bool known = _pinShown.TryGetValue(p.Id, out (PinPlacement Placement, Point At) shown);
            if (!_pinViews.TryGetValue(p.Id, out Border? view))
            {
                view = NewPin(p.Id);
                _pinViews[p.Id] = view;
                _pins.Children.Add(view);
            }

            if (!known || !SameLook(shown.Placement, p))
            {
                StylePin(view, p);
            }

            if (!known || shown.At != at)
            {
                AbsoluteLayout.SetLayoutBounds(view, new Rect(at.X, at.Y, PinSize, PinSize));
            }

            _pinShown[p.Id] = (p, at);
        }
        if (_pinViews.Count == keep.Count)
        {
            return;
        }

        foreach (string gone in _pinViews.Keys.Where(k => !keep.Contains(k)).ToList())
        {
            _pins.Children.Remove(_pinViews[gone]);
            _pinViews.Remove(gone);
            _pinShown.Remove(gone);
        }
    }

    private static bool SameLook(PinPlacement a, PinPlacement b) =>
        a.Number == b.Number && a.Status == b.Status && a.Detached == b.Detached && a.Pending == b.Pending;

    private Border NewPin(string id)
    {
        // A 24 circle in its status colour, in a 2 white ring.
        Border view = Ui.Box(Ui.Text("", 12, Colors.White, bold: true, maxLines: 1), Ui.Accent, 12, new Thickness(0), Colors.White, 2);
        view.WidthRequest = PinSize;
        view.HeightRequest = PinSize;
        Label label = (Label)view.Content!;
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
        view.Shadow = new Shadow { Brush = new SolidColorBrush(Colors.Black), Opacity = 0.3f, Radius = 6, Offset = new Point(0, 2) };
        Ui.OnTap(view, () => _controller.OpenPin(_session, id));
        return view;
    }

    private static void StylePin(Border view, PinPlacement p)
    {
        ((Label)view.Content!).Text = p.Number.ToString(CultureInfo.InvariantCulture);
        Color color = Ui.StatusColor(p.Status);
        view.BackgroundColor = color;
        view.Background = new SolidColorBrush(color);
        view.Opacity = p.Detached ? 0.55 : 1;
        view.Stroke = new SolidColorBrush(p.Pending ? Ui.Connecting : Colors.White);
        SemanticProperties.SetDescription(view, $"Note {p.Number}, {Ui.Humanize(p.Status)}");
    }
}
