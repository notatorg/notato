#if ANDROID
using Microsoft.Maui.Controls;

namespace Notato.Maui.Overlay;

// Android: while the toolbar folds or opens it stays laid out at one width, and what shows of it is a rounded outline
// that Android clips the bar to and casts its shadow from, on the render thread. Resizing it on every frame meant a MAUI
// layout pass, and MAUI's shadow redrawn as a blurred bitmap, each time: 15 to 30 frames a second in a debug build on
// the emulator, where the native SDK's toolbar does 60.
internal sealed partial class NotatoOverlay
{
    private readonly PillOutline _pill = new();

    /// <summary>The part of the bar that shows: all of it, unless a fold or an opening says how wide, from which side.</summary>
    private sealed class PillOutline : Android.Views.ViewOutlineProvider
    {
        /// <summary>The width showing, in device-independent units; null for the whole bar.</summary>
        public double? Shown;
        public bool HeldRight;

        public override void GetOutline(Android.Views.View? view, Android.Graphics.Outline? outline)
        {
            if (view is null || outline is null || view.Width <= 0 || view.Height <= 0)
            {
                return;
            }

            int w = view.Width, h = view.Height;
            float density = view.Resources!.DisplayMetrics!.Density;
            int shown = Shown is { } dp ? (int)Math.Round(dp * density) : w;
            shown = Math.Clamp(shown, Math.Min(h, w), w);
            int left = HeldRight ? w - shown : 0;
            // 16 open, rounding into the circle as it folds, as the bar's own shape does when it is settled.
            float corner = (float)(ToolbarFold.Corner(shown / density, BarHeight, BarCorner) * density);
            outline.SetRoundRect(left, 0, left + shown, h, Math.Min(corner, h / 2f));
        }
    }

    /// <summary>Gives the bar Android's own shadow, and its outline clip, once it has a native view.</summary>
    private void UseNativePill()
    {
        _toolbar.HandlerChanged += (_, _) =>
        {
            if (Outermost(_toolbar) is not { } view)
            {
                return;
            }

            view.OutlineProvider = _pill;
            view.ClipToOutline = true;
            view.Elevation = 8 * view.Resources!.DisplayMetrics!.Density;
        };
        // Raised above the bar, which its elevation would otherwise draw (and take touches) over. It has no background,
        // so it casts no shadow. MAUI wraps it in a container (it lets touches through), and that is the bar's sibling.
        _fabFace.HandlerChanged += (_, _) =>
        {
            if (Outermost(_fabFace) is { } view)
            {
                view.Elevation = 9 * view.Resources!.DisplayMetrics!.Density;
            }
        };
    }

    /// <summary>The native view laid out among its siblings: the container MAUI wraps it in, if it has one.</summary>
    private static Android.Views.View? Outermost(VisualElement element) =>
        (element.Handler as Microsoft.Maui.IViewHandler)?.ContainerView as Android.Views.View
        ?? element.Handler?.PlatformView as Android.Views.View;

    /// <summary>
    /// Shows <paramref name="shown"/> of the bar (all of it when null) from its held side, moved across by
    /// <paramref name="shift"/>: neither needs a layout pass.
    /// </summary>
    private void ShowPill(double? shown, bool heldRight, double shift)
    {
        if (shown is null && _pill.Shown is null && _toolbar.TranslationX == 0)
        {
            return;
        }

        _pill.Shown = shown;
        _pill.HeldRight = heldRight;
        _toolbar.TranslationX = shift;
        Outermost(_toolbar)?.InvalidateOutline();
    }
}
#endif
