using Microsoft.Maui.Controls;
using System.Collections.Concurrent;
using System.Text;

namespace Notato.Maui.Inspection;

/// <summary>
/// Selectors for MAUI's visual tree, written like CSS so they read at a glance:
/// <c>LoginPage VerticalStackLayout#Form &gt; Button:nth-of-type(2)</c>.
/// <list type="bullet">
/// <item><c>Button</c>: the control's type name (<c>*</c> for any).</item>
/// <item><c>#SignIn</c>: its AutomationId (or <c>[AutomationId="Sign in"]</c>).</item>
/// <item><c>[x:Name=Email]</c>: its x:Name (MAUI's StyleId).</item>
/// <item><c>.primary</c>: a StyleClass.</item>
/// <item><c>:nth-of-type(2)</c>: the second child of its parent with that type.</item>
/// <item><c>:text("Sign in")</c> (or <c>:has-text</c>): its text contains this, ignoring case. For agents; never generated. What
/// is typed into an input that is masked is not its text.</item>
/// <item>A space means "somewhere inside", <c>&gt;</c> means "directly inside".</item>
/// </list>
/// </summary>
internal static class Selectors
{
    internal sealed record Compound(string? Type, string? Id, string? Name, IReadOnlyList<string> Classes, int? NthOfType, string? Text);

    internal sealed record Step(Compound Compound, bool Child);

    // ---- writing ----------------------------------------------------------------------------------------------

    /// <summary>
    /// Whether the character at <paramref name="i"/> is part of a name read without quotes (after <c>#</c> or
    /// <c>.</c>): a letter, a digit, <c>_</c> or <c>-</c>, or a <c>.</c> with a letter or digit after it, so
    /// <c>#Form.Email</c> is one id. The writer and the reader both go by this, so a name written bare reads back whole.
    /// </summary>
    private static bool InName(string s, int i) =>
        char.IsLetterOrDigit(s[i]) || s[i] is '_' or '-' || (s[i] == '.' && i + 1 < s.Length && char.IsLetterOrDigit(s[i + 1]));

    /// <summary>A name that can be written without quotes: it starts with a letter or <c>_</c>, and is read back whole.</summary>
    internal static bool IsBare(string name)
    {
        if (name.Length == 0 || !(char.IsLetter(name[0]) || name[0] == '_'))
        {
            return false;
        }

        for (int i = 0; i < name.Length; i++)
        {
            if (!InName(name, i))
            {
                return false;
            }
        }
        return true;
    }

    private static string Quote(string value) => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    /// <summary>The element's own part: its type, and its AutomationId or x:Name when it has one.</summary>
    public static string Segment(Element element, bool withPosition)
    {
        StringBuilder sb = new(VisualTree.TypeName(element.GetType()));
        string id = element.AutomationId;
        if (!string.IsNullOrEmpty(id))
        {
            sb.Append(IsBare(id) ? "#" + id : $"[AutomationId={Quote(id)}]");
            return sb.ToString();
        }
        string? name = NameOf(element);
        if (name is not null)
        {
            sb.Append($"[x:Name={(IsBare(name) ? name : Quote(name))}]");
            return sb.ToString();
        }
        if (withPosition && Parent(element) is { } parent)
        {
            (int position, int count) = PositionOfType(parent, element);
            if (count > 1)
            {
                sb.Append($":nth-of-type({position})");
            }
        }
        return sb.ToString();
    }

    /// <summary>
    /// Where the element is among its parent's children of its own type (1-based, 0 when it is not one of them), and how
    /// many of them there are. Counted without copying the children: it runs for every node a selector is tried on.
    /// </summary>
    private static (int Position, int Count) PositionOfType(Element parent, Element element)
    {
        if (parent is not IVisualTreeElement tree)
        {
            return (0, 0);
        }

        Type type = element.GetType();
        int position = 0, count = 0;
        IReadOnlyList<IVisualTreeElement> children = tree.GetVisualChildren();
        for (int i = 0; i < children.Count; i++)
        {
            if (children[i] is Element child && child.GetType() == type)
            {
                count++;
                if (ReferenceEquals(child, element))
                {
                    position = count;
                }
            }
        }
        return (position, count);
    }

