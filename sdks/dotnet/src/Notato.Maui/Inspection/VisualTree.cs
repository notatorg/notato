using Microsoft.Maui.Controls;
using MauiRect = Microsoft.Maui.Graphics.Rect;
using Point = Microsoft.Maui.Graphics.Point;

namespace Notato.Maui.Inspection;

/// <summary>Where an element is on screen, in the overlay's coordinates (device-independent units from the window's top left).</summary>
internal interface IElementGeometry
{
    /// <summary>The element's whole box, or null when it is not on screen (detached, hidden, or never laid out).</summary>
    MauiRect? BoundsOf(VisualElement element);

    /// <summary>The part of the box that can be seen: clipped by scroll views and other clipping ancestors.</summary>
    MauiRect? VisibleBoundsOf(VisualElement element);
}

/// <summary>Walks the app's visual tree. Shared by the picker, the selectors and the identity.</summary>
internal static class VisualTree
{
    public static IEnumerable<Element> Children(Element element) =>
        element is IVisualTreeElement tree ? tree.GetVisualChildren().OfType<Element>() : [];

    public static Element? Parent(Element element) =>
        (element as IVisualTreeElement)?.GetVisualParent() as Element ?? element.Parent;

    /// <summary>The element and every element it is inside, innermost first.</summary>
    public static IEnumerable<Element> SelfAndAncestors(Element element)
    {
        for (Element? e = element; e is not null; e = Parent(e))
        {
            yield return e;
        }
    }

    /// <summary>
    /// Whether the element is inside a list that recycles its rows (a CollectionView, a CarouselView, a ListView): the
    /// element can be reused to show another item.
    /// </summary>
    public static bool InList(Element element)
    {
        foreach (Element e in SelfAndAncestors(element).Skip(1))
        {
#pragma warning disable CS0618 // older apps still use ListView
            if (e is ItemsView or ListView)
#pragma warning restore CS0618
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>The page the element is on: the nearest page around it.</summary>
    public static Page? PageOf(Element element) => SelfAndAncestors(element).OfType<Page>().FirstOrDefault();

    /// <summary>A type's name as written in code: <c>Button</c>, <c>ItemsView</c> for <c>ItemsView`1</c>.</summary>
    public static string TypeName(Type type)
    {
        string name = type.Name;
        int tick = name.IndexOf('`');
        return tick < 0 ? name : name[..tick];
    }

    /// <summary>
    /// What is showing in a window, topmost first: the top modal page (it covers everything under it), else the page.
    /// </summary>
    public static IEnumerable<Element> VisibleRoots(Window window)
    {
        IReadOnlyList<Page>? modal = window.Navigation?.ModalStack;
        if (modal is { Count: > 0 } && modal[^1] is { } top)
        {
            yield return top;
            yield break;
        }
        if (window.Page is { } page)
        {
            yield return page;
        }
    }

    /// <summary>
    /// Every page a window holds, topmost first: each modal page, newest first, then the window's page. Pages under a
    /// modal can still be drawn (a sheet, or a modal that can be seen through), so screenshots are covered across all
    /// of them.
    /// </summary>
    public static IEnumerable<Page> AllRoots(Window window)
    {
        IReadOnlyList<Page>? modal = window.Navigation?.ModalStack;
        for (int i = (modal?.Count ?? 0) - 1; i >= 0; i--)
        {
            if (modal![i] is { } page)
            {
                yield return page;
            }
        }
        if (window.Page is { } root)
        {
            yield return root;
        }
    }

    /// <summary>Every element under <paramref name="root"/>, depth first, root included.</summary>
    /// <remarks>Read straight from each element's list of children, with nothing copied per element: pins walk the tree often.</remarks>
    public static IEnumerable<Element> Descendants(Element root)
    {
        Stack<Element> stack = new();
        stack.Push(root);
        while (stack.Count > 0)
        {
            Element e = stack.Pop();
            yield return e;
            if (e is not IVisualTreeElement tree)
            {
                continue;
            }

            IReadOnlyList<IVisualTreeElement> children = tree.GetVisualChildren();
            for (int i = children.Count - 1; i >= 0; i--)
            {
                if (children[i] is Element child)
                {
                    stack.Push(child);
                }
            }
        }
    }

    /// <summary>
    /// The deepest element that is drawn at <paramref name="point"/>, looking at what is on top first (later children
    /// and higher ZIndex). Null when nothing of the app is there.
    /// </summary>
    public static VisualElement? HitTest(Window window, Point point, IElementGeometry geometry, Func<Element, bool>? skip = null)
    {
        foreach (Element root in VisibleRoots(window))
        {
            VisualElement? hit = HitTest(root, point, geometry, skip);
            if (hit is not null)
            {
                return hit;
            }
        }
        return null;
    }

    private static VisualElement? HitTest(Element element, Point point, IElementGeometry geometry, Func<Element, bool>? skip)
    {
        if (skip?.Invoke(element) == true)
        {
            return null;
        }

        VisualElement? visual = element as VisualElement;
        if (visual is not null)
        {
            if (!visual.IsVisible || visual.Opacity <= 0.01)
            {
                return null;
            }
            // Shell items and other navigation plumbing are not drawn themselves: look through them.
            if (visual.Handler is not null)
            {
                MauiRect? visible = geometry.VisibleBoundsOf(visual);
                if (visible is null || !visible.Value.Contains(point))
                {
                    return null;
                }
            }
        }
        foreach (Element child in OnTopFirst(element))
        {
            VisualElement? hit = HitTest(child, point, geometry, skip);
            if (hit is not null)
            {
                return hit;
            }
        }
        return visual is { Handler: not null } ? visual : null;
    }

    /// <summary>Children in the order they are drawn, last drawn (on top) first.</summary>
    public static IEnumerable<Element> OnTopFirst(Element element)
    {
        List<Element> children = [.. Children(element)];
        return children
            .Select((child, index) => (child, index, z: child is IView view ? view.ZIndex : 0))
            .OrderByDescending(c => c.z)
            .ThenByDescending(c => c.index)
            .Select(c => c.child);
    }
}
