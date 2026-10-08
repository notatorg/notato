namespace Notato.Maui.Model;

/// <summary>
/// People only on a note, and Aside on a reply: what people keep from the agent. The words are the same in every
/// Notato SDK, and the thread entry a change leaves is the one the server writes (packages/server/src/backend.ts).
/// </summary>
internal static class PeopleOnlyToggle
{
    public const string Label = "People only";
    public const string Hint = "Keep this between people: the agent won't see it.";
    public const string AsideLabel = "Aside";
    public const string AsideHint = "Just for people: the agent won't see this reply.";

    /// <summary>The thread entry for turning People only on, as the server words it.</summary>
    public const string TurnedOn = "Made this people only: the agent won't see it.";

    /// <summary>The thread entry for turning People only off, as the server words it.</summary>
    public const string TurnedOff = "Shared this with the agent.";

    public static bool IsOn(Annotation annotation) => annotation.PeopleOnly == true;

    /// <summary>The wire value: <c>true</c> when on, left out when off.</summary>
    public static bool? Flag(bool on) => on ? true : null;

    /// <summary>The automatic thread entry that records <paramref name="author"/> turning People only on or off.</summary>
    public static Reply Entry(bool on, Author author, string id, string createdAt) => new()
    {
        Id = id,
        Author = author,
        Body = on ? TurnedOn : TurnedOff,
        CreatedAt = createdAt,
        Automatic = true,
        PeopleOnly = on,
    };

    /// <summary>
    /// The note with People only turned on or off on this device (no server, or not sent yet), and the change recorded
    /// in its thread as the server would record it, so a packaged bundle carries the history. Unchanged when it already
    /// is that way, as on the server.
    /// </summary>
    public static Annotation Set(Annotation annotation, bool on, Author author, string id, string createdAt) =>
        IsOn(annotation) == on
            ? annotation
            : annotation with { PeopleOnly = Flag(on), Thread = [.. annotation.Thread, Entry(on, author, id, createdAt)] };

    /// <summary>
    /// The People only change to make again on the server's copy of a note that was still to be sent here: when it was
    /// turned on or off on this device after the server took its first copy (the answer to that send was lost), the
    /// server's copy does not have it. That is so when the two disagree and the latest change here is not in the
    /// server's thread. Null when there is nothing to make again, or the server's copy is the newer word.
    /// </summary>
    public static (bool On, Author By)? ToReplay(Annotation here, Annotation server)
    {
        if (IsOn(here) == IsOn(server))
        {
            return null;
        }

        Reply? latest = here.Thread.LastOrDefault(r => r is { Automatic: true, PeopleOnly: not null });
        return latest is null || server.Thread.Any(r => r.Id == latest.Id) ? null : (IsOn(here), latest.Author);
    }
}
