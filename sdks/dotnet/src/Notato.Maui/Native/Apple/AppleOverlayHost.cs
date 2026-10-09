#if IOS || MACCATALYST
using CoreAnimation;
using CoreGraphics;
using Foundation;
using Microsoft.Maui;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Graphics.Platform;
using Microsoft.Maui.Platform;
using Notato.Maui.Inspection;
using UIKit;
using MauiRect = Microsoft.Maui.Graphics.Rect;

namespace Notato.Maui.Native;

/// <summary>
/// A transparent window of Notato's own above the app's window in the same scene. Being a separate window is what
/// keeps the overlay above modal pages, alerts and popups, and out of the app's screenshots.
/// </summary>
internal sealed class AppleOverlayHost : IOverlayHost, IElementGeometry
{
    private readonly UIWindow _appWindow;
    private PassthroughWindow? _window;
    private OverlayViewController? _controller;
    private UIView? _content;
    private NSObject? _keyboardShow, _keyboardHide;
    private double _keyboard;
    private bool _wanted = true;
    /// <summary>The size, safe area and keyboard last told: a layout pass that changed none of them says nothing.</summary>
    private (Size Size, Thickness Safe, double Keyboard)? _told;
    private CADisplayLink? _link;
    private Func<bool>? _frame;

    public AppleOverlayHost(UIWindow appWindow) => _appWindow = appWindow;

    public event EventHandler? MetricsChanged;

    public event EventHandler? ContentMoving;

    public IElementGeometry Geometry => this;

    public void Attach(View overlay, IMauiContext context)
    {
        UIWindowScene? scene = _appWindow.WindowScene;
        // Every MAUI window on iOS 13+ has a scene; the frame-only constructor is a fallback for one that has not.
#pragma warning disable CA1422
        _window = scene is null ? new PassthroughWindow(_appWindow.Frame) : new PassthroughWindow(scene);
#pragma warning restore CA1422
        _window.Frame = _appWindow.Frame;
        _window.BackgroundColor = UIColor.Clear;
        // Above alerts too: a note can be about an alert.
        _window.WindowLevel = UIWindowLevel.Alert + 1;
        // Every touch on the screen is offered to this window first, the app's included: the app may be about to scroll.
        _window.Touched = () => ContentMoving?.Invoke(this, EventArgs.Empty);
        _controller = new OverlayViewController(_appWindow, () =>
        {
            if (_controller?.View is { } root)
            {
                OverlayHosts.ArrangeRoot(overlay, root.Bounds.Width, root.Bounds.Height);
            }

            // Called on every layout pass of Notato's window, which its own animations cause too.
            TellMetrics();
        });
        _window.RootViewController = _controller;

        _content = overlay.ToPlatform(context);
        _content.Frame = _controller.View!.Bounds;
        _content.AutoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
        _controller.View.AddSubview(_content);
        _window.Hidden = false;
        _controller.View.SetNeedsLayout();

        _keyboardShow = UIKeyboard.Notifications.ObserveWillChangeFrame((_, e) => OnKeyboard(e.FrameEnd));
        _keyboardHide = UIKeyboard.Notifications.ObserveWillHide((_, _) =>
        {
            _keyboard = 0;
            TellMetrics();
        });
    }

    /// <summary>Raises <see cref="MetricsChanged"/> when the size, the safe area or the keyboard differ from the last time.</summary>
    private void TellMetrics()
    {
        (Size, Thickness, double) now = (Size, SafeInsets, Math.Round(_keyboard, 1));
        if (_told == now)
        {
            return;
        }

        _told = now;
        MetricsChanged?.Invoke(this, EventArgs.Empty);
    }

    public void EveryFrame(Func<bool> frame)
    {
        _frame = frame;
        if (_link is not null)
        {
            return;
        }

        _link = CADisplayLink.Create(() =>
        {
            if (_frame?.Invoke() != true)
            {
                StopFrames();
            }
        });
        // The common modes: it keeps running while a scroll view is being dragged.
        _link.AddToRunLoop(NSRunLoop.Main, NSRunLoopMode.Common);
    }

    private void StopFrames()
    {
        _frame = null;
        _link?.Invalidate();
        _link = null;
    }

    private void OnKeyboard(CGRect frameEnd)
    {
        if (_window is null)
        {
            return;
        }
        // The keyboard's frame is in screen coordinates; how much of our window it covers is what matters.
        CGRect local = _window.ConvertRectFromCoordinateSpace(frameEnd, _window.WindowScene?.Screen.CoordinateSpace ?? UIScreen.MainScreen.CoordinateSpace);
        nfloat covered = _window.Bounds.Height - local.Y;
        _keyboard = Math.Max(0, Math.Min(_window.Bounds.Height, (double)covered));
        if (frameEnd.Height <= 0)
        {
            _keyboard = 0;
        }

        TellMetrics();
    }

    public void Refresh()
    {
        if (_window is null)
        {
            return;
        }

        if (_window.Frame != _appWindow.Frame)
        {
            _window.Frame = _appWindow.Frame;
        }

        // As it was asked to be: a refresh never brings back an overlay that was hidden on purpose.
        _window.Hidden = !_wanted || (_content?.Hidden ?? false);
    }

    public void SetVisible(bool visible)
    {
        _wanted = visible;
        if (_window is null)
        {
            return;
        }

        _window.Hidden = !visible;
        if (!visible)
        {
            ReturnFocus();
        }
    }

    public Thickness SafeInsets
    {
        get
        {
            UIEdgeInsets insets = _appWindow.SafeAreaInsets;
            return new Thickness(insets.Left, insets.Top, insets.Right, insets.Bottom);
        }
    }

    public double KeyboardHeight => _keyboard;

