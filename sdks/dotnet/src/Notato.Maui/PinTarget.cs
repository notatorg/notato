using Microsoft.Maui.Controls;
using Notato.Maui.Inspection;
using Notato.Maui.Model;

namespace Notato.Maui;

/// <summary>
/// The element a note's pin is on, and what it showed when the pin was put there. An element inside a list
/// (a CollectionView, a ListView) can be recycled to show another item: <see cref="InList"/> says it must be checked.
/// </summary>
internal sealed class PinTarget
{
    public PinTarget(VisualElement element)
    {
        Element = new WeakReference<VisualElement>(element);
        Context = element.BindingContext is { } context ? new WeakReference<object>(context) : null;
        InList = VisualTree.InList(element);
    }

    public WeakReference<VisualElement> Element { get; }

    /// <summary>The item it was showing (its BindingContext) when the pin was put on it.</summary>
    public WeakReference<object>? Context { get; }

    public bool InList { get; }

    /// <summary>
    /// Whether the element still shows the note's item: always outside a list; inside one, when it is bound to the same
    /// item, or shows the same text as when the note was made.
    /// </summary>
    public bool StillShows(VisualElement element, ElementIdentity? identity, bool mask)
    {
        if (!InList)
        {
            return true;
        }

        if (Context is not null && Context.TryGetTarget(out object? was) && ReferenceEquals(was, element.BindingContext))
        {
            return true;
        }

        return identity?.Text is { } text && ElementText.Visible(element, mask) == text;
    }
}
