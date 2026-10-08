using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Microsoft.Maui.Layouts;

namespace Notato.Maui.Overlay;

/// <summary>
/// The part of a sheet that scrolls when the window, or the room the keyboard leaves, is too short for all of it. The
/// overlay says how tall it may be (<see cref="NotatoOverlay"/>'s FitSheet); the header and the buttons stay put.
/// </summary>
internal sealed class SheetBody : ScrollView
{
    /// <summary>However little room there is, this much of it shows.</summary>
    public const double Least = 120;

    public SheetBody(View content)
    {
        Ui.Plain(this);
        Content = content;
    }
}

/// <summary>
/// A sheet's buttons: side by side in equal widths when each one's words fit in its share, one above the other when
/// they do not (a long label, a narrow window, large text).
/// </summary>
internal sealed class ButtonRow : Layout
{
    public const double Spacing = 10;
    public const double StackSpacing = 8;

    /// <summary>Whether buttons that need <paramref name="needed"/> widths fit side by side in <paramref name="width"/>.</summary>
    public static bool SideBySide(double width, IReadOnlyList<double> needed) =>
        needed.Count <= 1 || double.IsInfinity(width) || needed.Max() <= (width - (Spacing * (needed.Count - 1))) / needed.Count;

    protected override ILayoutManager CreateLayoutManager() => new Manager(this);

    private sealed class Manager(ButtonRow row) : ILayoutManager
    {
        private bool _sideBySide = true;

        private List<IView> Buttons => [.. row.Where(b => b.Visibility != Visibility.Collapsed)];

        public Size Measure(double widthConstraint, double heightConstraint)
        {
            List<IView> buttons = Buttons;
            if (buttons.Count == 0)
            {
                return Size.Zero;
            }

            List<double> needed = [.. buttons.Select(b => b.Measure(double.PositiveInfinity, heightConstraint).Width)];
            _sideBySide = SideBySide(widthConstraint, needed);
            if (_sideBySide)
            {
                double each = double.IsInfinity(widthConstraint) ? needed.Max() : (widthConstraint - (Spacing * (buttons.Count - 1))) / buttons.Count;
                double tallest = buttons.Max(b => b.Measure(each, heightConstraint).Height);
                return new Size(double.IsInfinity(widthConstraint) ? (each * buttons.Count) + (Spacing * (buttons.Count - 1)) : widthConstraint, tallest);
            }

            double total = buttons.Sum(b => b.Measure(widthConstraint, double.PositiveInfinity).Height) + (StackSpacing * (buttons.Count - 1));
            return new Size(widthConstraint, total);
        }

        public Size ArrangeChildren(Rect bounds)
        {
            List<IView> buttons = Buttons;
            if (_sideBySide)
            {
                double each = buttons.Count == 0 ? 0 : (bounds.Width - (Spacing * (buttons.Count - 1))) / buttons.Count;
                double x = bounds.X;
                foreach (IView button in buttons)
                {
                    button.Arrange(new Rect(x, bounds.Y, each, bounds.Height));
                    x += each + Spacing;
                }
            }
            else
            {
                double y = bounds.Y;
                foreach (IView button in buttons)
                {
                    double height = button.DesiredSize.Height;
                    button.Arrange(new Rect(bounds.X, y, bounds.Width, height));
                    y += height + StackSpacing;
                }
            }

            return bounds.Size;
        }
    }
}
