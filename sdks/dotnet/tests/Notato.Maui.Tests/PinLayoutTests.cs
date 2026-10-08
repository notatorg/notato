using Microsoft.Maui.Graphics;
using Notato.Maui.Overlay;

namespace Notato.Maui.Tests;

/// <summary>Pins beside each other on a shared element, and always placed: never a loop that cannot end.</summary>
public class PinLayoutTests
{
    private static readonly Size Phone = new(402, 874);
    private const double Top = 62;

    private static List<Point> PlaceAll(Rect target, int count, Size room)
    {
        List<Point> taken = [];
        for (int i = 0; i < count; i++)
        {
            taken.Add(PinLayout.Place(target, taken, room, Top));
        }

        return taken;
    }

    private static bool Overlap(Point a, Point b) => Math.Abs(a.X - b.X) < 20 && Math.Abs(a.Y - b.Y) < 20;

    [Fact]
    public void One_pin_sits_on_the_top_right_corner()
    {
        Assert.Equal(new Point(288, 188), PinLayout.Place(new Rect(16, 200, 284, 40), [], Phone, Top));
        // Kept on screen at the right edge.
        Assert.Equal(new Point(376, 188), PinLayout.Place(new Rect(16, 200, 386, 40), [], Phone, Top));
    }

    [Fact]
    public void A_second_pin_goes_to_the_left_of_the_first()
    {
        List<Point> pins = PlaceAll(new Rect(16, 200, 200, 40), 2, Phone);
        Assert.Equal([new Point(204, 188), new Point(182, 188)], pins);
    }

    [Theory]
    // Two notes on an element whose right edge is under ~34: the old loop clamped at 2 beside the first pin for ever.
    [InlineData(0, 30, 2)]
    [InlineData(0, 14, 2)]
    [InlineData(0, 33, 2)]
    // Several notes on an element at the left edge.
    [InlineData(0, 120, 8)]
    [InlineData(-40, 20, 5)]
    public void Pins_near_the_left_edge_spread_right_instead_of_hanging(double x, double width, int count)
    {
        List<Point> pins = PlaceAll(new Rect(x, 300, width, 40), count, Phone);

        Assert.Equal(count, pins.Count);
        for (int i = 0; i < pins.Count; i++)
        {
            Assert.InRange(pins[i].X, 2, Phone.Width - 26);
            for (int j = 0; j < i; j++)
            {
                Assert.False(Overlap(pins[i], pins[j]), $"pin {i} at {pins[i]} is on pin {j} at {pins[j]}");
            }
        }
    }

    [Fact]
    public void A_full_row_continues_on_the_row_below()
    {
        Size narrow = new(80, 874);
        List<Point> pins = PlaceAll(new Rect(0, 300, 80, 40), 6, narrow);
        Assert.Equal(3, pins.Count(p => p.Y == pins[0].Y));
        Assert.All(pins.Skip(3), p => Assert.Equal(pins[0].Y + 22, p.Y));
    }

    [Fact]
    public void With_no_room_left_a_pin_overlaps_rather_than_waits()
    {
        Size tiny = new(30, 100);
        List<Point> pins = PlaceAll(new Rect(0, 80, 30, 20), 40, tiny);
        Assert.Equal(40, pins.Count);
    }

    [Fact]
    public void A_box_that_is_not_laid_out_yet_still_gets_a_place()
    {
        List<Point> pins = PlaceAll(new Rect(double.NaN, double.NaN, double.NaN, double.NaN), 3, new Size(-1, -1));
        Assert.Equal(3, pins.Count);
    }
}
