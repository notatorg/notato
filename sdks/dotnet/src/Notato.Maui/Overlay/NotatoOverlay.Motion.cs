using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

namespace Notato.Maui.Overlay;

// Comings and goings, as the Flutter SDK has them: a sheet slides up out of the bottom as the app dims behind it, the
// toast and the hint drop in from the top, the selection and the pins fade in, the toolbar shrinks away while a note is
// written, and each goes the way it came. A change of mind turns an animation around from where it is on screen. With
// Reduce Motion on (or before the overlay has a native view, as in the tests) nothing animates: things appear and go.
internal sealed partial class NotatoOverlay
{
    /// <summary>A sheet coming in, and the app dimming behind it; going is a little quicker.</summary>
    private const uint SheetInMs = 220;
    private const uint SheetOutMs = 180;
    /// <summary>The toast, the hint, the selection, the pins and the toolbar.</summary>
    private const uint RevealInMs = 200;
    private const uint RevealOutMs = 150;
    private const string SheetAnimation = "NotatoSheet";
    private const string RevealAnimation = "NotatoReveal";

    /// <summary>What each view that comes and goes was last asked to do (show or hide), and that ask's number.</summary>
    private readonly Dictionary<VisualElement, (bool Shown, int Run)> _reveals = [];

    /// <summary>Whether comings and goings animate: the overlay is on screen, and Reduce Motion is off.</summary>
    private bool Animates => Handler?.MauiContext is not null && !ReduceMotion();

    /// <summary>
    /// Shows or hides <paramref name="view"/>: it fades, slides by <paramref name="dy"/> and grows from
    /// <paramref name="scale"/> (about <paramref name="anchor"/>, a fraction of its size) as it comes, and goes back
    /// the same way. Asking for what it is already doing does nothing; the first ask for a view is applied at once.
    /// </summary>
    private void Reveal(VisualElement view, bool show, double dy = 0, double scale = 1, Point? anchor = null)
    {
        bool known = _reveals.TryGetValue(view, out (bool Shown, int Run) last);
        if (known && last.Shown == show)
        {
            return;
        }

        int run = last.Run + 1;
        _reveals[view] = (show, run);
        view.AbortAnimation(RevealAnimation);
        if (!known || !Animates)
        {
            SettleReveal(view, show);
            return;
        }

        if (anchor is { } a)
        {
            view.AnchorX = a.X;
            view.AnchorY = a.Y;
        }

        if (show && !view.IsVisible)
        {
            view.Opacity = 0;
            view.TranslationY = dy;
            view.Scale = scale;
            view.IsVisible = true;
        }

        // From wherever it is now: going, then asked back, it turns around mid-way.
        (double opacity, double y, double size) = (view.Opacity, view.TranslationY, view.Scale);
        (double toOpacity, double toY, double toSize) = show ? (1d, 0d, 1d) : (0d, dy, scale);
        new Animation(t =>
        {
            view.Opacity = Math.Clamp(opacity + ((toOpacity - opacity) * t), 0, 1);
            view.TranslationY = y + ((toY - y) * t);
            view.Scale = size + ((toSize - size) * t);
        }).Commit(view, RevealAnimation, 16, show ? RevealInMs : RevealOutMs, show ? Easing.CubicOut : Easing.CubicIn, (_, _) =>
        {
            // A newer ask has taken over.
            if (_reveals.TryGetValue(view, out (bool Shown, int Run) now) && now.Run == run)
            {
                SettleReveal(view, show);
            }
        });
    }

    /// <summary>Whether <paramref name="view"/> was last asked to show (true for one never asked: it shows as built).</summary>
    private bool Revealed(VisualElement view) => !_reveals.TryGetValue(view, out (bool Shown, int Run) last) || last.Shown;

    private static void SettleReveal(VisualElement view, bool show)
    {
        view.IsVisible = show;
        view.Opacity = 1;
        view.TranslationY = 0;
        view.Scale = 1;
    }

    // ---- the sheet ------------------------------------------------------------------------------------------------

