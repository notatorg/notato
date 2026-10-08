using System.Text.Json;
using System.Text.Json.Serialization;

namespace Notato.Maui.Model;

/// <summary>Server responses that wrap the annotation shapes.</summary>
public sealed record AnnotationList
{
    public IReadOnlyList<StoredAnnotation> Items { get; init; } = [];

    /// <summary>Set when the page was full: ask again with <c>afterSeq</c> set to it for the rest. Older servers never send it.</summary>
    public long? Next { get; init; }
}

public sealed record ServerConfig
{
    public bool Screenshots { get; init; } = true;

    /// <summary>Whether an agent has Notato's MCP open. Absent from older servers.</summary>
    public AgentState? Agent { get; init; }

    /// <summary>What <c>@</c> can call: the server's mention plugins (none unless the server adds some). Absent from older servers.</summary>
    public List<MentionInfo>? Mentions { get; init; }
}

/// <summary>Whether a coding agent (through Notato's MCP) is connected, and waiting in <c>notato_watch</c>.</summary>
public sealed record AgentState
{
    public bool Connected { get; init; }
    public int Sessions { get; init; }
    public bool Watching { get; init; }
}

/// <summary>One of the server's mention plugins, such as <c>@jira</c>. The agent needs none: it gets everything people write.</summary>
public sealed record MentionInfo
{
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    /// <summary>Whether mentioning it does something now.</summary>
    public bool Available { get; init; }
}

public sealed record ErrorBody
{
    public string? Error { get; init; }
}

public sealed record AuthMe
{
    public string? Mode { get; init; }
    public bool AuthRequired { get; init; }
    public bool Authenticated { get; init; }
    public string? ProjectId { get; init; }
}

public sealed record ServerEventData
{
    public string? Id { get; init; }
    public string? ProjectId { get; init; }
    public long? Seq { get; init; }
    public Annotation? Annotation { get; init; }
}

/// <summary>What an agent asks this app to annotate, relayed from <c>notato_annotate</c>.</summary>
public sealed record AnnotateRequest
{
    public required string RequestId { get; init; }
    public required AnnotateRequestArgs Args { get; init; }
}

public sealed record AnnotateRequestArgs
{
    public required string Target { get; init; }
    public required string Comment { get; init; }
    public string? Severity { get; init; }
    public string? Intent { get; init; }
    public IReadOnlyList<AgentStep>? Steps { get; init; }
    public string? Author { get; init; }
}

public sealed record RelayResult
{
    public required bool Ok { get; init; }
    public string? AnnotationId { get; init; }
    public string? Error { get; init; }
}

public sealed record StatusChange
{
    public required string Status { get; init; }
    public string? Note { get; init; }
    public Author? Author { get; init; }
}

public sealed record ReplyBody
{
    public required string Body { get; init; }
    public Author? Author { get; init; }
    /// <summary>A remark for the people on the thread, kept from the agent: <c>true</c>, or left out.</summary>
    public bool? Aside { get; init; }
}

/// <summary>Turns People only on or off for a note (<c>PATCH /annotations/{id}</c>): only a person can.</summary>
public sealed record PeopleOnlyChange
{
    /// <summary>Always written, <c>false</c> included: it is the change.</summary>
    public required bool PeopleOnly { get; init; }
    public Author? Author { get; init; }
}

/// <summary>A message the SDK's log capture keeps, in the shape of the web SDK's <c>console</c> context.</summary>
public sealed record LogEntry
{
    public required string Level { get; init; }
    public required string Message { get; init; }
    public required string At { get; init; }
}

/// <summary>One HTTP request, in the shape of the web SDK's <c>network</c> context.</summary>
public sealed record NetworkEntry
{
    public required string Method { get; init; }
    public required string Url { get; init; }
    public required int Status { get; init; }
    public required long DurationMs { get; init; }
    public required string At { get; init; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(Annotation))]
[JsonSerializable(typeof(Bundle))]
[JsonSerializable(typeof(StoredAnnotation))]
[JsonSerializable(typeof(AnnotationList))]
[JsonSerializable(typeof(ServerConfig))]
[JsonSerializable(typeof(AgentState))]
[JsonSerializable(typeof(List<MentionInfo>))]
[JsonSerializable(typeof(ErrorBody))]
[JsonSerializable(typeof(AuthMe))]
[JsonSerializable(typeof(ServerEventData))]
[JsonSerializable(typeof(AnnotateRequest))]
[JsonSerializable(typeof(RelayResult))]
[JsonSerializable(typeof(StatusChange))]
[JsonSerializable(typeof(ReplyBody))]
[JsonSerializable(typeof(PeopleOnlyChange))]
[JsonSerializable(typeof(List<LogEntry>))]
[JsonSerializable(typeof(List<NetworkEntry>))]
[JsonSerializable(typeof(List<Annotation>))]
[JsonSerializable(typeof(Dictionary<string, JsonElement>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(double))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(bool))]
internal sealed partial class NotatoJsonContext : JsonSerializerContext;

internal static class NotatoJson
{
    /// <summary>Wraps a value as the JsonElement that <see cref="Annotation.Context"/> holds.</summary>
    public static JsonElement Element<T>(T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info) =>
        JsonSerializer.SerializeToElement(value, info);
}
