using Microsoft.Maui.Graphics;
using Microsoft.Maui.Graphics.Platform;
using Notato.Maui.Model;
using Notato.Maui.Native;
using System.Globalization;
using System.Security.Cryptography;

namespace Notato.Maui.Capture;

/// <summary>The two pictures an annotation carries: the whole window with the target outlined, and a crop around it.</summary>
internal sealed record ComposedScreenshots(Screenshots Refs, IReadOnlyDictionary<string, byte[]> Assets, PageRect? CropRect = null);

/// <summary>Draws the outline, the pin number and the masks onto a captured window, and cuts the crop.</summary>
internal static class ScreenshotComposer
{
    /// <summary>The selection's red, as the overlay draws it.</summary>
    private static readonly Color Outline = Color.FromArgb("#e5484d");
    /// <summary>The grey a private part of the screen is covered with.</summary>
    private static readonly Color Mask = Color.FromArgb("#9ca3af");
    /// <summary>An open pin's teal.</summary>
    private static readonly Color PinFill = Color.FromArgb("#1f8a78");
    /// <summary>How much of the screen around the target the crop takes in, in device-independent units.</summary>
    private const double CropPadding = 24;

    public static string AssetId(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static ComposedScreenshots? Compose(CapturedScreen screen, IReadOnlyList<Rect> targets, int? pin, IReadOnlyList<Rect> masks, double maxScale, bool derivedCrops = false)
    {
#if IOS || MACCATALYST || ANDROID
        double scale = Math.Max(1, Math.Min(screen.Scale, maxScale));
        double dipWidth = screen.PixelWidth / screen.Scale;
        double dipHeight = screen.PixelHeight / screen.Scale;
        int width = (int)Math.Round(dipWidth * scale);
        int height = (int)Math.Round(dipHeight * scale);
        PlatformBitmapExportService service = new();

        Rect Px(Rect r) => new(r.X * scale, r.Y * scale, r.Width * scale, r.Height * scale);

        byte[] full;
        using (BitmapExportContext context = service.CreateContext(width, height, 1))
        {
            ICanvas canvas = context.Canvas;
            canvas.DrawImage(screen.Image, 0, 0, width, height);
            canvas.FillColor = Mask;
            foreach (Rect m in masks)
            {
                canvas.FillRectangle(Px(m));
            }

            canvas.StrokeColor = Outline;
            canvas.StrokeSize = (float)(2 * scale);
            foreach (Rect t in targets)
            {
                canvas.DrawRectangle(Px(t).Inflate(-scale, -scale));
            }

            if (pin is { } number && targets.Count > 0)
            {
                DrawPin(canvas, Px(targets[0]), number, scale);
            }

            full = Png(context);
        }

        byte[]? crop = null;
        PageRect? cropRect = null;
        int cropWidth = 0, cropHeight = 0;
        if (targets.Count > 0)
        {
            Rect union = targets.Aggregate((a, b) => a.Union(b));
            Rect area = union.Inflate(CropPadding, CropPadding).Intersect(new Rect(0, 0, dipWidth, dipHeight));
            if (area.Width >= 4 && area.Height >= 4)
            {
                Rect px = Px(area);
                cropWidth = Math.Max(1, (int)Math.Round(px.Width));
                cropHeight = Math.Max(1, (int)Math.Round(px.Height));
                if (derivedCrops)
                {
                    int x = Math.Max(0, (int)Math.Floor(px.X));
                    int y = Math.Max(0, (int)Math.Floor(px.Y));
                    cropRect = new PageRect(x, y, Math.Min(width - x, cropWidth), Math.Min(height - y, cropHeight));
                }
                else
                {
                    using BitmapExportContext context = service.CreateContext(cropWidth, cropHeight, 1);
                    ICanvas canvas = context.Canvas;
                    canvas.DrawImage(screen.Image, (float)-px.X, (float)-px.Y, width, height);
                    canvas.FillColor = Mask;
                    foreach (Rect m in masks)
                    {
                        canvas.FillRectangle(Px(m).Offset(-px.X, -px.Y));
                    }

                    canvas.StrokeColor = Outline;
                    canvas.StrokeSize = (float)(2 * scale);
                    foreach (Rect t in targets)
                    {
                        canvas.DrawRectangle(Px(t).Offset(-px.X, -px.Y).Inflate(-scale, -scale));
                    }

                    crop = Png(context);
                }
            }
        }

        Dictionary<string, byte[]> assets = [];
        ScreenshotEncoding.Encoded encodedFull = ScreenshotEncoding.Encode(full);
        AssetRef fullRef = new() { Id = AssetId(encodedFull.Bytes), Mime = encodedFull.Mime, W = width, H = height };
        assets[fullRef.Id] = encodedFull.Bytes;
        AssetRef? cropRef = null;
        if (crop is not null)
        {
            ScreenshotEncoding.Encoded encodedCrop = ScreenshotEncoding.Encode(crop);
            cropRef = new AssetRef { Id = AssetId(encodedCrop.Bytes), Mime = encodedCrop.Mime, W = cropWidth, H = cropHeight };
            assets[cropRef.Id] = encodedCrop.Bytes;
        }
        return new ComposedScreenshots(new Screenshots { Full = fullRef, Crop = cropRef }, assets, cropRect);
#else
        return null;
#endif
    }

    private static void DrawPin(ICanvas canvas, Rect target, int number, double scale)
    {
        float r = (float)(12 * scale);
        float cx = (float)Math.Min(target.Right, target.Right - 2 * scale);
        float cy = (float)Math.Max(r, target.Top);
        canvas.FillColor = PinFill;
        canvas.FillCircle(cx, cy, r);
        canvas.StrokeColor = Colors.White;
        canvas.StrokeSize = (float)(2 * scale);
        canvas.DrawCircle(cx, cy, r);
        canvas.FontColor = Colors.White;
        canvas.FontSize = (float)(12 * scale);
        canvas.Font = Microsoft.Maui.Graphics.Font.DefaultBold;
        canvas.DrawString(number.ToString(CultureInfo.InvariantCulture), cx - r, cy - r, 2 * r, 2 * r, HorizontalAlignment.Center, VerticalAlignment.Center);
    }

    private static byte[] Png(BitmapExportContext context)
    {
        using MemoryStream stream = new();
        context.WriteToStream(stream);
        return stream.ToArray();
    }
}
