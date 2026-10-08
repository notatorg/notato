using Microsoft.Maui.Controls;
using Notato.Maui.Model;

namespace Notato.Maui;

/// <summary>How Notato stands with its server.</summary>
public enum NotatoConnection
{
    /// <summary>Notato is switched off.</summary>
    Disabled,
    /// <summary>No server is configured: notes stay on the device (test mode) until packaged.</summary>
    Local,
    /// <summary>Opening the connection to the server, or opening it again after it was lost.</summary>
    Connecting,
    /// <summary>Connected: notes are sent as they are made, and the server's changes arrive as they happen.</summary>
    Connected,
    /// <summary>The server cannot be reached. Notes are kept and sent when it can.</summary>
    Offline,
    /// <summary>The server refused this app (a missing or wrong token, a project the token cannot use).</summary>
    Refused,
}

/// <summary>Optional details for <see cref="INotato.AnnotateAsync(VisualElement, string, AnnotateOptions?, CancellationToken)"/>.</summary>
public sealed record AnnotateOptions
{
    /// <summary><see cref="Severities"/>: blocker, major, minor, nit.</summary>
    public string? Severity { get; init; }
    /// <summary><see cref="AnnotationIntents"/>: fix, change, question, approve.</summary>
    public string? Intent { get; init; }
    /// <summary>Recorded as an agent's note when set; a person's otherwise.</summary>
    public string? AgentName { get; init; }
    /// <summary>What was done to get here, for agent mode.</summary>
    public IReadOnlyList<AgentStep>? Steps { get; init; }
    /// <summary>Take a screenshot (when allowed). Defaults to true.</summary>
    public bool Screenshot { get; init; } = true;
    /// <summary>
    /// People only: the note and its thread are between people, and never reach the agent. Only for a person's note,
    /// not with <see cref="AgentName"/>.
    /// </summary>
    public bool PeopleOnly { get; init; }
}

/// <summary>
/// Notato at runtime. Resolve it from DI (or use <see cref="Feedback.Current"/>) to switch it on and off, start
/// annotating, select an element, or annotate one from code.
/// </summary>
public interface INotato
{
    /// <summary>Whether Notato is on: the toolbar can show, notes can be made, the server connection is open.</summary>
    bool IsEnabled { get; }

    /// <summary>Switches Notato on. Remembered across launches unless <see cref="NotatoOptions.RememberRuntimeState"/> is off.</summary>
    void Enable();

    /// <summary>Switches Notato off: removes the overlay and closes the connection. Remembered like <see cref="Enable"/>.</summary>
    void Disable();

    /// <summary>Forgets the choices made at runtime (on or off, toolbar, name, server) and goes back to the configured options.</summary>
    void ResetRuntimeState();

    /// <summary>Whether the floating toolbar is showing. Shaking the device toggles it too.</summary>
    bool IsToolbarVisible { get; }

    /// <summary>Shows the floating toolbar. Remembered across launches like <see cref="Enable"/>.</summary>
    void ShowToolbar();

    /// <summary>
    /// Hides the floating toolbar; the app can still drive Notato from code. Remembered across launches like
    /// <see cref="Enable"/>.
    /// </summary>
    void HideToolbar();

    /// <summary>Whether the next tap picks an element to annotate.</summary>
    bool IsAnnotating { get; }

    /// <summary>Enters annotate mode: the next tap selects what is under it.</summary>
    void StartAnnotating();

    /// <summary>Leaves annotate mode, and drops a selection and the note being written for it.</summary>
    void StopAnnotating();

    /// <summary>Selects an element as if it had been tapped, and opens the note for it.</summary>
    /// <exception cref="InvalidOperationException">Notato is off, or the element is not in a window Notato is in.</exception>
    Task SelectAsync(VisualElement element);

    /// <summary>Makes an annotation on an element without any UI, as a person or (with <see cref="AnnotateOptions.AgentName"/>) an agent.</summary>
    /// <remarks>
    /// <paramref name="cancellationToken"/> cancels it until the note is made. After that it only cuts short the wait
    /// for the upload: the note is kept, and sent with the others that are waiting.
    /// </remarks>
    /// <exception cref="ArgumentException">The comment is empty, or an agent's note asks to be People only.</exception>
    /// <exception cref="InvalidOperationException">Notato is off, or the element is not in a window Notato is in.</exception>
    Task<Annotation> AnnotateAsync(VisualElement element, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default);

    /// <summary>
    /// Makes an annotation on the element a selector finds in the visible page, e.g. <c>#SignIn</c>,
    /// <c>Button:text("Sign in")</c> or <c>LoginPage Entry[x:Name=Email]</c>.
    /// </summary>
    /// <exception cref="FormatException">The selector cannot be read.</exception>
    /// <exception cref="InvalidOperationException">No element on the screen matches it.</exception>
    Task<Annotation> AnnotateAsync(string selector, string comment, AnnotateOptions? options = null, CancellationToken cancellationToken = default);

    /// <summary>
    /// The annotations Notato knows of for this project, from the server and from this device, as they were at the last
    /// change (<see cref="Changed"/>): a copy that never changes, safe to read from any thread.
    /// </summary>
    IReadOnlyList<Annotation> Annotations { get; }

    /// <summary>Notes made on this device that have not reached the server yet, as of the last change. Safe from any thread.</summary>
    int PendingCount { get; }

    /// <summary>How Notato stands with its server now.</summary>
    NotatoConnection Connection { get; }

    /// <summary>The last connection problem, fit to show to a person.</summary>
    string? ConnectionDetail { get; }

    /// <summary>
    /// Packages this device's notes as a bundle zip (<c>feedback.md</c>, <c>annotations.json</c>, <c>shots/</c>), the
    /// format <c>notato_import_bundle</c> reads. Uploads it when a server is set. Returns the zip's path.
    /// </summary>
    /// <exception cref="InvalidOperationException">There are no notes to package.</exception>
    /// <exception cref="Net.NotatoServerException">The upload failed; the zip is written all the same.</exception>
    Task<string> PackageAsync(bool upload = true, CancellationToken cancellationToken = default);

    /// <summary>Raised on the main thread when any of the above changes.</summary>
    event EventHandler? Changed;
}
