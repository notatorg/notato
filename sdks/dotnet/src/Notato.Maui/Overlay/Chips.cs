using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;

namespace Notato.Maui.Overlay;

/// <summary>
/// A row of equal choices of which at most one is on; tapping the one that is on turns it off. The one that is on is
/// filled with the text colour, as on the web, and <c>dots</c> puts a colour beside a choice's label (the severity's).
/// </summary>
internal sealed class ChipRow : Grid
{
    private readonly List<(string Value, Border Box, Label Label)> _chips = [];
    private string? _selected;

    public ChipRow(IEnumerable<(string Value, string Label)> options, IReadOnlyDictionary<string, Color>? dots = null)
    {
        Ui.Plain(this);
        ColumnSpacing = 6;
        int column = 0;
        foreach ((string value, string label) in options)
        {
            ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
            Label text = Ui.Text(label, 14, Ui.CardText, maxLines: 1, semibold: true);
            View content = text;
            if (dots is not null && dots.TryGetValue(value, out Color? dotColor))
            {
                BoxView dot = new() { Color = dotColor, WidthRequest = 7, HeightRequest = 7, CornerRadius = 3.5, VerticalOptions = LayoutOptions.Center };
                content = new HorizontalStackLayout { Spacing = 5, HorizontalOptions = LayoutOptions.Center, Children = { dot, text } };
            }
            else text.HorizontalOptions = LayoutOptions.Center;
            Border box = Ui.Box(content, Colors.Transparent, 10, new Thickness(4, 0), Ui.CardLine, 1);
            box.HeightRequest = 38;
            box.VerticalOptions = LayoutOptions.Fill;
            Ui.OnTap(box, () => Selected = Selected == value ? null : value);
            SemanticProperties.SetDescription(box, label);
            _chips.Add((value, box, text));
            Children.Add(box);
            SetColumn((BindableObject)box, column++);
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
                box.BackgroundColor = on ? Ui.CardText : Colors.Transparent;
                box.Background = new SolidColorBrush(on ? Ui.CardText : Colors.Transparent);
                box.Stroke = new SolidColorBrush(on ? Ui.CardText : Ui.CardLine);
                label.TextColor = on ? Ui.CardBackground : Ui.CardText;
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
