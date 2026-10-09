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

    /// <summary>The notes' version at the last look: when it changes, the pins not found are looked for again.</summary>
    public int NotesVersion { get; set; } = -1;

    /// <summary>The pins and the selection are following what the app shows on every frame.</summary>
    public bool Following { get; set; }

    /// <summary>When something last moved, or may have (<see cref="Environment.TickCount64"/>).</summary>
    public long MovedAt { get; set; }
}

/// <summary>What is selected in one window, and the picture taken when it was.</summary>
internal sealed class SelectionState(List<VisualElement> elements, CapturedScreen? screen) : IDisposable
{
    private bool _disposed;

    public List<VisualElement> Elements { get; set; } = elements;

    /// <summary>The picture, until a note takes it (and disposes it) or the selection goes (<see cref="Dispose"/>).</summary>
    public CapturedScreen? Screen { get; private set; } = screen;

    /// <summary>The picture being taken for it (once the note being written has come in): done when it is.</summary>
    public Task Taking { get; set; } = Task.CompletedTask;

    /// <summary>The picture taken for it. One that arrives after the selection went is let go at once.</summary>
    public void Receive(CapturedScreen? screen)
    {
        if (_disposed)
        {
            screen?.Dispose();
            return;
        }

        Screen?.Dispose();
        Screen = screen;
    }

    /// <summary>Waits for the picture to be taken, then hands it over (see <see cref="TakeScreen"/>).</summary>
    public async Task<CapturedScreen?> TakeScreenAsync()
    {
        await Taking;
        return TakeScreen();
    }

    /// <summary>Hands the picture over to whoever disposes it now: the selection no longer has it.</summary>
    public CapturedScreen? TakeScreen()
    {
        CapturedScreen? screen = Screen;
        Screen = null;
        return screen;
    }

    /// <summary>The selection is replaced or cancelled: its picture, a whole screen's bitmap, goes with it.</summary>
    public void Dispose()
    {
        _disposed = true;
        TakeScreen()?.Dispose();
    }
}
