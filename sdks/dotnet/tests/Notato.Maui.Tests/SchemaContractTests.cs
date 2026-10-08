using Json.Schema;
using Notato.Maui.Model;
using Notato.Maui.Runtime;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Notato.Maui.Tests;

/// <summary>What the SDK sends must pass the schema the server validates against (packages/schema/schema.json).</summary>
public class SchemaContractTests
{
    private static JsonSchema Definition(string name)
    {
        JsonObject root = JsonNode.Parse(File.ReadAllText(Fixtures.SchemaPath()))!.AsObject();
        // Point the root at one definition, keeping the others reachable for $ref.
        root["$ref"] = $"#/definitions/{name}";
        return JsonSchema.FromText(root.ToJsonString());
    }

    /// <summary>A screenshot kept on disk, as the device keeps them; its path.</summary>
    private static string Write(string folder, string id, byte[] bytes)
    {
        string path = Path.Combine(folder, id + ".png");
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static void AssertValid(string definition, string json)
    {
        EvaluationResults result = Definition(definition).Evaluate(JsonDocument.Parse(json).RootElement, new EvaluationOptions { OutputFormat = OutputFormat.List });
        IEnumerable<string> problems = (result.Details ?? []).Where(d => d.Errors is { Count: > 0 }).SelectMany(d => d.Errors!.Select(e => $"{d.InstanceLocation}: {e.Value}"));
        Assert.True(result.IsValid, string.Join("\n", problems));
    }

    [Fact]
    public void An_annotation_as_sent_passes_the_schema()
    {
        AssertValid("Annotation", JsonSerializer.Serialize(Fixtures.Annotation(), NotatoJsonContext.Default.Annotation));
    }

    [Fact]
    public void The_check_is_real_an_annotation_the_server_would_refuse_fails_it()
    {
        Annotation bad = Fixtures.Annotation() with { Severity = "catastrophic" };
        string json = JsonSerializer.Serialize(bad, NotatoJsonContext.Default.Annotation);
        Assert.False(Definition("Annotation").Evaluate(JsonDocument.Parse(json).RootElement).IsValid);
        string noTag = JsonSerializer.Serialize(Fixtures.Annotation(), NotatoJsonContext.Default.Annotation).Replace("\"tag\":\"Border\",", "");
        Assert.False(Definition("Annotation").Evaluate(JsonDocument.Parse(noTag).RootElement).IsValid);
    }

    [Fact]
    public void A_minimal_annotation_passes_the_schema_and_keeps_bundleId_null()
    {
        Annotation minimal = Fixtures.Annotation() with { Screenshots = null, Steps = null, Severity = null, Intent = null, AppName = null, AppVersion = null, Context = new Dictionary<string, JsonElement>() };
        string json = JsonSerializer.Serialize(minimal, NotatoJsonContext.Default.Annotation);
        AssertValid("Annotation", json);
        Assert.Contains("\"bundleId\":null", json);
        Assert.DoesNotContain("\"severity\"", json);
    }

    [Fact]
    public void The_server_shape_reads_back_including_fields_this_SDK_does_not_know()
    {
        string json = JsonSerializer.Serialize(Fixtures.Annotation(), NotatoJsonContext.Default.Annotation)
            .Replace("\"status\":\"open\"", "\"status\":\"some_future_status\",\"newField\":{\"a\":1}");
        Annotation read = JsonSerializer.Deserialize(json, NotatoJsonContext.Default.Annotation)!;
        Assert.Equal("some_future_status", read.Status);
        Assert.Equal("ProductsPage Border#PromoBanner", read.Target.Identity[0].Selector);
        Assert.Equal(14, read.Target.Identity[0].Source!.Line);
    }

    [Fact]
    public void A_packaged_bundle_passes_the_schema_and_points_at_its_shots()
    {
        Annotation annotation = Fixtures.Annotation();
        string folder = Directory.CreateTempSubdirectory("notato-bundle-").FullName;
        Dictionary<string, string> assets = new()
        {
            [new string('a', 64)] = Write(folder, new string('a', 64), [1, 2, 3]),
            [new string('b', 64)] = Write(folder, new string('b', 64), [4, 5]),
        };
        Bundle bundle = BundleWriter.Build([new LocalAnnotation(annotation, assets)], "maui-sample", "Dom", "Sample", "1.0", out Dictionary<string, string>? files);
        AssertValid("Bundle", JsonSerializer.Serialize(bundle, NotatoJsonContext.Default.Bundle));
        Assert.Equal(1, bundle.SchemaVersion);
        Assert.All(bundle.Annotations, a => Assert.Equal(bundle.Id, a.BundleId));
        Assert.Equal("shots/01-full.png", bundle.Annotations[0].Screenshots!.Full.Path);
        Assert.Equal("shots/01-crop.png", bundle.Annotations[0].Screenshots!.Crop!.Path);

        MemoryStream written = new();
        BundleWriter.Zip(bundle, files, written);
        written.Position = 0;
        using ZipArchive zip = new(written);
        List<string> names = [.. zip.Entries.Select(e => e.FullName).Order()];
        Assert.Equal(["annotations.json", "feedback.md", "shots/01-crop.png", "shots/01-full.png"], names);
        using (MemoryStream crop = new())
        {
            zip.GetEntry("shots/01-crop.png")!.Open().CopyTo(crop);
            Assert.Equal([4, 5], crop.ToArray());
        }

        using StreamReader markdown = new(zip.GetEntry("feedback.md")!.Open());
        string text = markdown.ReadToEnd();
        Assert.Contains("> The sale text is almost invisible.", text);
        Assert.Contains("Written at: `src/App/Views/ProductsPage.xaml:14:14`", text);
    }

    [Fact]
    public void A_people_only_note_with_an_aside_and_its_history_passes_the_schema()
    {
        string json = JsonSerializer.Serialize(Fixtures.PeopleOnlyAnnotation(), NotatoJsonContext.Default.Annotation);
        AssertValid("Annotation", json);
        Assert.Contains("\"peopleOnly\":true", json);
        Assert.Contains("\"aside\":true", json);
        // The entry that records People only turned off says so with false, which must be written.
        Assert.Contains("\"automatic\":true,\"peopleOnly\":false", json);
    }

    [Fact]
    public void A_note_that_is_not_people_only_leaves_the_key_out_and_so_does_an_ordinary_reply()
    {
        Annotation note = Fixtures.Annotation() with
        {
            PeopleOnly = PeopleOnlyToggle.Flag(false),
            Thread = [new Reply { Id = "01M46YHK00PLAIN00000000001", Author = Author.Human("Dom"), Body = "Thanks!", CreatedAt = "2026-10-05T21:13:00.000Z" }],
        };
        string json = JsonSerializer.Serialize(note, NotatoJsonContext.Default.Annotation);
        AssertValid("Annotation", json);
        Assert.DoesNotContain("peopleOnly", json);
        Assert.DoesNotContain("aside", json);
    }

    [Fact]
    public void Each_kind_of_reply_passes_the_reply_schema()
    {
        foreach (Reply reply in Fixtures.PeopleOnlyAnnotation().Thread)
        {
            AssertValid("Reply", JsonSerializer.Serialize(reply, NotatoJsonContext.Default.Reply));
        }
    }

    [Fact]
    public void The_schema_knows_the_new_fields_a_wrong_type_fails_it()
    {
        string json = JsonSerializer.Serialize(Fixtures.PeopleOnlyAnnotation(), NotatoJsonContext.Default.Annotation);
        bool Valid(Action<JsonObject> spoil)
        {
            JsonObject note = JsonNode.Parse(json)!.AsObject();
            spoil(note);
            return Definition("Annotation").Evaluate(JsonDocument.Parse(note.ToJsonString()).RootElement).IsValid;
        }
        Assert.True(Valid(_ => { }));
        Assert.False(Valid(note => note["peopleOnly"] = "yes"));
        Assert.False(Valid(note => note["thread"]![1]!["aside"] = "yes"));
        Assert.False(Valid(note => note["thread"]![2]!["peopleOnly"] = "off"));
    }

    [Fact]
    public void A_bundle_carries_people_only_turned_on_while_offline_with_its_history()
    {
        Annotation offline = PeopleOnlyToggle.Set(Fixtures.Annotation(), true, Author.Human("Dom"), "01M46YHK00ON00000000000009", "2026-10-05T21:20:00.000Z");
        Bundle bundle = BundleWriter.Build([new LocalAnnotation(offline, new Dictionary<string, string>())], "maui-sample", "Dom", null, null, out Dictionary<string, string>? _);
        string json = JsonSerializer.Serialize(bundle, NotatoJsonContext.Default.Bundle);
        AssertValid("Bundle", json);
        Annotation packaged = Assert.Single(bundle.Annotations);
        Assert.True(packaged.PeopleOnly);
        Reply entry = Assert.Single(packaged.Thread);
        Assert.Equal((true, true, PeopleOnlyToggle.TurnedOn), (entry.Automatic, entry.PeopleOnly, entry.Body));
    }

    [Fact]
    public void A_bundle_without_screenshots_drops_dangling_references()
    {
        Bundle bundle = BundleWriter.Build([new LocalAnnotation(Fixtures.Annotation(), new Dictionary<string, string>())], "maui-sample", null, null, null, out Dictionary<string, string>? files);
        Assert.Null(bundle.Annotations[0].Screenshots);
        Assert.Empty(files);
        AssertValid("Bundle", JsonSerializer.Serialize(bundle, NotatoJsonContext.Default.Bundle));
    }
}
