using Notato.Maui.Model;

namespace Notato.Maui;

/// <summary>
/// A note as Notato holds it: the annotation, and what only this device knows about it (whether it is still to be
/// sent, why the server turned it down, where its screenshots are kept, the element it was made on).
/// </summary>
internal sealed class NoteRecord(Annotation annotation)
{
    private Annotation _annotation = annotation;
    private bool _pending;

    /// <summary>The set the note is in, told when it changes so each screen's notes are worked out again.</summary>
    internal RecordSet? Owner { get; set; }

    public Annotation Annotation
    {
        get => _annotation;
        set
        {
            _annotation = value;
            Owner?.Touch();
        }
    }

    /// <summary>Made here and not yet taken by the server (or, in test mode, not yet packaged).</summary>
    public bool Pending
    {
        get => _pending;
        set
        {
            _pending = value;
            Owner?.Touch();
        }
    }

    /// <summary>The server turned this note down for good, and why: it is not sent again.</summary>
    public string? Error { get; set; }

    /// <summary>Why the last try at sending it did not go through, when the server said: it is tried again.</summary>
    public string? Held { get; set; }

    /// <summary>Made on this device in this run.</summary>
    public bool Mine { get; set; }

    /// <summary>The element it was made on, in this run.</summary>
    public PinTarget? Element { get; set; }

    /// <summary>Where its screenshots are kept on the device, by asset id, until the server (or a package) has them.</summary>
    public IReadOnlyDictionary<string, string>? Assets { get; set; }
}
