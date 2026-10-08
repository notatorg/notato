using Notato.Maui.Model;
using System.Collections;
using System.Collections.ObjectModel;
using Record = Notato.Maui.NotatoController.Record;

namespace Notato.Maui;

/// <summary>
/// The notes Notato knows of, in the order they came, with an index by id kept in step with them. Each screen's notes
/// (numbered as their pins are) are worked out once after a change rather than at every look. Only ever used on the
/// main thread.
/// </summary>
internal sealed class RecordSet : IEnumerable<Record>
{
    /// <summary>The most pins drawn on one screen: the newest. The Notes list has every one. The React Native and Flutter SDKs draw as many.</summary>
    public const int MaxPins = 150;

    /// <summary>What this SDK writes as a note's <c>environment.platform</c>. Only these notes are pinned: a web page's selector means nothing here.</summary>
    public const string Platform = "maui";

    private readonly List<Record> _list = [];
    private readonly Dictionary<string, Record> _byId = new(StringComparer.Ordinal);
    private readonly HashSet<string> _deleted = new(StringComparer.Ordinal);
    private Dictionary<string, Screen>? _screens;
    private int _screensVersion = -1;

    /// <summary>A screen's notes, oldest first and numbered, and those of them that get a pin.</summary>
    private sealed record Screen(IReadOnlyList<(int Number, Record Record)> All, IReadOnlyList<(int Number, Record Record)> Pinned);

    /// <summary>Goes up with every change to the set or to a note in it.</summary>
    public int Version { get; private set; }

    public int Count => _list.Count;

    public Record? Find(string id) => _byId.GetValueOrDefault(id);

    /// <summary>Adds a note; one with the same id is replaced where it stands.</summary>
    public void Add(Record record)
    {
        string id = record.Annotation.Id;
        if (_byId.TryGetValue(id, out Record? existing))
        {
            _list[_list.IndexOf(existing)] = record;
            existing.Owner = null;
        }
        else
        {
            _list.Add(record);
        }

        _byId[id] = record;
        record.Owner = this;
        Touch();
    }

    public bool Remove(string id) => RemoveAll(r => r.Annotation.Id == id) > 0;

    public int RemoveAll(Predicate<Record> match)
    {
        int removed = _list.RemoveAll(r =>
        {
            if (!match(r))
            {
                return false;
            }

            _byId.Remove(r.Annotation.Id);
            r.Owner = null;
            return true;
        });
        if (removed > 0)
        {
            Touch();
        }

        return removed;
    }

    public void Clear()
    {
        foreach (Record r in _list)
        {
            r.Owner = null;
        }

        _list.Clear();
        _byId.Clear();
        Touch();
    }

    /// <summary>Deleted here in this run: no copy the server sends afterwards (an event on its way, a list, the answer to a send) brings it back.</summary>
    public void MarkDeleted(string id) => _deleted.Add(id);

    public bool WasDeleted(string id) => _deleted.Contains(id);

    /// <summary>A note in the set changed (its copy, or whether it is still to be sent).</summary>
    internal void Touch() => Version++;

    /// <summary>The ids of the notes the server has already taken.</summary>
    public HashSet<string> SettledIds()
    {
        HashSet<string> ids = new(StringComparer.Ordinal);
        foreach (Record r in _list)
        {
            if (!r.Pending)
            {
                ids.Add(r.Annotation.Id);
            }
        }

        return ids;
    }

    /// <summary>The notes on a screen, oldest first, numbered as their pins are.</summary>
    public IReadOnlyList<(int Number, Record Record)> On(string route) =>
        Screens().TryGetValue(route, out Screen? screen) ? screen.All : [];

    /// <summary>
    /// The notes on a screen that get a pin: the ones made by this SDK (<see cref="Platform"/>), the newest
    /// <see cref="MaxPins"/> of them. Each keeps the number it has among all the screen's notes.
    /// </summary>
    public IReadOnlyList<(int Number, Record Record)> PinnedOn(string route) =>
        Screens().TryGetValue(route, out Screen? screen) ? screen.Pinned : [];

    private Dictionary<string, Screen> Screens()
    {
        if (_screens is not null && _screensVersion == Version)
        {
            return _screens;
        }

        Dictionary<string, List<Record>> groups = new(StringComparer.Ordinal);
        foreach (Record r in _list)
        {
            string route = r.Annotation.Route;
            if (!groups.TryGetValue(route, out List<Record>? group))
            {
                groups[route] = group = [];
            }

            group.Add(r);
        }

        Dictionary<string, Screen> screens = new(groups.Count, StringComparer.Ordinal);
        foreach ((string route, List<Record> group) in groups)
        {
            group.Sort(static (a, b) =>
            {
                int byTime = string.CompareOrdinal(a.Annotation.CreatedAt, b.Annotation.CreatedAt);
                return byTime != 0 ? byTime : string.CompareOrdinal(a.Annotation.Id, b.Annotation.Id);
            });
            List<(int Number, Record Record)> all = new(group.Count);
            List<(int Number, Record Record)> pinned = [];
            for (int i = 0; i < group.Count; i++)
            {
                all.Add((i + 1, group[i]));
                if (group[i].Annotation.Environment.Platform == Platform)
                {
                    pinned.Add((i + 1, group[i]));
                }
            }
            if (pinned.Count > MaxPins)
            {
                pinned.RemoveRange(0, pinned.Count - MaxPins);
            }

            screens[route] = new Screen(all, pinned);
        }
        _screens = screens;
        _screensVersion = Version;
        return screens;
    }

    /// <summary>The notes as they are now, for other threads to read: a copy that never changes.</summary>
    public (IReadOnlyList<Annotation> Annotations, int Pending) Snapshot()
    {
        Annotation[] annotations = new Annotation[_list.Count];
        int pending = 0;
        for (int i = 0; i < _list.Count; i++)
        {
            annotations[i] = _list[i].Annotation;
            if (_list[i].Pending)
            {
                pending++;
            }
        }
        return (new ReadOnlyCollection<Annotation>(annotations), pending);
    }

    public List<Record>.Enumerator GetEnumerator() => _list.GetEnumerator();

    IEnumerator<Record> IEnumerable<Record>.GetEnumerator() => _list.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => _list.GetEnumerator();
}

/// <summary>
/// The server's list of a project's notes, read into what merging it needs while still off the main thread: the
/// project's notes in the server's order, and every id the server listed.
/// </summary>
internal sealed class ServerList
{
    public ServerList(IReadOnlyList<StoredAnnotation> items, string project)
    {
        List<Annotation> notes = new(items.Count);
        HashSet<string> ids = new(items.Count, StringComparer.Ordinal);
        foreach (StoredAnnotation item in items)
        {
            ids.Add(item.Annotation.Id);
            if (item.Annotation.ProjectId == project)
            {
                notes.Add(item.Annotation);
            }
        }
        Notes = notes;
        Ids = ids;
    }

    public IReadOnlyList<Annotation> Notes { get; }

    public HashSet<string> Ids { get; }
}
