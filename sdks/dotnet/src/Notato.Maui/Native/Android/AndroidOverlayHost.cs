#if ANDROID
using Android.App;
using Android.Graphics;
using Android.OS;
using Android.Views;
using Android.Widget;
using AndroidX.Core.View;
using Microsoft.Maui;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Graphics.Platform;
using Microsoft.Maui.Platform;
using Notato.Maui.Inspection;
using AView = Android.Views.View;
using AWindow = Android.Views.Window;
using MauiRect = Microsoft.Maui.Graphics.Rect;
using MauiView = Microsoft.Maui.Controls.View;
using MauiWindow = Microsoft.Maui.Controls.Window;
using VisualElement = Microsoft.Maui.Controls.VisualElement;

namespace Notato.Maui.Native;

/// <summary>
/// A full-size view added to the decor view of whichever window is on top: the activity's, or the dialog a MAUI modal
/// page is shown in. Touches that miss Notato's controls fall through to the app, because the overlay's layouts are
/// input transparent and Android then offers the touch to the views underneath.
/// </summary>
internal sealed class AndroidOverlayHost : IOverlayHost, IElementGeometry
{
    private readonly Activity _activity;
    private readonly MauiWindow _mauiWindow;
    private OverlayFrame? _frame;
    private MauiView? _overlay;
    private ViewGroup? _decor;
    private AWindow? _topWindow;
    private Thickness _safe;
    private double _keyboard;
    private readonly CaptureHiding _hiding = new();
    /// <summary>The window's tree the scroll listener is on: it changes when the overlay moves into a dialog.</summary>
    private ViewTreeObserver? _observer;
    private ScrollListener? _scrolls;
    private Func<bool>? _frameStep;
    private FrameStep? _frameCallback;
    private bool _framePosted;

    public AndroidOverlayHost(Activity activity, MauiWindow mauiWindow)
    {
        _activity = activity;
        _mauiWindow = mauiWindow;
    }

    public event EventHandler? MetricsChanged;

    public event EventHandler? ContentMoving;

    public IElementGeometry Geometry => this;

    private double Density => _activity.Resources?.DisplayMetrics?.Density ?? 1;

