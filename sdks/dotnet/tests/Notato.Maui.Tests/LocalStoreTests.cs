using Notato.Maui.Model;
using Notato.Maui.Runtime;

namespace Notato.Maui.Tests;

/// <summary>The notes kept on the device: ids from the server never reach outside the store's own folder.</summary>
public sealed class LocalStoreTests : IDisposable
{
    private readonly string _appData = Path.Combine(Path.GetTempPath(), "notato-store-tests-" + Guid.NewGuid().ToString("N"));
    private readonly string _parent;

    public LocalStoreTests()
    {
        _parent = Path.Combine(_appData, "notato");
        Directory.CreateDirectory(_parent);
        // Something of the app's own, next to Notato's folder, that must survive whatever the server says.
        File.WriteAllText(Path.Combine(_appData, "app-settings.json"), "{}");
    }

    public void Dispose()
    {
        if (Directory.Exists(_appData))
        {
            Directory.Delete(_appData, recursive: true);
        }
    }

    private static Annotation Note(string id) => Fixtures.Annotation() with { Id = id };

    private static readonly Dictionary<string, byte[]> Shot = new() { [new string('a', 64)] = [1, 2, 3] };

    [Theory]
    [InlineData("../..")]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("../../app-settings.json")]
    [InlineData("a/b")]
    [InlineData("a\\b")]
    [InlineData("")]
    public async Task An_id_from_the_server_that_names_a_path_deletes_nothing(string id)
    {
        LocalStore store = new(_parent, "maui-sample");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);

        await store.RemoveAsync(id);

        Assert.True(File.Exists(Path.Combine(_appData, "app-settings.json")));
        Assert.Single(await store.LoadAsync());
    }

    [Fact]
    public async Task A_plain_id_is_removed_and_one_that_is_not_is_never_written()
    {
        LocalStore store = new(_parent, "maui-sample");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);
        await store.SaveAsync(Note("../escaped"), Shot);
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), new Dictionary<string, byte[]> { ["../../shot"] = [1] });

        Assert.False(Directory.Exists(Path.Combine(_parent, "escaped")));
        Assert.False(File.Exists(Path.Combine(_appData, "shot.png")));
        LocalAnnotation kept = Assert.Single(await store.LoadAsync());
        Assert.Equal([new string('a', 64)], kept.Assets.Keys);

        await store.RemoveAsync("01M46YHJA6PBM210JB4H2WMY14");
        Assert.Empty(await store.LoadAsync());
    }

    [Theory]
    [InlineData("maui-sample", "maui-sample")]
    [InlineData("team@app.v2", "team@app.v2")]
    [InlineData("..", "p-2e2e")]
    [InlineData(".", "p-2e")]
    [InlineData("...", "p-2e2e2e")]
    [InlineData("café", "p-636166c3a9")]
    public void A_project_keeps_its_folder_when_it_is_a_plain_name(string project, string folder) =>
        Assert.Equal(folder, LocalStore.FolderName(project));

    [Fact]
    public void A_long_project_that_is_not_a_plain_name_still_fits_in_a_file_name()
    {
        string folder = LocalStore.FolderName(new string('é', 128));
        Assert.StartsWith("p-", folder);
        Assert.True(folder.Length <= 66, folder);
    }

    [Fact]
    public async Task Clearing_a_project_called_dot_dot_leaves_the_app_data_alone()
    {
        LocalStore store = new(_parent, "..");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);
        Assert.StartsWith(_parent + Path.DirectorySeparatorChar, store.Root);

        await store.ClearAsync();

        Assert.True(File.Exists(Path.Combine(_appData, "app-settings.json")));
        Assert.True(Directory.Exists(_parent));
        Assert.Empty(await store.LoadAsync());
    }

    [Fact]
    public void Paths_are_inside_only_when_they_stay_inside_once_resolved()
    {
        Assert.True(LocalStore.IsInside(_parent, Path.Combine(_parent, "p", "x")));
        Assert.False(LocalStore.IsInside(_parent, _parent));
        Assert.False(LocalStore.IsInside(_parent, Path.Combine(_parent, "..")));
        Assert.False(LocalStore.IsInside(_parent, Path.Combine(_parent, "p", "..", "..", "x")));
        Assert.False(LocalStore.IsInside(_parent, _parent + "-sibling"));
    }

    [Fact]
    public async Task A_refusal_is_remembered_across_a_restart()
    {
        LocalStore store = new(_parent, "maui-sample");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY15"), Shot);
        await store.MarkRefusedAsync("01M46YHJA6PBM210JB4H2WMY14", "upload exceeds 10485760 bytes");

        IReadOnlyList<LocalAnnotation> loaded = await new LocalStore(_parent, "maui-sample").LoadAsync();

        Assert.Equal("upload exceeds 10485760 bytes", loaded.Single(n => n.Annotation.Id.EndsWith("14", StringComparison.Ordinal)).Refused);
        Assert.Null(loaded.Single(n => n.Annotation.Id.EndsWith("15", StringComparison.Ordinal)).Refused);
    }

    [Fact]
    public async Task Screenshots_stay_on_disk_and_only_where_they_are_is_kept()
    {
        LocalStore store = new(_parent, "maui-sample");
        IReadOnlyDictionary<string, string> kept = await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);

        string path = Assert.Single(kept.Values);
        Assert.Equal([1, 2, 3], File.ReadAllBytes(path));
        Assert.StartsWith(store.Root, path);

        // Saving the note again (People only turned on, say) keeps its screenshots without being given them.
        IReadOnlyDictionary<string, string> again = await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14") with { PeopleOnly = true });
        Assert.Equal(kept, again);
        LocalAnnotation loaded = Assert.Single(await store.LoadAsync());
        Assert.True(loaded.Annotation.PeopleOnly);
        Assert.Equal(path, loaded.Assets[new string('a', 64)]);
    }

    [Fact]
    public async Task A_write_cut_short_leaves_the_last_whole_note_and_is_cleared_away()
    {
        LocalStore store = new(_parent, "maui-sample");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);
        string folder = Path.Combine(store.Root, "01M46YHJA6PBM210JB4H2WMY14");
        // What a crash part way through the next save leaves: half a new note beside the whole old one.
        await File.WriteAllTextAsync(Path.Combine(folder, "annotation.json.tmp"), "{\"id\":\"01M46");
        await File.WriteAllBytesAsync(Path.Combine(folder, new string('c', 64) + ".png.tmp"), [9]);

        LocalAnnotation loaded = Assert.Single(await store.LoadAsync());

        Assert.Equal("The sale text is almost invisible.", loaded.Annotation.Comment);
        Assert.Equal([new string('a', 64)], loaded.Assets.Keys);
        Assert.Empty(Directory.GetFiles(folder, "*.tmp"));
        Assert.Empty(Directory.GetFiles(store.Root, "*.tmp", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task A_note_that_cannot_be_read_is_skipped_and_the_rest_still_load()
    {
        LocalStore store = new(_parent, "maui-sample");
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY14"), Shot);
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY15"));
        await store.SaveAsync(Note("01M46YHJA6PBM210JB4H2WMY16"));
        // One damaged, and one the system will not let it read.
        await File.WriteAllTextAsync(Path.Combine(store.Root, "01M46YHJA6PBM210JB4H2WMY15", "annotation.json"), "{ not json");
        string unreadable = Path.Combine(store.Root, "01M46YHJA6PBM210JB4H2WMY16", "annotation.json");
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(unreadable, UnixFileMode.None);
        }

        try
        {
            IReadOnlyList<LocalAnnotation> loaded = await store.LoadAsync();

            // Windows has no such mode, and root reads anything: there, that note loads.
            Assert.Equal(Readable(unreadable)
                ? ["01M46YHJA6PBM210JB4H2WMY14", "01M46YHJA6PBM210JB4H2WMY16"]
                : ["01M46YHJA6PBM210JB4H2WMY14"], loaded.Select(n => n.Annotation.Id));
            // Left where they are rather than lost.
            Assert.True(File.Exists(Path.Combine(store.Root, "01M46YHJA6PBM210JB4H2WMY15", "annotation.json")));
            Assert.True(File.Exists(unreadable));
        }
        finally
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(unreadable, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
    }

    private static bool Readable(string path)
    {
        try
        {
            using FileStream _ = File.OpenRead(path);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    [Theory]
    [InlineData("01M46YHJA6PBM210JB4H2WMY14", true)]
    [InlineData("5f0c6b1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", true)]
    [InlineData("..", false)]
    [InlineData("a.b", false)]
    [InlineData("a/b", false)]
    [InlineData("", false)]
    public void Safe_ids_are_the_servers(string id, bool safe) => Assert.Equal(safe, LocalStore.IsSafeId(id));
}