    public Size Size => _window is null ? Size.Zero : new Size(_window.Bounds.Width, _window.Bounds.Height);

    public void ReturnFocus()
    {
        if (_window is { IsKeyWindow: true })
        {
            _appWindow.MakeKeyWindow();
        }
    }

    public Task<CapturedScreen?> CaptureAsync(Func<IReadOnlyList<MauiRect>> measureMasks)
    {
        CGRect bounds = _appWindow.Bounds;
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return Task.FromResult<CapturedScreen?>(null);
        }

        double scale = (double)_appWindow.TraitCollection.DisplayScale;
        if (scale <= 0)
        {
            scale = 2;
        }

        using UIGraphicsImageRendererFormat format = new() { Scale = (nfloat)scale, Opaque = true };
        using UIGraphicsImageRenderer renderer = new(bounds.Size, format);
        // Measured and drawn in one go on the main thread, so the covers match the picture.
        IReadOnlyList<MauiRect> masks = measureMasks();
        // Notato's own window is separate, so it is never in the picture. It is never hidden for one either, so
        // captures that overlap cannot leave it hidden.
        UIImage image = renderer.CreateImage(_ => _appWindow.DrawViewHierarchy(bounds, afterScreenUpdates: false));
        // The caller disposes it (see CapturedScreen), which releases the image.
        return Task.FromResult<CapturedScreen?>(new CapturedScreen(
            new PlatformImage(image),
            (int)Math.Round(bounds.Width * scale),
            (int)Math.Round(bounds.Height * scale),
            scale,
            masks));
    }

    // ---- geometry: in window coordinates, which are the overlay's ------------------------------------------------

    private static UIView? PlatformViewOf(VisualElement element) =>
        element.Handler is IPlatformViewHandler handler ? handler.ContainerView ?? handler.PlatformView : null;

    private static bool IsShown(UIView view)
    {
        for (UIView? v = view; v is not null; v = v.Superview)
        {
            if (v.Hidden || v.Alpha < 0.01)
            {
                return false;
            }
        }
        return view.Window is not null;
    }

    public MauiRect? BoundsOf(VisualElement element)
    {
        UIView? view = PlatformViewOf(element);
        if (view is null || !IsShown(view) || view.Window != _appWindow)
        {
            return null;
        }

        CGRect r = view.ConvertRectToView(view.Bounds, null);
        return new MauiRect(r.X, r.Y, r.Width, r.Height);
    }

    public MauiRect? VisibleBoundsOf(VisualElement element)
    {
        UIView? view = PlatformViewOf(element);
        if (view is null || !IsShown(view) || view.Window != _appWindow)
        {
            return null;
        }

        CGRect visible = view.ConvertRectToView(view.Bounds, null);
        for (UIView? v = view.Superview; v is not null; v = v.Superview)
        {
            if (!v.ClipsToBounds && v is not UIScrollView)
            {
                continue;
            }

            visible = CGRect.Intersect(visible, v.ConvertRectToView(v.Bounds, null));
            if (visible.IsEmpty)
            {
                return null;
            }
        }
        visible = CGRect.Intersect(visible, _appWindow.Bounds);
        return visible.IsEmpty ? null : new MauiRect(visible.X, visible.Y, visible.Width, visible.Height);
    }

    public void Dispose()
    {
        StopFrames();
        _keyboardShow?.Dispose();
        _keyboardHide?.Dispose();
        _content?.RemoveFromSuperview();
        if (_window is not null)
        {
            ReturnFocus();
            _window.Hidden = true;
            _window.RootViewController = null;
            _window.Dispose();
        }
        _window = null;
    }

    /// <summary>A window that only keeps touches that land on Notato's controls; every other touch goes to the app.</summary>
    private sealed class PassthroughWindow : UIWindow
    {
        public PassthroughWindow(UIWindowScene scene) : base(scene) { }

#pragma warning disable CA1422
        public PassthroughWindow(CGRect frame) : base(frame) { }
#pragma warning restore CA1422

        /// <summary>A touch (or a trackpad's scroll) began somewhere on the screen; the pointer only hovering is not one.</summary>
        public Action? Touched { get; set; }

        public override UIView? HitTest(CGPoint point, UIEvent? uievent)
        {
            if (uievent?.Type is UIEventType.Touches or UIEventType.Scroll)
            {
                Touched?.Invoke();
            }

            UIView? hit = base.HitTest(point, uievent);
            if (hit is null || hit == this || hit == RootViewController?.View)
            {
                return null;
            }

            return hit;
        }
    }

    /// <summary>Lets the app keep deciding the status bar and rotation while Notato's window is on top.</summary>
    private sealed class OverlayViewController(UIWindow appWindow, Action changed) : UIViewController
    {
        private UIViewController? AppTop
        {
            get
            {
                UIViewController? vc = appWindow.RootViewController;
                while (vc?.PresentedViewController is { IsBeingDismissed: false } presented)
                {
                    vc = presented;
                }

                return vc;
            }
        }

        public override void LoadView() => View = new UIView { BackgroundColor = UIColor.Clear };

        public override UIStatusBarStyle PreferredStatusBarStyle() => AppTop?.PreferredStatusBarStyle() ?? UIStatusBarStyle.Default;

        public override bool PrefersStatusBarHidden() => AppTop?.PrefersStatusBarHidden() ?? false;

        public override UIInterfaceOrientationMask GetSupportedInterfaceOrientations() =>
            AppTop?.GetSupportedInterfaceOrientations() ?? UIInterfaceOrientationMask.All;

        public override void ViewSafeAreaInsetsDidChange()
        {
            base.ViewSafeAreaInsetsDidChange();
            changed();
        }

        public override void ViewDidLayoutSubviews()
        {
            base.ViewDidLayoutSubviews();
            changed();
        }
    }
}
#endif
