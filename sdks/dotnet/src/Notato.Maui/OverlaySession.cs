using Microsoft.Maui.Controls;
using Notato.Maui.Native;
using Notato.Maui.Overlay;

namespace Notato.Maui;

/// <summary>Notato in one of the app's windows.</summary>
internal sealed class OverlaySession(Window window, IOverlayHost host)
{
    public Window Window { get; } = window;

    public IOverlayHost Host { get; } = host;

    public NotatoOverlay View { get; set; } = null!;

    public SelectionState? Selection { get; set; }

    public string Route { get; set; } = "";

    /// <summary>The element each note's pin was found on in this window.</summary>
    public Dictionary<string, PinTarget> Resolved { get; } = [];

    /// <summary>Notes whose element was not on screen at the last look, and when to look again.</summary>
    public Dictionary<string, long> Missed { get; } = [];

    /// <summary>How many times the pins have been placed in this window: some checks run only every few.</summary>
    public int Ticks { get; set; }
}

/// <summary>What is selected in one window, and the picture taken when it was.</summary>
internal sealed class SelectionState(List<VisualElement> elements, CapturedScreen? screen) : IDisposable
{
    public List<VisualElement> Elements { get; set; } = elements;

    /// <summary>The picture, until a note takes it (and disposes it) or the selection goes (<see cref="Dispose"/>).</summary>
    public CapturedScreen? Screen { get; private set; } = screen;

    /// <summary>Hands the picture over to whoever disposes it now: the selection no longer has it.</summary>
    public CapturedScreen? TakeScreen()
    {
        CapturedScreen? screen = Screen;
        Screen = null;
        return screen;
    }

    /// <summary>The selection is replaced or cancelled: its picture, a whole screen's bitmap, goes with it.</summary>
    public void Dispose() => TakeScreen()?.Dispose();
}
