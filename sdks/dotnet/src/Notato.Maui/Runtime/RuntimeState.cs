using Microsoft.Maui.Graphics;
using Microsoft.Maui.Storage;
using System.Globalization;

namespace Notato.Maui.Runtime;

/// <summary>
/// What a person chose on the device, kept in <see cref="Preferences"/> so it survives a restart: whether Notato is on,
/// the toolbar, their name, a server typed in, where they dragged the toolbar and whether they folded it. Each unset
/// value falls back to the options.
/// </summary>
internal sealed class RuntimeState(bool remember)
{
    private const string Prefix = "notato.";
    private readonly Dictionary<string, string> _memory = [];

    private string? Get(string key)
    {
        if (!remember)
        {
            return _memory.GetValueOrDefault(key);
        }

        try
        {
            return Preferences.Default.ContainsKey(Prefix + key) ? Preferences.Default.Get<string?>(Prefix + key, null) : null;
        }
        catch (Exception) when (!OperatingSystem.IsIOS() && !OperatingSystem.IsAndroid() && !OperatingSystem.IsMacCatalyst())
        {
            // Plain net10.0 (unit tests) has no preferences store.
            return _memory.GetValueOrDefault(key);
        }
    }

    private void Set(string key, string? value)
    {
        if (value is null)
        {
            _memory.Remove(key);
        }
        else
        {
            _memory[key] = value;
        }

        if (!remember)
        {
            return;
        }

        try
        {
            if (value is null)
            {
                Preferences.Default.Remove(Prefix + key);
            }
            else
            {
                Preferences.Default.Set(Prefix + key, value);
            }
        }
        catch (Exception) when (!OperatingSystem.IsIOS() && !OperatingSystem.IsAndroid() && !OperatingSystem.IsMacCatalyst())
        {
        }
    }

    private static bool? Bool(string? value) => value is null ? null : value == "1";
    private static string? Bool(bool? value) => value is null ? null : value.Value ? "1" : "0";

    public bool? Enabled { get => Bool(Get("enabled")); set => Set("enabled", Bool(value)); }
    public bool? ToolbarVisible { get => Bool(Get("toolbar")); set => Set("toolbar", Bool(value)); }
    public bool? Screenshots { get => Bool(Get("screenshots")); set => Set("screenshots", Bool(value)); }
    public bool? PinsVisible { get => Bool(Get("pins")); set => Set("pins", Bool(value)); }
    public string? Author { get => Get("author"); set => Set("author", string.IsNullOrWhiteSpace(value) ? null : value.Trim()); }
    public string? Server { get => Get("server"); set => Set("server", string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/')); }

    /// <summary>Where the toolbar was dragged to, as fractions of the window so it survives rotation.</summary>
    public Point? ToolbarPosition
    {
        get
        {
            string? raw = Get("toolbar.position");
            if (raw is null)
            {
                return null;
            }

            string[] parts = raw.Split(',');
            return parts.Length == 2
                && double.TryParse(parts[0], CultureInfo.InvariantCulture, out double x)
                && double.TryParse(parts[1], CultureInfo.InvariantCulture, out double y)
                ? new Point(Math.Clamp(x, 0, 1), Math.Clamp(y, 0, 1))
                : null;
        }
        set => Set("toolbar.position", value is { } p ? FormattableString.Invariant($"{p.X:0.####},{p.Y:0.####}") : null);
    }

    /// <summary>Whether the toolbar was left folded into its round button.</summary>
    public bool? ToolbarCollapsed { get => Bool(Get("toolbar.collapsed")); set => Set("toolbar.collapsed", Bool(value)); }

    public void Reset()
    {
        foreach (string key in new[] { "enabled", "toolbar", "screenshots", "pins", "author", "server", "toolbar.position", "toolbar.collapsed" })
        {
            Set(key, null);
        }
    }
}
