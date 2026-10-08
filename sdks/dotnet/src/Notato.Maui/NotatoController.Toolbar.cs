using Microsoft.Extensions.Logging;
using Microsoft.Maui.Devices.Sensors;
using Microsoft.Maui.Graphics;
using Notato.Maui.Overlay;
using Notato.Maui.Runtime;

namespace Notato.Maui;

// The toolbar: shown or hidden (shaking the device toggles it), where it was dragged to, and folding into its round
// button. The rules for folding are in ToolbarFold; the overlay draws it.
internal sealed partial class NotatoController
{
    private readonly ToolbarFold _fold;
    /// <summary>Whether annotating was on the last time the fold was told (see <see cref="FollowAnnotating"/>).</summary>
    private bool _foldSawAnnotating;
    private Point? _toolbarFraction;
    private ShakeListener? _shake;

    /// <summary>Where the toolbar is, as fractions of the room it can move in across and down the window.</summary>
    public Point ToolbarFraction
    {
        get => _toolbarFraction ??= _state.ToolbarPosition ?? Options.ToolbarPosition switch
        {
            // Bottom corners start a little up, clear of a tab bar; people drag it where they like.
            ToolbarCorner.BottomLeft => new Point(0, 0.86),
            ToolbarCorner.TopRight => new Point(1, 0.08),
            ToolbarCorner.TopLeft => new Point(0, 0.08),
            _ => new Point(1, 0.86),
        };
        set
        {
            _toolbarFraction = value;
            _state.ToolbarPosition = value;
        }
    }

    /// <summary>
    /// Where a fold or an opening left the toolbar. While it is only open for annotating this is not remembered, so a
    /// restart comes back folded where the round button was.
    /// </summary>
    internal void ToolbarArrived(Point fraction)
    {
        if (_fold.OpenedForAnnotating)
        {
            _toolbarFraction = fraction;
        }
        else
        {
            ToolbarFraction = fraction;
        }
    }

    /// <summary>Whether the toolbar grows from, and folds to, the right (see <see cref="ToolbarFold.HeldSide"/>).</summary>
    internal bool ToolbarHeldRight => _fold.HeldSide(_state.ToolbarPosition, Options.ToolbarPosition);

    /// <summary>A fold or an opening of the settled toolbar starts (see <see cref="ToolbarFold.Start"/>).</summary>
    internal ToolbarFold.Trip StartToolbarTrip(bool collapsing, ToolbarFold.Room room, double fromWidth, double toWidth, Point? dragging) =>
        _fold.Start(collapsing, room, (dragging ?? ToolbarFraction).X, fromWidth, toWidth, dragging ?? _state.ToolbarPosition, Options.ToolbarPosition);

    /// <summary>A fold or an opening changes its mind mid-way (see <see cref="ToolbarFold.TurnAround"/>).</summary>
    internal ToolbarFold.Trip TurnToolbarAround(bool collapsing, ToolbarFold.Room room, bool heldRight, double fromEdge, double toWidth) =>
        _fold.TurnAround(collapsing, room, heldRight, fromEdge, toWidth);

    /// <summary>The person dragged the toolbar somewhere: its side and its folded and open places start afresh.</summary>
    internal void ToolbarMoved() => _fold.Moved();

    /// <summary>The window changed size: the places it was folded and open at are forgotten; its side is kept.</summary>
    internal void ToolbarRoomChanged() => _fold.ForgetPlaces();

    /// <summary>
    /// Whether the toolbar shows folded into its round button now: as the person left it, but open while annotating
    /// (however that started) if it was folded when it did.
    /// </summary>
    internal bool ToolbarCollapsed
    {
        get
        {
            FollowAnnotating();
            return _fold.Collapsed;
        }
    }

    /// <summary>The person folded the toolbar (its chevron) or opened it (the round button). Remembered.</summary>
    internal void SetToolbarCollapsed(bool collapsed)
    {
        FollowAnnotating();
        if (_fold.Set(collapsed))
        {
            RenderAll();
        }
    }

    /// <summary>
    /// Tells the fold when annotating started or stopped. Checked whenever the fold is read rather than at each place
    /// annotating changes (the toolbar, the menu, <see cref="StartAnnotating"/>, <see cref="SelectAsync"/>, a note
    /// sent or cancelled, Notato switched off), so no way of starting or stopping it is missed.
    /// </summary>
    private void FollowAnnotating()
    {
        if (IsAnnotating == _foldSawAnnotating)
        {
            return;
        }

        _foldSawAnnotating = IsAnnotating;
        _fold.AnnotatingChanged(_foldSawAnnotating);
    }

    private void SetToolbar(bool visible)
    {
        _toolbarVisible = visible;
        _state.ToolbarVisible = visible;
        if (!visible)
        {
            _annotating = false;
        }

        RenderAll();
    }

    internal void TogglePins()
    {
        _state.PinsVisible = !PinsVisible;
        RenderAll();
    }

    // ---- shake ------------------------------------------------------------------------------------------------------

    /// <summary>Whether shaking the device toggles the toolbar: asked for, and there is an accelerometer.</summary>
    public bool ShakeAvailable => Options.ShakeToToggle && SafeAccelerometerSupported();

    private static bool SafeAccelerometerSupported()
    {
        try
        {
            return Accelerometer.Default.IsSupported;
        }
        catch
        {
            // Plain net10.0 has no sensors.
            return false;
        }
    }

    private void StartShake()
    {
        if (!ShakeAvailable)
        {
            return;
        }

        try
        {
            _shake ??= new ShakeListener(Accelerometer.Default, OnShake, _logger);
            _shake.Start();
        }
        catch (Exception error)
        {
            _logger.LogDebug(error, "Notato could not listen for shakes");
        }
    }

    private void StopShake() => _shake?.Stop();

    private void OnShake(object? sender, EventArgs e) => Dispatch(() => SetToolbar(!_toolbarVisible));
}