    /// <summary>x:Name, which MAUI's XAML loader keeps in StyleId.</summary>
    public static string? NameOf(Element element) =>
        string.IsNullOrWhiteSpace(element.StyleId) ? null : element.StyleId;

    private static Element? Parent(Element element) => VisualTree.Parent(element);

    /// <summary>
    /// The shortest selector, starting with the page's type, that matches only this element on its page. Falls back
    /// to the full path from the page.
    /// </summary>
    public static string For(Element element)
    {
        Page? page = VisualTree.PageOf(element);
        if (page is null || ReferenceEquals(page, element))
        {
            return Segment(element, withPosition: false);
        }

        List<Element> chain = [];
        for (Element? e = element; e is not null && !ReferenceEquals(e, page); e = Parent(e))
        {
            chain.Add(e);
        }

        chain.Reverse(); // outermost first, the element last

        string pageName = VisualTree.TypeName(page.GetType());
        List<string> segments = [.. chain.Select(e => Segment(e, withPosition: true))];
        // Shortest first: the element alone, then with its parent, and so on outwards.
        for (int start = segments.Count - 1; start >= 0; start--)
        {
            string candidate = pageName + " " + string.Join(" > ", segments.Skip(start));
            // Generated selectors never use :text, so masking makes no difference to them.
            List<Element> found = [.. Query(page, candidate, mask: true).Take(2)];
            if (found.Count == 1 && ReferenceEquals(found[0], element))
            {
                return candidate;
            }
        }
        return pageName + " > " + string.Join(" > ", segments);
    }

    // ---- reading ----------------------------------------------------------------------------------------------

    /// <summary>Every element under <paramref name="root"/> (the root included) that the selector matches, in tree order.</summary>
    /// <param name="root">Where to look.</param>
    /// <param name="selector">What to look for.</param>
    /// <param name="mask">
    /// Whether what is typed into inputs is masked in this session: then <c>:text()</c> does not match it, so it cannot be
    /// found out that way. On by default.
    /// </param>
    public static IEnumerable<Element> Query(Element root, string selector, bool mask = true)
    {
        IReadOnlyList<Step> steps = ParseCached(selector);
        if (steps.Count == 0)
        {
            return [];
        }

        return VisualTree.Descendants(root).Where(e => Matches(e, steps, steps.Count - 1, root, mask));
    }

    /// <summary>
    /// Looks for several selectors in one walk of the tree under <paramref name="root"/>: for each, the first element in
    /// tree order that it matches and <paramref name="accept"/> takes (given the selector's index). An element is only
    /// tried against the selectors whose last part could be it (by type), and the walk stops once all are found.
    /// </summary>
    public static Element?[] QueryFirst(Element root, IReadOnlyList<IReadOnlyList<Step>> selectors, bool mask, Func<int, Element, bool> accept)
    {
        Element?[] found = new Element?[selectors.Count];
        // Which selectors end in each type, by the name they give it; those that end in any type are tried on everything.
        Dictionary<string, List<int>> byType = new(StringComparer.Ordinal);
        List<int> anyType = [];
        int left = 0;
        for (int i = 0; i < selectors.Count; i++)
        {
            if (selectors[i].Count == 0)
            {
                continue;
            }

            left++;
            string? type = selectors[i][^1].Compound.Type;
            if (type is null or "*")
            {
                anyType.Add(i);
            }
            else
            {
                if (!byType.TryGetValue(type, out List<int>? list))
                {
                    byType[type] = list = [];
                }

                list.Add(i);
            }
        }
        if (left == 0)
        {
            return found;
        }

        foreach (Element element in VisualTree.Descendants(root))
        {
            Type type = element.GetType();
            if (Try(byType.GetValueOrDefault(VisualTree.TypeName(type))) || Try(type.FullName is { } full ? byType.GetValueOrDefault(full) : null) || Try(anyType))
            {
                return found;
            }

            // True once every selector has its element.
            bool Try(List<int>? candidates)
            {
                if (candidates is null)
                {
                    return false;
                }

                foreach (int i in candidates)
                {
                    if (found[i] is null && Matches(element, selectors[i], selectors[i].Count - 1, root, mask) && accept(i, element))
                    {
                        found[i] = element;
                        if (--left == 0)
                        {
                            return true;
                        }
                    }
                }
                return false;
            }
        }
        return found;
    }

