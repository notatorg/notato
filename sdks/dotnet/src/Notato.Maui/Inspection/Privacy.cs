using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

namespace Notato.Maui.Inspection;

/// <summary>
/// What Notato must not record. A private element (<c>Feedback.Mask="True"</c>, on it or on a container around it) is
/// covered in screenshots and none of its text, or the text of anything in it, is recorded. A password entry always
/// is. With <see cref="NotatoOptions.MaskInputs"/>, every input is too, unless it says <c>Feedback.Mask="False"</c>.
/// A private container wins over an input inside it that opts out.
/// </summary>
internal static class Privacy
{
    /// <summary>Marked private, itself or by a container around it.</summary>
    public static bool IsPrivate(Element element) =>
        VisualTree.SelfAndAncestors(element).Any(e => Feedback.GetMask(e) == true);

    public static bool IsSecure(Element element) => element is Entry { IsPassword: true };

    /// <summary>Whether the element is covered in screenshots and its text never recorded.</summary>
    public static bool Hidden(Element element, bool maskInputs) =>
        IsSecure(element) || IsPrivate(element) || (maskInputs && element is InputView && Feedback.GetMask(element) != false);

    /// <summary>
    /// Where to cover a picture of the window: the visible part of every hidden element on every page in it, topmost
    /// page first. A page under a modal is included, because a sheet or a see-through modal leaves it in the picture;
    /// only an element wholly behind a page above it that is known to be opaque is left out.
    /// </summary>
    public static List<Rect> MaskRects(IEnumerable<Page> topmostFirst, IElementGeometry geometry, bool maskInputs)
    {
        List<Rect> masks = [];
        List<Rect> covered = [];
        foreach (Page root in topmostFirst)
        {
            foreach (VisualElement element in VisualTree.Descendants(root).OfType<VisualElement>())
            {
                if (Hidden(element, maskInputs) && geometry.VisibleBoundsOf(element) is { } r && !covered.Any(c => c.Contains(r)))
                {
                    masks.Add(r);
                }
            }
            if (IsOpaque(root) && geometry.VisibleBoundsOf(root) is { } area)
            {
                covered.Add(area);
            }
        }
        return masks;
    }

    /// <summary>Whether nothing under the page shows through it: only when its background says so. Unset is not enough.</summary>
    internal static bool IsOpaque(Page page) => page.Background switch
    {
        SolidColorBrush { Color: { } color } => color.Alpha >= 0.99f,
        GradientBrush { GradientStops.Count: > 0 } gradient => gradient.GradientStops.All(s => s.Color is { Alpha: >= 0.99f }),
        null or { IsEmpty: true } => page.BackgroundColor is { Alpha: >= 0.99f },
        _ => false,
    };
}