    private int _sheetRun;
    /// <summary>Done when the sheet coming in has arrived: the window's picture waits for it (see <see cref="SheetArrived"/>).</summary>
    private TaskCompletionSource? _sheetArriving;

    /// <summary>Done once the sheet showing has finished coming in (at once when nothing is coming in).</summary>
    public Task SheetArrived => _sheetArriving?.Task ?? Task.CompletedTask;

    /// <summary>
    /// How far the sheet travels to be out of sight: its height and the margin below it, or above it for the note being
    /// written at the top.
    /// </summary>
    private double SheetTravel()
    {
        double height = _sheetHost.IsVisible && _sheetHost.Height > 0 ? _sheetHost.Height : _sheetMeasured;
        if (height <= 0 && _sheetHost.Content is IView sheet && Width > 0)
        {
            Thickness margin = _sheetHost.Margin;
            height = sheet.Measure(Math.Min(_sheetHost.MaximumWidthRequest, Width - margin.Left - margin.Right), double.PositiveInfinity).Height;
        }

        height = Math.Max(height, 120);
        return _sheetHost.VerticalOptions.Alignment == LayoutAlignment.Start
            ? -(height + _sheetHost.Margin.Top)
            : height + _sheetHost.Margin.Bottom;
    }

    /// <summary>
    /// Brings the sheet in (from wherever it is: out of sight, or part-way out) or sends it away, the backdrop fading
    /// with it. Gone, it leaves the host empty. A newer move takes over from an older one.
    /// </summary>
    private void MoveSheet(bool show, bool dim)
    {
        int run = ++_sheetRun;
        this.AbortAnimation(SheetAnimation);
        _sheetArriving?.TrySetResult();
        _sheetArriving = null;
        bool already = show && _sheetHost.IsVisible && _sheetHost.Opacity >= 1 && _sheetHost.TranslationY == 0 && _backdrop.IsVisible == dim
            && (!dim || _backdrop.Opacity >= 1);
        if (!Animates || already || (!show && !_sheetHost.IsVisible))
        {
            SettleSheet(show, dim);
            return;
        }

        if (show && !_sheetHost.IsVisible)
        {
            _sheetHost.Opacity = 0;
            _sheetHost.TranslationY = SheetTravel();
            _sheetHost.IsVisible = true;
        }

        if (show && dim && !_backdrop.IsVisible)
        {
            _backdrop.Opacity = 0;
            _backdrop.IsVisible = true;
        }

        (double opacity, double y, double shade) = (_sheetHost.Opacity, _sheetHost.TranslationY, _backdrop.IsVisible ? _backdrop.Opacity : 0);
        (double toOpacity, double toY, double toShade) = show ? (1d, 0d, dim ? 1d : 0d) : (0d, SheetTravel(), 0d);
        TaskCompletionSource? arriving = show ? _sheetArriving = new TaskCompletionSource() : null;
        new Animation(t =>
        {
            _sheetHost.Opacity = Math.Clamp(opacity + ((toOpacity - opacity) * t), 0, 1);
            _sheetHost.TranslationY = y + ((toY - y) * t);
            _backdrop.Opacity = Math.Clamp(shade + ((toShade - shade) * t), 0, 1);
        }).Commit(this, SheetAnimation, 16, show ? SheetInMs : SheetOutMs, show ? Easing.CubicOut : Easing.CubicIn, (_, _) =>
        {
            arriving?.TrySetResult();
            if (run == _sheetRun)
            {
                SettleSheet(show, dim);
            }
        });
    }

    /// <summary>The sheet as it is with nothing under way: in, with the backdrop when it dims; or gone, the host empty.</summary>
    private void SettleSheet(bool show, bool dim)
    {
        _sheetHost.Opacity = 1;
        _sheetHost.TranslationY = 0;
        _backdrop.Opacity = 1;
        _backdrop.IsVisible = show && dim;
        _sheetHost.IsVisible = show;
        if (!show)
        {
            _sheetHost.Content = null;
            // The field that had the keyboard is gone with it: the keyboard goes back to the app's window.
            _session.Host.ReturnFocus();
        }
    }
}