    private static bool Matches(Element element, IReadOnlyList<Step> steps, int index, Element root, bool mask)
    {
        if (!Matches(element, steps[index].Compound, mask))
        {
            return false;
        }

        if (index == 0)
        {
            return true;
        }

        if (ReferenceEquals(element, root))
        {
            return false;
        }

        bool child = steps[index].Child;
        for (Element? parent = Parent(element); parent is not null; parent = Parent(parent))
        {
            if (Matches(parent, steps, index - 1, root, mask))
            {
                return true;
            }

            if (child || ReferenceEquals(parent, root))
            {
                return false;
            }
        }
        return false;
    }

    private static bool Matches(Element element, Compound c, bool mask)
    {
        if (c.Type is not null and not "*")
        {
            Type type = element.GetType();
            if (VisualTree.TypeName(type) != c.Type && type.FullName != c.Type)
            {
                return false;
            }
        }
        if (c.Id is not null && element.AutomationId != c.Id)
        {
            return false;
        }

        if (c.Name is not null && NameOf(element) != c.Name)
        {
            return false;
        }

        if (c.Classes.Count > 0)
        {
            IList<string>? classes = (element as VisualElement)?.StyleClass;
            if (classes is null || c.Classes.Any(cls => !classes.Contains(cls)))
            {
                return false;
            }
        }
        if (c.NthOfType is { } nth)
        {
            if (Parent(element) is not { } parent || PositionOfType(parent, element).Position != nth)
            {
                return false;
            }
        }
        if (c.Text is not null)
        {
            string? text = ElementText.Of(element, mask);
            if (text is null || !text.Contains(c.Text, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Selectors already parsed (or found wrong, with why): pins are looked for by the same ones over and over.</summary>
    private static readonly ConcurrentDictionary<string, object> parsed = new(StringComparer.Ordinal);

    /// <summary>How many parsed selectors are kept before the cache starts again.</summary>
    private const int ParsedLimit = 2048;

    /// <summary><see cref="Parse"/>, remembered. Throws <see cref="FormatException"/> as it does, each time.</summary>
    public static IReadOnlyList<Step> ParseCached(string selector)
    {
        object known = Remembered(selector);
        return known as IReadOnlyList<Step> ?? throw new FormatException((string)known);
    }

    /// <summary><see cref="ParseCached"/>, or null for a selector that is not one of these (a web page's, or a newer SDK's).</summary>
    public static IReadOnlyList<Step>? TryParseCached(string selector) => Remembered(selector) as IReadOnlyList<Step>;

    /// <summary>The parsed steps, or why the selector is wrong.</summary>
    private static object Remembered(string selector)
    {
        if (parsed.TryGetValue(selector, out object? known))
        {
            return known;
        }

        try
        {
            known = Parse(selector);
        }
        catch (FormatException error)
        {
            known = error.Message;
        }
        if (parsed.Count >= ParsedLimit)
        {
            parsed.Clear();
        }

        parsed[selector] = known;
        return known;
    }

    /// <summary>Parses a selector. Throws <see cref="FormatException"/> with a message fit for an agent.</summary>
    public static IReadOnlyList<Step> Parse(string selector)
    {
        List<Step> steps = [];
        string s = selector.Trim();
        int i = 0;
        bool child = false;
        while (i < s.Length)
        {
            if (char.IsWhiteSpace(s[i])) { i++; continue; }
            if (s[i] == '>')
            {
                if (steps.Count == 0)
                {
                    throw new FormatException($"selector \"{selector}\" cannot start with >");
                }

                child = true;
                i++;
                continue;
            }
            Compound compound = ParseCompound(s, ref i, selector);
            steps.Add(new Step(compound, child));
            child = false;
        }
        if (child)
        {
            throw new FormatException($"selector \"{selector}\" ends with >");
        }

        return steps;
    }

    private static Compound ParseCompound(string s, ref int i, string selector)
    {
        string? type = null, id = null, name = null, text = null;
        int? nth = null;
        List<string> classes = [];
        int start = i;
        if (i < s.Length && (s[i] == '*' || char.IsLetter(s[i]) || s[i] == '_'))
        {
            int t = i;
            if (s[i] == '*')
            {
                i++;
            }
            else
            {
                while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] == '_'))
                {
                    i++;
                }
            }

            type = s[t..i];
        }
        while (i < s.Length && !char.IsWhiteSpace(s[i]) && s[i] != '>')
        {
            switch (s[i])
            {
                case '#':
                    i++;
                    id = ReadIdent(s, ref i, selector);
                    break;
                case '.':
                    i++;
                    classes.Add(ReadIdent(s, ref i, selector));
                    break;
                case '[':
                {
                    i++;
                        string attr = ReadUntil(s, ref i, '=', selector).Trim();
                    i++; // '='
                        string value = ReadValue(s, ref i, ']', selector);
                    if (i >= s.Length || s[i] != ']')
                        {
                            throw new FormatException($"selector \"{selector}\": missing ]");
                        }

                        i++;
                    switch (attr)
                    {
                        case "x:Name" or "StyleId" or "Name": name = value; break;
                        case "AutomationId": id = value; break;
                        default: throw new FormatException($"selector \"{selector}\": [{attr}=…] is not supported; use AutomationId or x:Name");
                    }
                    break;
                }
                case ':':
                {
                    i++;
                        string pseudo = ReadIdent(s, ref i, selector);
                    if (i >= s.Length || s[i] != '(')
                        {
                            throw new FormatException($"selector \"{selector}\": :{pseudo} needs (…)");
                        }

                        i++;
                        string arg = ReadValue(s, ref i, ')', selector);
                    if (i >= s.Length || s[i] != ')')
                        {
                            throw new FormatException($"selector \"{selector}\": missing )");
                        }

                        i++;
                    switch (pseudo)
                    {
                        case "nth-of-type" when int.TryParse(arg, out int n) && n > 0: nth = n; break;
                        case "text" or "has-text": text = arg; break;
                        default: throw new FormatException($"selector \"{selector}\": :{pseudo}({arg}) is not supported");
                    }
                    break;
                }
                default:
                    throw new FormatException($"selector \"{selector}\": unexpected '{s[i]}' at {i + 1}");
            }
        }
        if (i == start)
        {
            throw new FormatException($"selector \"{selector}\": expected a type, #id or [x:Name=…] at {i + 1}");
        }

        return new Compound(type, id, name, classes, nth, text);
    }

    private static string ReadIdent(string s, ref int i, string selector)
    {
        int start = i;
        while (i < s.Length && InName(s, i))
        {
            i++;
        }

        if (i == start)
        {
            throw new FormatException($"selector \"{selector}\": expected a name at {i + 1}");
        }

        return s[start..i];
    }

    private static string ReadUntil(string s, ref int i, char stop, string selector)
    {
        int start = i;
        while (i < s.Length && s[i] != stop)
        {
            i++;
        }

        if (i >= s.Length)
        {
            throw new FormatException($"selector \"{selector}\": expected '{stop}'");
        }

        return s[start..i];
    }

    private static string ReadValue(string s, ref int i, char close, string selector)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i]))
        {
            i++;
        }

        if (i < s.Length && s[i] is '"' or '\'')
        {
            char quote = s[i++];
            StringBuilder sb = new();
            while (i < s.Length && s[i] != quote)
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    i++;
                }

                sb.Append(s[i++]);
            }
            if (i >= s.Length)
            {
                throw new FormatException($"selector \"{selector}\": unclosed quote");
            }

            i++;
            while (i < s.Length && char.IsWhiteSpace(s[i]))
            {
                i++;
            }

            return sb.ToString();
        }
        return ReadUntil(s, ref i, close, selector).Trim();
    }
}