    public void Attach(MauiView overlay, IMauiContext context)
    {
        AView platform = overlay.ToPlatform(context);
        _overlay = overlay;
        _frame = new OverlayFrame(_activity, this);
        _frame.AddView(platform, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.MatchParent));
        ViewCompat.SetOnApplyWindowInsetsListener(_frame, new InsetsListener(this));
        Refresh();
    }

    /// <summary>The window that is on top: the newest showing dialog of a MAUI modal page, else the activity's.</summary>
    private AWindow? FindTopWindow()
    {
        if (_activity is AndroidX.Fragment.App.FragmentActivity fragments)
        {
            AWindow? top = null;
            foreach (AndroidX.Fragment.App.Fragment fragment in fragments.SupportFragmentManager.Fragments)
            {
                if (fragment is AndroidX.Fragment.App.DialogFragment { Dialog: { IsShowing: true, Window: { } dialogWindow } })
                {
                    top = dialogWindow;
                }
            }
            if (top is not null)
            {
                return top;
            }
        }
        return _activity.Window;
    }

    public void Refresh()
    {
        if (_frame is null)
        {
            return;
        }

        AWindow? top = FindTopWindow();
        if (top?.DecorView is not ViewGroup target)
        {
            return;
        }

        _topWindow = top;
        if (!ReferenceEquals(target, _decor))
        {
            (_frame.Parent as ViewGroup)?.RemoveView(_frame);
            target.AddView(_frame, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.MatchParent));
            _decor = target;
            WatchScrolling(target.ViewTreeObserver);
            ViewCompat.RequestApplyInsets(_frame);
        }
        else if (target.IndexOfChild(_frame) != target.ChildCount - 1)
        {
            _frame.BringToFront();
        }
        ReadInsets(ViewCompat.GetRootWindowInsets(_frame));
    }

    /// <summary>
    /// Listens for any view in the window scrolling (a ScrollView, a CollectionView's list): Android says so once a
    /// frame while one does, which is when the pins follow it.
    /// </summary>
    private void WatchScrolling(ViewTreeObserver? observer)
    {
        if (_observer is { IsAlive: true } old && _scrolls is not null)
        {
            old.RemoveOnScrollChangedListener(_scrolls);
        }

        _observer = observer;
        if (observer is { IsAlive: true })
        {
            observer.AddOnScrollChangedListener(_scrolls ??= new ScrollListener(this));
        }
    }

    public void EveryFrame(Func<bool> frame)
    {
        _frameStep = frame;
        if (_framePosted)
        {
            return;
        }

        _framePosted = true;
        Choreographer.Instance!.PostFrameCallback(_frameCallback ??= new FrameStep(this));
    }

    private void OnFrame()
    {
        _framePosted = false;
        if (_frame is not null && _frameStep?.Invoke() == true)
        {
            _framePosted = true;
            Choreographer.Instance!.PostFrameCallback(_frameCallback!);
        }
        else
        {
            _frameStep = null;
        }
    }

    public void SetVisible(bool visible)
    {
        _hiding.Wanted = visible;
        ApplyVisibility();
    }

    private void ApplyVisibility()
    {
        _frame?.Visibility = !_hiding.Wanted ? ViewStates.Gone : _hiding.Capturing ? ViewStates.Invisible : ViewStates.Visible;
    }

    public Thickness SafeInsets => _safe;

    public double KeyboardHeight => _keyboard;

    public Size Size => _frame is null || _frame.Width == 0
        ? Size.Zero
        : new Size(_frame.Width / Density, _frame.Height / Density);

    public void ReturnFocus()
    {
        if (_frame is null)
        {
            return;
        }

        AView? focused = _frame.FindFocus();
        focused?.ClearFocus();
        // The field may already be gone from the overlay; the keyboard belongs to the window either way.
        IBinder? token = focused?.WindowToken ?? _frame.WindowToken;
        if (token is not null && _activity.GetSystemService(Android.Content.Context.InputMethodService) is Android.Views.InputMethods.InputMethodManager ime)
        {
            ime.HideSoftInputFromWindow(token, Android.Views.InputMethods.HideSoftInputFlags.None);
        }
    }

    private void ReadInsets(WindowInsetsCompat? insets)
    {
        if (insets is null)
        {
            return;
        }

        double d = Density;
        AndroidX.Core.Graphics.Insets? bars = insets.GetInsets(WindowInsetsCompat.Type.SystemBars() | WindowInsetsCompat.Type.DisplayCutout());
        AndroidX.Core.Graphics.Insets? ime = insets.GetInsets(WindowInsetsCompat.Type.Ime());
        if (bars is null || ime is null)
        {
            return;
        }

        Thickness nextSafe = new(bars.Left / d, bars.Top / d, bars.Right / d, bars.Bottom / d);
        double nextKeyboard = Math.Max(0, (ime.Bottom - bars.Bottom) / d);
        if (nextSafe == _safe && Math.Abs(nextKeyboard - _keyboard) < 0.5)
        {
            return;
        }

        _safe = nextSafe;
        _keyboard = nextKeyboard;
        MetricsChanged?.Invoke(this, EventArgs.Empty);
    }

    public async Task<CapturedScreen?> CaptureAsync(Func<IReadOnlyList<MauiRect>> measureMasks)
    {
        if (_frame is null || _topWindow is not { DecorView: { Width: > 0, Height: > 0 } root } window)
        {
            return null;
        }

        Bitmap bitmap = Bitmap.CreateBitmap(root.Width, root.Height, Bitmap.Config.Argb8888!);
        IReadOnlyList<MauiRect> masks;
        try
        {
            // Drawn here and now with the overlay left out, all in this one call on the main thread: no frame is ever
            // shown without the overlay, so it does not flicker. What the window's own drawing cannot do (a camera's or
            // a map's surface, a hardware bitmap) is copied from the screen instead, below.
            if (!HasSurfaces(root) && DrawWithoutOverlay(root, bitmap, measureMasks) is { } drawn)
            {
                return new CapturedScreen(new PlatformImage(bitmap), bitmap.Width, bitmap.Height, Density, drawn);
            }
        }
        catch
        {
            Free(bitmap);
            throw;
        }

        // The overlay sits in the same window as the app, so it is hidden for one frame while the window is copied.
        // Captures can overlap: it shows again when the last one ends, not when the first one does.
        _hiding.BeginCapture();
        ApplyVisibility();
        try
        {
            await NextFrameAsync();
            await NextFrameAsync();
            // Measured in the frame that is copied, before anything else can move.
            masks = measureMasks();
            if (OperatingSystem.IsAndroidVersionAtLeast(26))
            {
                TaskCompletionSource<int> done = new();
                using CopyListener listener = new(done);
                using Handler handler = new(Looper.MainLooper!);
                PixelCopy.Request(window, bitmap, listener, handler);
                int result = await done.Task;
                if (result != (int)PixelCopyResult.Success)
                {
                    DrawInto(root, bitmap);
                }
            }
            else
            {
                DrawInto(root, bitmap);
            }
        }
        catch
        {
            Free(bitmap);
            throw;
        }
        finally
        {
            _hiding.EndCapture();
            ApplyVisibility();
        }
        // The caller disposes it (see CapturedScreen), which frees the bitmap.
        return new CapturedScreen(new PlatformImage(bitmap), bitmap.Width, bitmap.Height, Density, masks);
    }

    /// <summary>No picture after all: the bitmap (a whole screen's worth) goes now, not when the collector gets to it.</summary>
    private static void Free(Bitmap bitmap)
    {
        bitmap.Recycle();
        bitmap.Dispose();
    }

    /// <summary>
    /// The window drawn into <paramref name="bitmap"/> with the overlay out of it, and what to cover measured in the
    /// same moment; null when it cannot be drawn this way (a hardware bitmap in it).
    /// </summary>
    private IReadOnlyList<MauiRect>? DrawWithoutOverlay(AView root, Bitmap bitmap, Func<IReadOnlyList<MauiRect>> measureMasks)
    {
        IReadOnlyList<MauiRect> masks = measureMasks();
        _hiding.BeginCapture();
        ApplyVisibility();
        try
        {
            DrawInto(root, bitmap);
            return masks;
        }
        catch (Java.Lang.Throwable)
        {
            bitmap.EraseColor(0);
            return null;
        }
        finally
        {
            _hiding.EndCapture();
            ApplyVisibility();
        }
    }

    /// <summary>Whether the window shows something its own drawing leaves out: a SurfaceView or a TextureView.</summary>
    private bool HasSurfaces(AView view)
    {
        if (view is SurfaceView or TextureView)
        {
            return true;
        }

        if (view is not ViewGroup group || ReferenceEquals(view, _frame) || view.Visibility != ViewStates.Visible)
        {
            return false;
        }

        for (int i = 0; i < group.ChildCount; i++)
        {
            if (group.GetChildAt(i) is { } child && HasSurfaces(child))
            {
                return true;
            }
        }

        return false;
    }

    private static void DrawInto(AView root, Bitmap bitmap)
    {
        using Canvas canvas = new(bitmap);
        root.Draw(canvas);
    }

    private static Task NextFrameAsync()
    {
        TaskCompletionSource done = new();
        Choreographer.Instance!.PostFrameCallback(new FrameCallback(done));
        return done.Task;
    }

    // ---- geometry: window coordinates in dp, which are the overlay's --------------------------------------------

    private static AView? PlatformViewOf(VisualElement element) =>
        element.Handler is IPlatformViewHandler handler ? handler.ContainerView ?? handler.PlatformView : null;

    private bool InOverlayWindow(AView view) => _decor is not null && ReferenceEquals(view.RootView, _decor);

    public MauiRect? BoundsOf(VisualElement element)
    {
        AView? view = PlatformViewOf(element);
        if (view is null || !view.IsAttachedToWindow || !view.IsShown || view.Width == 0 || !InOverlayWindow(view))
        {
            return null;
        }

        int[] location = new int[2];
        view.GetLocationInWindow(location);
        double d = Density;
        return new MauiRect(location[0] / d, location[1] / d, view.Width / d, view.Height / d);
    }

    public MauiRect? VisibleBoundsOf(VisualElement element)
    {
        AView? view = PlatformViewOf(element);
        if (view is null || !view.IsAttachedToWindow || !view.IsShown || !InOverlayWindow(view))
        {
            return null;
        }

        Android.Graphics.Rect r = new();
        if (!view.GetGlobalVisibleRect(r) || r.Width() <= 0 || r.Height() <= 0)
        {
            return null;
        }

        double d = Density;
        return new MauiRect(r.Left / d, r.Top / d, r.Width() / d, r.Height() / d);
    }

    public void Dispose()
    {
        _frameStep = null;
        WatchScrolling(null);
        ReturnFocus();
        (_frame?.Parent as ViewGroup)?.RemoveView(_frame);
        _frame?.Dispose();
        _frame = null;
        _decor = null;
    }

    private sealed class OverlayFrame(Android.Content.Context context, AndroidOverlayHost host) : FrameLayout(context)
    {
        protected override void OnLayout(bool changed, int left, int top, int right, int bottom)
        {
            base.OnLayout(changed, left, top, right, bottom);
            if (host._overlay is { } overlay)
            {
                OverlayHosts.ArrangeRoot(overlay, (right - left) / host.Density, (bottom - top) / host.Density);
            }

            // Only a new size: a layout pass inside the overlay (its own animations) moves nothing here.
            if (changed)
            {
                host.MetricsChanged?.Invoke(host, EventArgs.Empty);
            }
        }

        // Not clickable, so a touch that no child takes is offered to the app's views underneath.
        public override bool OnTouchEvent(MotionEvent? e) => false;
    }

    private sealed class InsetsListener(AndroidOverlayHost host) : Java.Lang.Object, IOnApplyWindowInsetsListener
    {
        public WindowInsetsCompat? OnApplyWindowInsets(AView? v, WindowInsetsCompat? insets)
        {
            host.ReadInsets(insets);
            return insets;
        }
    }

    private sealed class CopyListener(TaskCompletionSource<int> done) : Java.Lang.Object, PixelCopy.IOnPixelCopyFinishedListener
    {
        public void OnPixelCopyFinished(int copyResult) => done.TrySetResult(copyResult);
    }

    private sealed class FrameCallback(TaskCompletionSource done) : Java.Lang.Object, Choreographer.IFrameCallback
    {
        public void DoFrame(long frameTimeNanos) => done.TrySetResult();
    }

    private sealed class FrameStep(AndroidOverlayHost host) : Java.Lang.Object, Choreographer.IFrameCallback
    {
        public void DoFrame(long frameTimeNanos) => host.OnFrame();
    }

    private sealed class ScrollListener(AndroidOverlayHost host) : Java.Lang.Object, ViewTreeObserver.IOnScrollChangedListener
    {
        public void OnScrollChanged() => host.ContentMoving?.Invoke(host, EventArgs.Empty);
    }
}
#endif
