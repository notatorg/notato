using System.Globalization;

namespace Notato.Maui.Util;

/// <summary>Times as the notes and the server write them: UTC, to the millisecond, <c>2026-10-05T21:12:02.121Z</c>.</summary>
internal static class Timestamps
{
    public static string Now() => DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
