using System.Text.RegularExpressions;

namespace Notato.Maui.Inspection;

/// <summary>
/// <c>@name</c> in a note or a reply calls one of the server's mention plugins, such as <c>@jira</c>. None is built in,
/// and none is needed to reach the agent: it gets everything people write. Names match as a word in any case, as the
/// server matches them (packages/core/src/mentions.ts).
/// </summary>
internal static partial class Mentions
{
    [GeneratedRegex(@"(^|[^\w@.])@([a-z][\w-]{0,31})\b", RegexOptions.IgnoreCase)]
    private static partial Regex Mention();

    /// <summary>The names a text mentions, lowercased, each once.</summary>
    public static IReadOnlyList<string> In(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return [];
        }

        List<string> names = [];
        foreach (Match m in Mention().Matches(text))
        {
            string name = m.Groups[2].Value.ToLowerInvariant();
            if (!names.Contains(name))
            {
                names.Add(name);
            }
        }
        return names;
    }

    public static bool Has(string? text, string name) => In(text).Contains(name.ToLowerInvariant());

    /// <summary>What a mention chip does: puts <c>@name</c> at the start of the text, or takes every one of it out.</summary>
    public static string Toggle(string? text, string name)
    {
        text ??= "";
        if (!Has(text, name))
        {
            return $"@{name} {text.TrimStart()}";
        }

        string n = Regex.Escape(name);
        // At the start, "@jira, file this" loses its punctuation with it; elsewhere only the mention goes.
        string without = Regex.Replace(text.Trim(), $@"^@{n}\b[,:]?\s*", "", RegexOptions.IgnoreCase);
        without = Regex.Replace(without, $@"(^|[^\w@.])@{n}\b", "$1", RegexOptions.IgnoreCase);
        without = Regex.Replace(without, @"\s+([,.:;!?])", "$1");
        return Regex.Replace(without, @"\s{2,}", " ").Trim();
    }
}
