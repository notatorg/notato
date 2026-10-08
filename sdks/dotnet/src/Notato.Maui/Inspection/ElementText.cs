using Microsoft.Maui.Controls;

namespace Notato.Maui.Inspection;

/// <summary>What an element says: its visible text, its accessible name and role.</summary>
internal static class ElementText
{
    private const int MaxText = 200;

    /// <summary>
    /// The text the element shows, trimmed and at most 200 characters. Passwords and private elements (see
    /// <see cref="Privacy"/>) are never read; with <paramref name="mask"/>, nothing typed into an input is either, unless
    /// it opted out.
    /// </summary>
    public static string? Of(Element element, bool mask)
    {
        if (Privacy.Hidden(element, mask))
        {
            return null;
        }

        string? text = element switch
        {
            Entry entry => Or(entry.Text, entry.Placeholder),
            Editor editor => Or(editor.Text, editor.Placeholder),
            SearchBar search => Or(search.Text, search.Placeholder),
            Label label => label.FormattedText is { } formatted ? string.Concat(formatted.Spans.Select(s => s.Text)) : label.Text,
            Button button => button.Text,
            RadioButton radio => radio.Content as string,
            Picker picker => picker.SelectedItem?.ToString() ?? picker.Title,
            DatePicker date => date.Date?.ToString(date.Format),
            TimePicker time => time.Time?.ToString(),
            Span span => span.Text,
            Page page => page.Title,
            IText withText => withText.Text,
            _ => null,
        };
        return Clip(text);
    }

    /// <summary>
    /// The element's own text, or for a container (a Border, a layout, a card) the text inside it, the way a web page's
    /// text content reads: what lets someone recognise "the banner that says …".
    /// </summary>
    public static string? Visible(Element element, bool mask)
    {
        if (Of(element, mask) is { } own)
        {
            return own;
        }

        if (element is not (Layout or Border or ContentView or ScrollView))
        {
            return null;
        }

        List<string> parts = [];
        int length = 0;
        foreach (Element? e in VisualTree.Descendants(element).Skip(1))
        {
            if (e is Layout or Border or ContentView or ScrollView)
            {
                continue;
            }

            if (e is VisualElement { IsVisible: false })
            {
                continue;
            }

            if (Of(e, mask) is not { } text)
            {
                continue;
            }

            parts.Add(text);
            length += text.Length + 1;
            if (length > MaxText)
            {
                break;
            }
        }
        return Clip(string.Join(' ', parts));
    }

    private static string? Or(string? first, string? second) => string.IsNullOrWhiteSpace(first) ? second : first;

    public static string? Clip(string? text, int max = MaxText)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        string one = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return one.Length > max ? one[..(max - 1)] + "…" : one;
    }

    /// <summary>The accessible role, in the web's vocabulary so the board and Markdown read the same.</summary>
    public static string? RoleOf(Element element) => element switch
    {
        Label label when SemanticProperties.GetHeadingLevel(label) != SemanticHeadingLevel.None => "heading",
        Button or ImageButton => "button",
        SearchBar => "searchbox",
        Entry or Editor => "textbox",
        CheckBox => "checkbox",
        Switch => "switch",
        RadioButton => "radio",
        Slider => "slider",
        Stepper => "spinbutton",
        Picker or DatePicker or TimePicker => "combobox",
        Image => "img",
        ActivityIndicator or ProgressBar => "progressbar",
#pragma warning disable CS0618 // older apps still use ListView
        CollectionView or ListView or CarouselView => "list",
#pragma warning restore CS0618
        WebView => "document",
        Label => "text",
        Page => "page",
        _ => null,
    };

    /// <summary>The accessible name: what a screen reader says for it.</summary>
    public static string? NameOf(Element element)
    {
        if (Privacy.IsPrivate(element))
        {
            return null;
        }

        if (element is BindableObject bindable)
        {
            string description = SemanticProperties.GetDescription(bindable);
            if (!string.IsNullOrWhiteSpace(description))
            {
                return Clip(description, 120);
            }
#pragma warning disable CS0618 // AutomationProperties.Name is what older apps set
            string name = AutomationProperties.GetName(bindable);
#pragma warning restore CS0618
            if (!string.IsNullOrWhiteSpace(name))
            {
                return Clip(name, 120);
            }
        }
        return element switch
        {
            Button or Label or RadioButton or Page => Of(element, mask: false) is { } text ? Clip(text, 120) : null,
            ImageButton or Image => null,
            _ => null,
        };
    }
}
