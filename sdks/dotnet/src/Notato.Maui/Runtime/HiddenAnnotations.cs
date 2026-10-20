using Notato.Maui.Model;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Notato.Maui.Runtime;

/// <summary>Device preferences, scoped without persisting credentials. Feedback itself is never changed.</summary>
internal sealed class HiddenAnnotations
{
    private string? _signature;
    private string _key = "";
    private Dictionary<string, string> _groups = [];

    public string? Encoded { get; private set; }
    public IReadOnlySet<string> Ids { get; private set; } = new HashSet<string>(StringComparer.Ordinal);

    public static bool IsCompleted(string status) => status is Statuses.Resolved or Statuses.Reverted or Statuses.Dismissed;

    public void Select(string?[] parts, string? saved)
    {
        string signature = JsonSerializer.Serialize(parts.Select(p => p ?? "").ToList(), NotatoJsonContext.Default.ListString);
        if (_signature == signature && Encoded == saved)
        {
            return;
        }

        _signature = signature;
        Encoded = saved;
        _key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature))).ToLowerInvariant();
        try
        {
            _groups = JsonSerializer.Deserialize(saved ?? "{}", NotatoJsonContext.Default.DictionaryStringString) ?? [];
            Ids = _groups.TryGetValue(_key, out string? value) && value is not null
                ? (JsonSerializer.Deserialize(value, NotatoJsonContext.Default.ListString) ?? []).ToHashSet(StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);
        }
        catch (JsonException)
        {
            _groups = [];
            Ids = new HashSet<string>(StringComparer.Ordinal);
        }
    }

    public bool Contains(Annotation annotation) => IsCompleted(annotation.Status) && Ids.Contains(annotation.Id);

    public bool Hide(IEnumerable<Annotation> annotations)
    {
        HashSet<string> next = new(Ids, StringComparer.Ordinal);
        foreach (Annotation a in annotations)
        {
            if (IsCompleted(a.Status))
            {
                next.Add(a.Id);
            }
        }

        if (next.Count == Ids.Count)
        {
            return false;
        }

        Ids = next;
        Save();
        return true;
    }

    public void Clear()
    {
        Ids = new HashSet<string>(StringComparer.Ordinal);
        Save();
    }

    private void Save()
    {
        _groups[_key] = JsonSerializer.Serialize(Ids.ToList(), NotatoJsonContext.Default.ListString);
        Encoded = JsonSerializer.Serialize(_groups, NotatoJsonContext.Default.DictionaryStringString);
    }
}
