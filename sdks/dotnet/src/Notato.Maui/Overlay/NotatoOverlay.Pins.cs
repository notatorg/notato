using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Overlay;

// The pins: each note's number on its element, moved as the page scrolls and drawn again only when it changes. A pin
// is laid out once, at the corner, and moved by translation, so following a scroll needs no layout pass. New pins grow
// in and gone ones shrink away, unless a whole screen's worth come or go at once.
internal sealed partial class NotatoOverlay
{
    private readonly Dictionary<string, Border> _pinViews = [];
    /// <summary>What each pin was last drawn as, and where: a pin that has not changed or moved is left alone.</summary>
    private readonly Dictionary<string, (PinPlacement Placement, Point At)> _pinShown = [];
    /// <summary>The pins last asked for, and the room they were laid out in.</summary>
    private IReadOnlyList<PinPlacement> _pinsAsked = [];
    private (double Width, double Height, double Top) _pinRoom;

    private const double PinSize = PinLayout.Diameter;
    private const string PinAnimation = "NotatoPin";
    /// <summary>More pins than this coming (or going) at once, a new screen's, simply appear (or go).</summary>
    private const int PinsAnimatedAtOnce = 12;
    /// <summary>How small a pin is as it grows in, and as it shrinks away.</summary>
    private const double PinSmall = 0.4;

    /// <summary>
    /// Puts the pins where they go. Called often (on every frame while the app may be moving): when no pin moved or
    /// changed and the overlay is the same size, nothing is touched; otherwise only the pins that moved or changed are.
    /// Returns whether anything was.
    /// </summary>
    public bool ShowPins(IReadOnlyList<PinPlacement> placements)
    {
        (double, double, double) room = (Width, Height, _safe.Top);
        if (room == _pinRoom && placements.SequenceEqual(_pinsAsked))
        {
            return false;
        }

        _pinsAsked = placements;
        _pinRoom = room;
        bool pop = Animates && placements.Count(p => !_pinViews.ContainsKey(p.Id)) <= PinsAnimatedAtOnce;
        HashSet<string> keep = [];
        List<Point> taken = [];
        foreach (PinPlacement p in placements)
        {
            keep.Add(p.Id);
            // Several notes on one element: side by side, not on top of each other.
            Point at = PinLayout.Place(p.Rect, taken, new Size(Width, Height), _safe.Top);
            taken.Add(at);
            bool known = _pinShown.TryGetValue(p.Id, out (PinPlacement Placement, Point At) shown);
            bool added = false;
            if (!_pinViews.TryGetValue(p.Id, out Border? view))
            {
                view = NewPin(p.Id);
                _pinViews[p.Id] = view;
                _pins.Children.Add(view);
                added = true;
            }

            if (!known || !SameLook(shown.Placement, p))
            {
                StylePin(view, p);
            }

            if (!known || shown.At != at)
            {
                view.TranslationX = at.X;
                view.TranslationY = at.Y;
            }

            _pinShown[p.Id] = (p, at);
            if (added && pop)
            {
                PopIn(view, p.Id);
            }
        }
        if (_pinViews.Count == keep.Count)
        {
            return true;
        }

        List<string> gone = [.. _pinViews.Keys.Where(k => !keep.Contains(k))];
        bool shrink = Animates && gone.Count <= PinsAnimatedAtOnce;
        foreach (string id in gone)
        {
            Border view = _pinViews[id];
            _pinViews.Remove(id);
            _pinShown.Remove(id);
            if (shrink)
            {
                PopOut(view);
            }
            else
            {
                _pins.Children.Remove(view);
            }
        }

        return true;
    }

    private static bool SameLook(PinPlacement a, PinPlacement b) =>
        a.Number == b.Number && a.Status == b.Status && a.Detached == b.Detached && a.Pending == b.Pending;

    private Border NewPin(string id)
    {
        // A 24 circle in its status colour, in a 2 ring: white, with a soft shadow under it. Android draws a MAUI shadow
        // as a blurred bitmap in a view of its own, one per pin: there the ring is a darker shade of the pin's colour
        // instead, which keeps its edge on a light screen.
        Border view = Ui.Box(Ui.Text("", 12, Colors.White, bold: true, maxLines: 1), Ui.Accent, 12, new Thickness(0), Colors.White, 2);
        view.WidthRequest = PinSize;
        view.HeightRequest = PinSize;
        // Laid out once at the corner; ShowPins moves it.
        AbsoluteLayout.SetLayoutBounds(view, new Rect(0, 0, PinSize, PinSize));
        Label label = (Label)view.Content!;
        label.HorizontalOptions = LayoutOptions.Center;
        label.VerticalOptions = LayoutOptions.Center;
        label.HorizontalTextAlignment = TextAlignment.Center;
#if !ANDROID
        view.Shadow = new Shadow { Brush = new SolidColorBrush(Colors.Black), Opacity = 0.3f, Radius = 6, Offset = new Point(0, 2) };
#endif
        Ui.OnTap(view, () => _controller.OpenPin(_session, id));
        return view;
    }

    /// <summary>A pin away from its element (not on screen) is faint.</summary>
    private static double PinOpacity(PinPlacement p) => p.Detached ? 0.55 : 1;

    private static void StylePin(Border view, PinPlacement p)
    {
        ((Label)view.Content!).Text = p.Number.ToString(CultureInfo.InvariantCulture);
        Color color = Ui.StatusColor(p.Status);
        view.BackgroundColor = color;
        view.Background = new SolidColorBrush(color);
        // Growing in, it gets there on its own.
        if (!view.AnimationIsRunning(PinAnimation))
        {
            view.Opacity = PinOpacity(p);
        }
#if ANDROID
        Color ring = color.WithLuminosity(color.GetLuminosity() * 0.62f);
#else
        Color ring = Colors.White;
#endif
        view.Stroke = new SolidColorBrush(p.Pending ? Ui.Connecting : ring);
        SemanticProperties.SetDescription(view, $"Note {p.Number}, {Ui.Humanize(p.Status)}");
    }

    /// <summary>A new pin grows in from its middle as it fades in.</summary>
    private void PopIn(Border view, string id)
    {
        view.Opacity = 0;
        view.Scale = PinSmall;
        new Animation(t =>
        {
            view.Scale = PinSmall + ((1 - PinSmall) * t);
            // Its opacity as it is now: a pin can turn faint (or not) while it grows.
            view.Opacity = (_pinShown.TryGetValue(id, out (PinPlacement Placement, Point At) shown) ? PinOpacity(shown.Placement) : 1) * t;
        }).Commit(view, PinAnimation, 16, RevealInMs, Easing.CubicOut);
    }

    /// <summary>A pin whose note is gone (or on another screen) shrinks away, out of reach of taps, then leaves.</summary>
    private void PopOut(Border view)
    {
        view.InputTransparent = true;
        (double opacity, double scale) = (view.Opacity, view.Scale);
        new Animation(t =>
        {
            view.Opacity = opacity * (1 - t);
            view.Scale = scale + ((PinSmall - scale) * t);
        }).Commit(view, PinAnimation, 16, RevealOutMs, Easing.CubicIn, (_, _) => _pins.Children.Remove(view));
    }
}
