using System.Text.Json;
using System.Text.Json.Serialization;

namespace Notato.Maui.Model;

// The wire shapes of @notato/schema (packages/schema/src/index.ts), which is the contract with the server.
// Enumerations travel as strings so a value added to the schema later does not break reading what the server sends.

/// <summary>What an annotation asks for. <c>question</c> wants an answer, not an edit.</summary>
public static class AnnotationIntents
{
    public const string Fix = "fix";
    public const string Change = "change";
    public const string Question = "question";
    public const string Approve = "approve";
    public const string Variants = "variants";
}

public static class Severities
{
    public const string Blocker = "blocker";
    public const string Major = "major";
    public const string Minor = "minor";
    public const string Nit = "nit";
}

/// <summary>open → acknowledged → resolved; a resolved change can be asked to be undone (revert_requested → reverted).</summary>
public static class Statuses
{
    public const string Open = "open";
    public const string Acknowledged = "acknowledged";
    public const string VariantChosen = "variant_chosen";
    public const string Resolved = "resolved";
    public const string RevertRequested = "revert_requested";
    public const string Reverted = "reverted";
    public const string Dismissed = "dismissed";
}

public static class Modes
{
    public const string Dev = "dev";
    public const string Test = "test";
    public const string Agent = "agent";
}

public static class TargetKinds
{
    public const string Element = "element";
    public const string Text = "text";
    public const string Area = "area";
    public const string Multi = "multi";
}

public sealed record Author
{
    /// <summary><c>human</c> or <c>agent</c>.</summary>
    public required string Kind { get; init; }
    public string? Name { get; init; }

    public static Author Human(string? name) => new() { Kind = "human", Name = string.IsNullOrWhiteSpace(name) ? null : name.Trim() };
    public static Author Agent(string? name) => new() { Kind = "agent", Name = string.IsNullOrWhiteSpace(name) ? null : name.Trim() };
}

/// <summary>A rectangle in device-independent units, from the top left of the window.</summary>
public sealed record PageRect(double X, double Y, double W, double H);

public sealed record AssetRef
{
    public required string Id { get; init; }
    /// <summary><c>image/png</c> or <c>image/webp</c>.</summary>
    public required string Mime { get; init; }
    public required int W { get; init; }
    public required int H { get; init; }
    public string? Path { get; init; }
}

/// <summary>Where an element is written: a path from the repository root and the 1-based line and column.</summary>
public sealed record SourceLocation
{
    public required string File { get; init; }
    public required int Line { get; init; }
    public required int Col { get; init; }
    /// <summary>Set when the element itself has no location and this is the closest element around it that has one.</summary>
    public bool? Nearest { get; init; }
}

public sealed record ComponentInfo
{
    public required string Name { get; init; }
    /// <summary>"path:line:col" when known.</summary>
    public string? Source { get; init; }
    /// <summary>The components around the element, outermost first.</summary>
    public IReadOnlyList<string>? Path { get; init; }
}

public sealed record WithinStep
{
    /// <summary><c>frame</c> or <c>shadow</c> on the web.</summary>
    public required string Kind { get; init; }
    public required string Selector { get; init; }
}

public sealed record ElementIdentity
{
    /// <summary>On MAUI, a path through the visual tree, e.g. <c>LoginPage &gt; Grid &gt; Button#SignIn</c>.</summary>
    public required string Selector { get; init; }
    /// <summary>The element's AutomationId: MAUI's equivalent of a test id.</summary>
    public string? TestId { get; init; }
    public string? Role { get; init; }
    public string? Name { get; init; }
    /// <summary>The control's type name.</summary>
    public required string Tag { get; init; }
    public IReadOnlyList<string>? Classes { get; init; }
    /// <summary>Visible text, at most 200 characters.</summary>
    public string? Text { get; init; }
    public SourceLocation? Source { get; init; }
    public ComponentInfo? Component { get; init; }
    public IReadOnlyDictionary<string, string>? Styles { get; init; }
    public IReadOnlyList<WithinStep>? Within { get; init; }
    public IReadOnlyList<string>? Ancestors { get; init; }
    /// <summary>The element's AutomationId.</summary>
    public string? PlatformId { get; init; }
}

public sealed record AgentStep
{
    public required string Action { get; init; }
    public string? Target { get; init; }
    public string? Value { get; init; }
    public required string At { get; init; }
}

