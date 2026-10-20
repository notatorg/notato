using Notato.Maui.Capture;
using SkiaSharp;

namespace Notato.Maui.Tests;

public sealed class ScreenshotEncodingTests
{
    [Fact]
    public void WebpKeepsDimensionsAndMaskedPixelsWithoutGrowingTheUpload()
    {
        using SKBitmap bitmap = new(320, 480);
        using SKCanvas canvas = new(bitmap);
        canvas.Clear(SKColors.White);
        using SKPaint paint = new();
        Random random = new(7);
        for (int y = 0; y < 480; y++)
        {
            for (int x = 0; x < 320; x++)
            {
                bitmap.SetPixel(x, y, new SKColor((byte)random.Next(256), (byte)random.Next(256), (byte)random.Next(256)));
            }
        }

        paint.Color = new SKColor(156, 163, 175);
        canvas.DrawRect(60, 100, 200, 200, paint);
        using SKImage image = SKImage.FromBitmap(bitmap);
        using SKData png = image.Encode(SKEncodedImageFormat.Png, 100);
        ScreenshotEncoding.Encoded encoded = ScreenshotEncoding.Encode(png.ToArray());
        Assert.Equal("image/webp", encoded.Mime);
        Assert.True(encoded.Bytes.Length < png.Size);
        using SKBitmap decoded = SKBitmap.Decode(encoded.Bytes);
        Assert.Equal((320, 480), (decoded.Width, decoded.Height));
        SKColor masked = decoded.GetPixel(160, 200);
        Assert.InRange(masked.Red, 150, 162);
        Assert.InRange(masked.Green, 157, 169);
        Assert.InRange(masked.Blue, 169, 181);
    }

    [Fact]
    public void UnreadableInputIsPreservedForTheExistingPngErrorPath()
    {
        byte[] original = [1, 2, 3];
        ScreenshotEncoding.Encoded encoded = ScreenshotEncoding.Encode(original);
        Assert.Same(original, encoded.Bytes);
        Assert.Equal("image/png", encoded.Mime);
    }
}
