using Microsoft.Maui;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;

namespace Notato.Maui.Native;

/// <summary>
/// The app's window as it was on screen, without Notato's overlay, and what to cover in it (<c>Masks</c>, in window
/// coordinates), measured in the same moment as the picture.
/// </summary>
/// <remarks>
/// The picture is a full-screen bitmap held by the platform: whoever ends up with it disposes it once the note's
/// screenshots are drawn from it, or when the selection it was taken for is replaced or cancelled.
/// </remarks>
internal sealed record CapturedScreen(Microsoft.Maui.Graphics.IImage Image, int PixelWidth, int PixelHeight, double Scale, IReadOnlyList<Rect> Masks) : IDisposable
{
    private int _disposed;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            Image.Dispose();
        }
    }
}

/// <summary>
/// Puts Notato's overlay above the app, in front of everything the app shows (including modal pages and popups), and
/// lets touches that are not on Notato's controls through to the app.
/// <list type="bullet">
/// <item>iOS and Mac Catalyst: a window of its own over the app's window, in the same scene.</item>
/// <item>Android: a view in the top window's decor view, which moves into a modal page's dialog while one shows.</item>
/// </list>
/// </summary>
internal interface IOverlayHost : IDisposable
{
    /// <summary>Converts the overlay to native views and puts it above the app.</summary>
    void Attach(View overlay, IMauiContext context);

    /// <summary>Re-checks which window is on top. Call after a modal page opened or closed.</summary>
    void Refresh();

    /// <summary>Hides or shows the overlay without detaching it.</summary>
    void SetVisible(bool visible);

    /// <summary>The window's safe area: status bar, notch, home indicator.</summary>
    Thickness SafeInsets { get; }

    /// <summary>How much of the window's bottom the on-screen keyboard covers, 0 when it is down.</summary>
    double KeyboardHeight { get; }

    /// <summary>The overlay's size, which is the window's.</summary>
    Size Size { get; }

    /// <summary>Raised on the main thread when the safe area, the keyboard or the size change, and only then.</summary>
    event EventHandler? MetricsChanged;

    /// <summary>
    /// Raised on the main thread when what the app shows may start moving: a touch or a scroll on it (iOS and Mac
    /// Catalyst), a view in the window scrolling (Android, once a frame while it does). The pins and the selection then
    /// follow it frame by frame (<see cref="EveryFrame"/>).
    /// </summary>
    event EventHandler? ContentMoving;

    /// <summary>
    /// Calls <paramref name="frame"/> on the main thread once a frame, in step with the display, until it returns
    /// false. Calling again while it runs replaces the callback.
    /// </summary>
    void EveryFrame(Func<bool> frame);

    IElementGeometry Geometry { get; }

    /// <summary>A picture of what the app shows, never including the overlay.</summary>
    /// <param name="measureMasks">
    /// Where the private parts of the app are. Called on the main thread at the moment the picture is taken, so the
    /// covers land on what the picture shows even if the app moves on afterwards.
    /// </param>
    Task<CapturedScreen?> CaptureAsync(Func<IReadOnlyList<Rect>> measureMasks);

    /// <summary>After typing in the overlay: give keyboard focus back to the app's window.</summary>
    void ReturnFocus();
}

/// <summary>
/// Whether an overlay that shares the app's window shows: not while any capture is under way, however many overlap
/// (two agent requests, or a tap during one), and not while it is hidden on purpose.
/// </summary>
internal sealed class CaptureHiding
{
    private int _captures;

    /// <summary>Shown unless hidden on purpose (<see cref="IOverlayHost.SetVisible"/>).</summary>
    public bool Wanted { get; set; } = true;

    /// <summary>A capture is under way: the overlay is out of the picture, but keeps its place.</summary>
    public bool Capturing => _captures > 0;

    public void BeginCapture() => _captures++;

    /// <summary>A capture ended. The overlay shows again once the last one has.</summary>
    public void EndCapture() => _captures = Math.Max(0, _captures - 1);
}

internal static class OverlayHosts
{
    /// <summary>
    /// The overlay has no MAUI parent, so nothing else gives it a size: measure and arrange it to the window's, as a
    /// page's container would. Hosts call this after each native layout pass.
    /// </summary>
    public static void ArrangeRoot(View overlay, double width, double height)
    {
        if (width <= 0 || height <= 0)
        {
            return;
        }

        if (overlay.Frame.Width == width && overlay.Frame.Height == height)
        {
            return;
        }

        IView view = (IView)overlay;
        view.Measure(width, height);
        view.Arrange(new Rect(0, 0, width, height));
    }

    /// <summary>The host for this platform, or null where Notato has no overlay (plain net10.0, or the window is not ready).</summary>
    public static IOverlayHost? Create(Window window)
    {
#if IOS || MACCATALYST
        return window.Handler?.PlatformView is UIKit.UIWindow platformWindow ? new AppleOverlayHost(platformWindow) : null;
#elif ANDROID
        return window.Handler?.PlatformView is Android.App.Activity activity ? new AndroidOverlayHost(activity, window) : null;
#else
        return null;
#endif
    }
}