public sealed record Reply
{
    public required string Id { get; init; }
    public required Author Author { get; init; }
    public required string Body { get; init; }
    public required string CreatedAt { get; init; }
    /// <summary>Written by Notato to record something a person did (turning People only on or off), not something they said.</summary>
    public bool? Automatic { get; init; }
    /// <summary>
    /// An aside: a remark for the people on the thread. The agent is not sent it or shown it. Set by the person who
    /// writes it, when they send it.
    /// </summary>
    public bool? Aside { get; init; }
    /// <summary>
    /// Only on the automatic entry that records someone turning People only on (<c>true</c>) or off (<c>false</c>) for
    /// the note.
    /// </summary>
    public bool? PeopleOnly { get; init; }
}

public sealed record Viewport(double W, double H);

public sealed record EnvironmentInfo
{
    public required string UserAgent { get; init; }
    public required Viewport Viewport { get; init; }
    public required double Dpr { get; init; }
    /// <summary><c>web</c>, <c>maui</c>, <c>ios</c>, <c>android</c>, or a newer SDK's.</summary>
    public required string Platform { get; init; }
    /// <summary>The package that made the note, and its version. Absent from notes made before 0.2.</summary>
    public SdkInfo? Sdk { get; init; }
}

public sealed record SdkInfo(string Name, string Version);

public sealed record Target
{
    public required string Kind { get; init; }
    public required IReadOnlyList<ElementIdentity> Identity { get; init; }
    public required PageRect Rect { get; init; }
    public string? SelectedText { get; init; }
}

public sealed record VariantOption
{
    public required string Name { get; init; }
    public string? Summary { get; init; }
}

public sealed record Variants
{
    public required string Group { get; init; }
    public required IReadOnlyList<VariantOption> Options { get; init; }
    public required string OfferedAt { get; init; }
    public string? Chosen { get; init; }
    public string? ChosenAt { get; init; }
}

public sealed record Screenshots
{
    /// <summary>The whole window, with the target outlined.</summary>
    public required AssetRef Full { get; init; }
    public AssetRef? Crop { get; init; }
}

public sealed record Annotation
{
    /// <summary>A ULID.</summary>
    public required string Id { get; init; }
    public required string ProjectId { get; init; }
    /// <summary>Null outside a bundle. Always written, because the schema requires the key.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? BundleId { get; init; }
    public required Author Author { get; init; }
    public required string Mode { get; init; }
    /// <summary>ISO 8601.</summary>
    public required string CreatedAt { get; init; }

    public required string Url { get; init; }
    public required string Route { get; init; }
    public string? AppName { get; init; }
    public string? AppVersion { get; init; }
    public required EnvironmentInfo Environment { get; init; }

    public required Target Target { get; init; }
    public required string Comment { get; init; }
    public string? Severity { get; init; }
    public string? Intent { get; init; }
    public Variants? Variants { get; init; }

    public Screenshots? Screenshots { get; init; }
    public IReadOnlyList<AgentStep>? Steps { get; init; }
    /// <summary>Keyed by plugin id, e.g. <c>console</c>, <c>network</c>, <c>maui</c>. The server never interprets it.</summary>
    public required IReadOnlyDictionary<string, JsonElement> Context { get; init; }

    public required string Status { get; init; }
    public required IReadOnlyList<Reply> Thread { get; init; }

    /// <summary>
    /// People only: the note and its whole thread are between people, and never reach the agent. <c>true</c> when on,
    /// and left out (null) when off. Anyone on the thread can turn it on or off; each change is recorded in the thread.
    /// </summary>
    public bool? PeopleOnly { get; init; }
}

public sealed record Bundle
{
    public required string Id { get; init; }
    public required string ProjectId { get; init; }
    public required string CreatedAt { get; init; }
    public required BundleAuthor Author { get; init; }
    public string? AppName { get; init; }
    public string? AppVersion { get; init; }
    public required IReadOnlyList<Annotation> Annotations { get; init; }
    public int SchemaVersion { get; init; } = 1;
}

public sealed record BundleAuthor
{
    public string? Name { get; init; }
}

/// <summary>An annotation as the server stores it: with the order it arrived in.</summary>
public sealed record StoredAnnotation
{
    public required Annotation Annotation { get; init; }
    public long Seq { get; init; }
}
