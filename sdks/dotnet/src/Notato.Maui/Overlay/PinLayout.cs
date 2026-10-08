using Microsoft.Maui.Graphics;

namespace Notato.Maui.Overlay;

/// <summary>Where each pin goes: on its element's top right corner, and beside the others when several share it.</summary>
internal static class PinLayout
{
    /// <summary>A pin's width and height.</summary>
    public const double Diameter = 24;

    /// <summary>How far apart pins that would touch are put, side by side or row by row.</summary>
    private const double Step = 22;

    /// <summary>Two pins closer than this, across and down, are on top of each other.</summary>
    private const double Apart = 20;

    /// <summary>Places tried before giving up and letting the pin overlap: a few rows' worth.</summary>
    private const int MaxTries = 64;

    /// <summary>
    /// The top left of a pin for <paramref name="target"/>, clear of the pins already placed: its own place first, then
    /// further left, then further right, then the same along each row below. When none is clear (a crowded corner)
    /// it goes on its own place, over the others.
    /// </summary>
    /// <param name="target">The element's box.</param>
    /// <param name="taken">The top left of each pin already placed.</param>
    /// <param name="room">The overlay's size.</param>
    /// <param name="top">The top of the area pins may use (below the status bar).</param>
    public static Point Place(Rect target, IReadOnlyList<Point> taken, Size room, double top)
    {
        const double minX = 2;
        double maxX = Math.Max(minX, room.Width - Diameter - 2);
        double maxY = Math.Max(top, room.Height - Diameter - 2);
        Point home = new(Math.Clamp(target.Right - (Diameter / 2), minX, maxX), Math.Clamp(target.Top - (Diameter / 2), top, maxY));
        int tries = 0;
        // Bounded by rows as well as tries, so even a box that is not a number (not laid out yet) ends.
        for (int row = 0; row < MaxTries && tries < MaxTries; row++)
        {
            double y = home.Y + (row * Step);
            if (y > maxY)
            {
                break;
            }

            // Leftwards from its own place to the edge, then rightwards: the first that is clear.
            for (double x = home.X; x >= minX && tries < MaxTries; x -= Step, tries++)
            {
                if (Clear(x, y, taken))
                {
                    return new Point(x, y);
                }
            }

            for (double x = home.X + Step; x <= maxX && tries < MaxTries; x += Step, tries++)
            {
                if (Clear(x, y, taken))
                {
                    return new Point(x, y);
                }
            }
        }
        return home;
    }

    private static bool Clear(double x, double y, IReadOnlyList<Point> taken)
    {
        foreach (Point t in taken)
        {
            if (Math.Abs(t.X - x) < Apart && Math.Abs(t.Y - y) < Apart)
            {
                return false;
            }
        }
        return true;
    }
}
