using Microsoft.Extensions.Logging;
using Notato.Maui.Model;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Notato.Maui.Runtime;

/// <summary>
/// An annotation made on this device, where its screenshots are kept (a file per asset id: the pictures themselves
/// stay on disk, not in memory), and why the server turned it down for good (<c>Refused</c>) when it did: it is not
/// sent again.
/// </summary>
internal sealed record LocalAnnotation(Annotation Annotation, IReadOnlyDictionary<string, string> Assets, string? Refused = null);

/// <summary>
/// Notes made on this device, on disk until the server has them: a note made while the server is down still reaches
/// the agent later, and a tester's notes survive a restart until they are packaged. One folder per annotation:
/// <c>annotation.json</c> and one file per screenshot.
/// </summary>
/// <remarks>
/// Ids can come from the server, so none is joined into a path unless it is a plain id
/// (<see cref="IsSafeId"/>), and nothing is deleted outside the store's own folder. Every file is written whole or not
/// at all (to a temporary file first, then moved over the old one), so a write cut short never leaves half a note.
/// </remarks>
internal sealed partial class LocalStore
{
    private const string RefusedFile = "refused.txt";
    private const string NoteFile = "annotation.json";
    private const string Temporary = ".tmp";

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$")]
    private static partial Regex SafeId();

    /// <summary>A project id that can name a folder as it is: never only dots, which would name a parent.</summary>
    [GeneratedRegex(@"^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$")]
    private static partial Regex SafeFolder();

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _parent;
    private readonly ILogger? _logger;
    private readonly HashSet<string> _warned = [];

    /// <param name="parent">The folder that holds every project's store.</param>
    /// <param name="project">The project, whose notes get a folder of their own inside <paramref name="parent"/>.</param>
    /// <param name="logger">Told once about each id that is not safe to use as a file name.</param>
    public LocalStore(string parent, string project, ILogger? logger = null)
    {
        _parent = Path.GetFullPath(parent);
        _logger = logger;
        Root = Path.Combine(_parent, FolderName(project));
    }

    public string Root { get; }

    /// <summary>An annotation or screenshot id that can name a file: the server's <c>SafeId</c>.</summary>
    public static bool IsSafeId(string? id) => id is not null && SafeId().IsMatch(id);

    /// <summary>
    /// The project's folder name: the project id itself when it is a plain name (so notes kept by earlier versions are
    /// found again), else <c>p-</c> and its UTF-8 in hex, or a hash of it when that would be too long for a file name.
    /// </summary>
    public static string FolderName(string project)
    {
        if (SafeFolder().IsMatch(project))
        {
            return project;
        }

        byte[] utf8 = Encoding.UTF8.GetBytes(project);
        return "p-" + Convert.ToHexStringLower(utf8.Length <= 100 ? utf8 : System.Security.Cryptography.SHA256.HashData(utf8));
    }

