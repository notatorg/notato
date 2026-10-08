using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;

namespace Notato.Maui.Overlay;

/// <summary>A row of choices of which at most one is on; tapping the one that is on turns it off.</summary>
internal sealed class ChipRow : HorizontalStackLayout
{
    private readonly List<(string Value, Border Box, Label Label)> _chips = [];
    private string? _selected;

    public ChipRow(IEnumerable<(string Value, string Label)> options)
    {
        Ui.Plain(this);
        Spacing = 6;
        foreach ((string value, string label) in options)
        {
            Label text = Ui.Text(label, 13, Ui.CardText, maxLines: 1);
            Border box = Ui.Box(text, Colors.Transparent, 14, new Thickness(11, 6), Ui.CardLine, 1);
            Ui.OnTap(box, () => Selected = Selected == value ? null : value);
            SemanticProperties.SetDescription(box, label);
            _chips.Add((value, box, text));
            Children.Add(box);
        }
    }

    public string? Selected
    {
        get => _selected;
        set
        {
            _selected = value;
            foreach ((string chip, Border box, Label label) in _chips)
            {
                bool on = chip == value;
                box.BackgroundColor = on ? Ui.Accent : Colors.Transparent;
                box.Background = new SolidColorBrush(on ? Ui.Accent : Colors.Transparent);
                box.Stroke = new SolidColorBrush(on ? Ui.Accent : Ui.CardLine);
                label.TextColor = on ? Colors.White : Ui.CardText;
            }
        }
    }
}

/// <summary>
/// The server's mention plugins that can be called now, as chips under a text box: a tap puts <c>@name</c> at the
/// start of the text, or takes it out. Hidden when there are none, which is the server's default: the agent gets
/// everything people write without being mentioned.
/// </summary>
internal sealed class MentionRow : HorizontalStackLayout
{
    private readonly InputView _input;
    private readonly List<(string Name, Border Box, Label Label)> _chips = [];
    /// <summary>The names the chips were last made for, so the same list does not make them again.</summary>
    private string _shown = "";

    public MentionRow(InputView input)
    {
        Ui.Plain(this);
        Spacing = 6;
        IsVisible = false;
        _input = input;
        input.TextChanged += (_, _) => Refresh();
    }

    public void SetMentions(IReadOnlyList<MentionInfo> available)
    {
        string key = string.Join(',', available.Select(m => m.Name));
        if (key == _shown)
        {
            return;
        }

        _shown = key;
        Children.Clear();
        _chips.Clear();
        foreach (MentionInfo mention in available)
        {
            Label text = Ui.Text("@" + mention.Name, 13, Ui.Accent, bold: true, maxLines: 1);
            Border box = Ui.Box(text, Colors.Transparent, 14, new Thickness(11, 6), Ui.Accent, 1);
            string name = mention.Name;
            Ui.OnTap(box, () => _input.Text = Mentions.Toggle(_input.Text, name));
            SemanticProperties.SetDescription(box, $"@{mention.Name}: {mention.Description}");
            box.AutomationId = "NotatoMention-" + mention.Name;
            _chips.Add((name, box, text));
            Children.Add(box);
        }

        IsVisible = _chips.Count > 0;
        Refresh();
    }

    private void Refresh()
    {
        foreach ((string name, Border box, Label label) in _chips)
        {
            bool on = Mentions.Has(_input.Text, name);
            box.Background = new SolidColorBrush(on ? Ui.Accent : Colors.Transparent);
            label.TextColor = on ? Colors.White : Ui.Accent;
        }
    }
}
