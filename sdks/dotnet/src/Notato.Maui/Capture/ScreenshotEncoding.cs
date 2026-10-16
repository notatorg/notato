using SkiaSharp;

namespace Notato.Maui.Capture;

/// <summary>Compresses already-masked screenshots without changing their dimensions or retaining metadata.</summary>
internal static class ScreenshotEncoding
{
    internal sealed record Encoded(byte[] Bytes, string Mime);

    internal static Encoded Encode(byte[] png)
    {
        try
        {
            using SKMemoryStream stream = new(png);
            using SKCodec? codec = SKCodec.Create(stream);
            if (codec is null || codec.Info.Width <= 0 || codec.Info.Height <= 0 ||
                (long)codec.Info.Width * codec.Info.Height > 16_000_000)
            {
                return new Encoded(png, "image/png");
            }

            using SKBitmap? bitmap = SKBitmap.Decode(codec);
            if (bitmap is null)
            {
                return new Encoded(png, "image/png");
            }

            using SKImage image = SKImage.FromBitmap(bitmap);
            using SKData? webp = image.Encode(SKEncodedImageFormat.Webp, 85);
            if (webp is not null && webp.Size > 0 && webp.Size < png.Length)
            {
                return new Encoded(webp.ToArray(), "image/webp");
            }
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or TypeInitializationException or InvalidOperationException or ArgumentException)
        {
            // Older app binaries and unsupported desktop runtimes can still send the original PNG.
        }

        return new Encoded(png, "image/png");
    }
}