    /// <summary>Whether <paramref name="path"/> is strictly inside <paramref name="folder"/>, after resolving any <c>..</c>.</summary>
    public static bool IsInside(string folder, string path)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder)) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(path);
        return full.Length > root.Length && full.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    /// <summary>The note's folder, or null (and a warning, once) when its id must not touch the file system.</summary>
    private string? FolderOf(string id)
    {
        if (!Usable(id, "annotation"))
        {
            return null;
        }

        string folder = Path.Combine(Root, id);
        return IsInside(Root, folder) ? folder : null;
    }

    private bool Usable(string? id, string what)
    {
        if (IsSafeId(id))
        {
            return true;
        }

        // Callers hold the gate, so the set is never written by two at once.
        if (_warned.Add($"{what}:{id}"))
        {
            _logger?.LogWarning("Notato left {What} id \"{Id}\" off the device: it is not a plain id", what, id);
        }

        return false;
    }

    /// <summary>
    /// Keeps a note: its screenshots (<paramref name="pictures"/>, by asset id; those kept already stay), then the note
    /// itself. Returns where each of its screenshots now is.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, string>> SaveAsync(Annotation annotation, IReadOnlyDictionary<string, byte[]>? pictures = null)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (FolderOf(annotation.Id) is not { } folder)
            {
                return new Dictionary<string, string>();
            }

            Directory.CreateDirectory(folder);
            foreach ((string id, byte[] bytes) in pictures ?? new Dictionary<string, byte[]>())
            {
                if (Usable(id, "screenshot"))
                {
                    await WriteWholeAsync(Path.Combine(folder, id + ".png"), bytes).ConfigureAwait(false);
                }
            }

            byte[] json = JsonSerializer.SerializeToUtf8Bytes(annotation, NotatoJsonContext.Default.Annotation);
            // Written last, so a folder without it is a half-written note and is skipped.
            await WriteWholeAsync(Path.Combine(folder, NoteFile), json).ConfigureAwait(false);
            return PicturesIn(folder);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Writes a file whole or not at all: to a temporary file beside it, then moved over it. A crash or a full disk part
    /// way through leaves the old file (or none), never half of the new one.
    /// </summary>
    internal static async Task WriteWholeAsync(string path, byte[] bytes)
    {
        string temporary = path + Temporary;
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes).ConfigureAwait(false);
            File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            TryDelete(temporary);
            throw;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // left for the next load to clear
        }
    }

    /// <summary>The note's screenshots on disk, by asset id.</summary>
    private static Dictionary<string, string> PicturesIn(string folder)
    {
        Dictionary<string, string> pictures = [];
        foreach (string png in Directory.GetFiles(folder, "*.png"))
        {
            string id = Path.GetFileNameWithoutExtension(png);
            if (IsSafeId(id))
            {
                pictures[id] = png;
            }
        }
        return pictures;
    }

    /// <summary>Remembers that the server turned this note down for good, so it is not sent again after a restart.</summary>
    public async Task MarkRefusedAsync(string id, string reason)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (FolderOf(id) is { } folder && Directory.Exists(folder))
            {
                await WriteWholeAsync(Path.Combine(folder, RefusedFile), Encoding.UTF8.GetBytes(reason)).ConfigureAwait(false);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The notes kept here, oldest first, with where their screenshots are (they are not read). A note that cannot be
    /// read (damaged, or a file the system will not open) is skipped, and said so in the log, and left where it is
    /// rather than lost: the others still load.
    /// </summary>
    public async Task<IReadOnlyList<LocalAnnotation>> LoadAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!Directory.Exists(Root))
            {
                return [];
            }

            List<LocalAnnotation> items = [];
            foreach (string folder in Directory.GetDirectories(Root))
            {
                try
                {
                    if (await LoadOneAsync(folder).ConfigureAwait(false) is { } item)
                    {
                        items.Add(item);
                    }
                }
                catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
                {
                    _logger?.LogWarning("Notato skipped a note kept on this device that it could not read ({Folder}): {Problem}", Path.GetFileName(folder), error.Message);
                }
            }
            return [.. items.OrderBy(i => i.Annotation.CreatedAt, StringComparer.Ordinal).ThenBy(i => i.Annotation.Id, StringComparer.Ordinal)];
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<LocalAnnotation?> LoadOneAsync(string folder)
    {
        // What a write cut short left behind: the file it was replacing is still there (or never was).
        foreach (string left in Directory.GetFiles(folder, "*" + Temporary))
        {
            TryDelete(left);
        }

        string file = Path.Combine(folder, NoteFile);
        if (!File.Exists(file))
        {
            return null;
        }

        Annotation? annotation;
        await using (FileStream stream = File.OpenRead(file))
        {
            annotation = await JsonSerializer.DeserializeAsync(stream, NotatoJsonContext.Default.Annotation).ConfigureAwait(false);
        }
        // A note that could not be removed again once sent is left where it is.
        if (annotation is null || !Usable(annotation.Id, "annotation"))
        {
            return null;
        }

        string refusedFile = Path.Combine(folder, RefusedFile);
        string? refused = File.Exists(refusedFile) ? await File.ReadAllTextAsync(refusedFile).ConfigureAwait(false) : null;
        return new LocalAnnotation(annotation, PicturesIn(folder), string.IsNullOrWhiteSpace(refused) ? null : refused);
    }

    /// <summary>Forgets a note. One that cannot be removed now (a file still open, on Windows) is left and said so in the log.</summary>
    public async Task RemoveAsync(string id)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (FolderOf(id) is { } folder && Directory.Exists(folder))
            {
                Directory.Delete(folder, recursive: true);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            _logger?.LogWarning("Notato could not remove note {Id} from this device: {Problem}", id, error.Message);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ClearAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            // Only ever the project's own folder, never the one that holds every project (or anything above it).
            if (IsInside(_parent, Root) && Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
        finally
        {
            _gate.Release();
        }
    }
}
