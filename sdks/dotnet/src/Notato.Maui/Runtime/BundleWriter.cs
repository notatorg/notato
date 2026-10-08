using Notato.Maui.Model;
using Notato.Maui.Util;
using System.IO.Compression;
using System.Text;
using System.Text.Json;

namespace Notato.Maui.Runtime;

/// <summary>
/// Writes a tester's notes as the bundle zip the rest of Notato reads (packages/core/src/bundle.ts):
/// <c>annotations.json</c>, a <c>feedback.md</c> to read top to bottom, and the screenshots in <c>shots/</c>. The zip
/// is written straight to its file, off the main thread, with each screenshot copied in from its own file: a bundle is
/// never held in memory whole.
/// </summary>
internal static class BundleWriter
{
    /// <summary>The largest bundle the server takes (packages/server/src/http.ts, DEFAULT_MAX_BUNDLE).</summary>
    public const long ServerLimit = 100L * 1024 * 1024;

    /// <summary>Writes the zip into <paramref name="folder"/>, and returns its path.</summary>
    public static Task<string> WriteAsync(IReadOnlyList<LocalAnnotation> items, string project, string? author,
        string? appName, string? appVersion, string folder, CancellationToken ct) => Task.Run(() =>
    {
        Bundle bundle = Build(items, project, author, appName, appVersion, out Dictionary<string, string>? files);
        Directory.CreateDirectory(folder);
        string path = System.IO.Path.Combine(folder, $"notato-{project}-{DateTime.Now:yyyyMMdd-HHmm}.zip");
        string temporary = path + ".tmp";
        try
        {
            using (FileStream output = new(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                Zip(bundle, files, output, ct);
            }

            File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            File.Delete(temporary);
            throw;
        }
        return path;
    }, ct);

    /// <summary>The bundle, and its screenshots: each zip entry's name and the file it is copied from.</summary>
    internal static Bundle Build(IReadOnlyList<LocalAnnotation> items, string project, string? author, string? appName, string? appVersion,
        out Dictionary<string, string> files)
    {
        string id = Ulid.New();
        files = [];
        List<Annotation> annotations = [];
        for (int i = 0; i < items.Count; i++)
        {
            (Annotation? a, IReadOnlyDictionary<string, string>? assets) = (items[i].Annotation, items[i].Assets);
            string n = (i + 1).ToString("00", System.Globalization.CultureInfo.InvariantCulture);
            Screenshots? shots = null;
            if (a.Screenshots is { } s && Kept(assets, s.Full.Id) is { } fullFile)
            {
                AssetRef full = s.Full with { Path = $"shots/{n}-full.png" };
                files[full.Path] = fullFile;
                AssetRef? crop = null;
                if (s.Crop is { } c && Kept(assets, c.Id) is { } cropFile)
                {
                    crop = c with { Path = $"shots/{n}-crop.png" };
                    files[crop.Path] = cropFile;
                }
                shots = new Screenshots { Full = full, Crop = crop };
            }
            annotations.Add(a with { BundleId = id, Mode = Modes.Test, Screenshots = shots });
        }
        return new Bundle
        {
            Id = id,
            ProjectId = project,
            CreatedAt = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            Author = new BundleAuthor { Name = author },
            AppName = appName,
            AppVersion = appVersion,
            Annotations = annotations,
            SchemaVersion = 1,
        };
    }

    /// <summary>The file a screenshot is kept in, when it is still there.</summary>
    private static string? Kept(IReadOnlyDictionary<string, string> assets, string id) =>
        assets.TryGetValue(id, out string? file) && File.Exists(file) ? file : null;

    /// <summary>Writes the zip to <paramref name="output"/>, copying each screenshot from its file.</summary>
    internal static void Zip(Bundle bundle, IReadOnlyDictionary<string, string> files, Stream output, CancellationToken ct = default)
    {
        using ZipArchive archive = new(output, ZipArchiveMode.Create, leaveOpen: true);
        void Add(string name, byte[] bytes, CompressionLevel level)
        {
            ZipArchiveEntry entry = archive.CreateEntry(name, level);
            using Stream to = entry.Open();
            to.Write(bytes);
        }
        Add("feedback.md", Encoding.UTF8.GetBytes(Markdown(bundle)), CompressionLevel.Optimal);
        Add("annotations.json", JsonSerializer.SerializeToUtf8Bytes(bundle, NotatoJsonContext.Default.Bundle), CompressionLevel.Optimal);
        // Screenshots are compressed already.
        foreach ((string? name, string? file) in files)
        {
            ct.ThrowIfCancellationRequested();
            ZipArchiveEntry entry = archive.CreateEntry(name, CompressionLevel.NoCompression);
            using Stream to = entry.Open();
            using FileStream from = File.OpenRead(file);
            from.CopyTo(to);
        }
    }

    private static string OneLine(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    internal static string Markdown(Bundle bundle)
    {
        StringBuilder sb = new();
        sb.Append("# Feedback").Append(bundle.AppName is null ? "" : $" for {bundle.AppName}").Append(bundle.AppVersion is null ? "" : $" {bundle.AppVersion}").Append("\n\n");
        sb.Append($"Project `{bundle.ProjectId}` · bundle `{bundle.Id}` · ").Append(bundle.Author.Name is null ? "" : $"from {bundle.Author.Name} · ")
          .Append($"{bundle.CreatedAt} · {bundle.Annotations.Count} annotation{(bundle.Annotations.Count == 1 ? "" : "s")}\n");
        for (int i = 0; i < bundle.Annotations.Count; i++)
        {
            Annotation a = bundle.Annotations[i];
            sb.Append($"\n## {i + 1}. {a.Route}").Append(a.Severity is null ? "" : $" — {a.Severity}").Append("\n\n");
            foreach (string line in a.Comment.Split('\n'))
            {
                sb.Append("> ").Append(line.TrimEnd('\r')).Append('\n');
            }

            sb.Append('\n');
            if (a.Screenshots?.Full.Path is { } full)
            {
                sb.Append($"![Full screenshot, target outlined]({full})\n");
            }

            if (a.Screenshots?.Crop?.Path is { } crop)
            {
                sb.Append($"![Crop of the target]({crop})\n");
            }

            sb.Append('\n');
            for (int n = 0; n < a.Target.Identity.Count; n++)
            {
                ElementIdentity id = a.Target.Identity[n];
                string? said = id.Name ?? id.Text;
                sb.Append($"- Target{(a.Target.Identity.Count > 1 ? $" {n + 1}" : "")} ({a.Target.Kind}): {id.Role ?? id.Tag}")
                  .Append(said is null ? "" : $" “{OneLine(said)[..Math.Min(80, OneLine(said).Length)]}”").Append('\n');
                sb.Append($"  - Selector: `{id.Selector}`\n");
                if (id.TestId is not null)
                {
                    sb.Append($"  - Test id: `{id.TestId}`\n");
                }

                if (id.Source is { } src)
                {
                    sb.Append($"  - Written at: `{src.File}:{src.Line}:{src.Col}`{(src.Nearest == true ? " (the nearest element around it)" : "")}\n");
                }

                if (id.Component is { } c)
                {
                    sb.Append($"  - Component: {c.Name}").Append(c.Source is null ? "" : $" (`{c.Source}`)").Append('\n');
                }
            }
            sb.Append($"- Page: {a.Url}\n");
            sb.Append($"- Viewport: {a.Environment.Viewport.W}×{a.Environment.Viewport.H} @{a.Environment.Dpr}x · {a.Author.Name ?? a.Author.Kind} · {a.CreatedAt}\n");
            if (a.Steps is { Count: > 0 } steps)
            {
                sb.Append("\nSteps taken:\n");
                for (int n = 0; n < steps.Count; n++)
                {
                    AgentStep s = steps[n];
                    sb.Append($"{n + 1}. {s.Action}").Append(s.Target is null ? "" : $" `{s.Target}`").Append(s.Value is null ? "" : $" = {OneLine(s.Value)}").Append('\n');
                }
            }
        }
        return sb.ToString();
    }
}
