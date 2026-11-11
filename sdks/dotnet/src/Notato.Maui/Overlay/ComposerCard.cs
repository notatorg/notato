using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;

namespace Notato.Maui.Overlay;

/// <summary>The note being written about the selected element: what, what is wanted, how bad, and whether the agent gets it.</summary>
internal sealed class ComposerCard : ContentView
{
    private readonly Label _title;
    private readonly Label _subtitle;
    private readonly Editor _editor;
    private readonly ChipRow _intents;
    private readonly ChipRow _severities;
    private readonly MentionRow _mentions;
    private readonly Switch _peopleOnly;
    private readonly Switch _shared;
    private readonly Func<string, string?, string?, bool, bool, Task<string?>> _onSend;
    private readonly Border _send;
    private readonly Label _error;
    private readonly Border _visibility;
    private readonly Label _visibilityLabel;
    private readonly View _lockIcon;
    private readonly View _peopleIcon;
    private readonly View _chevron;
    private readonly VerticalStackLayout _visibilityOptions;
    private bool _busy;

    /// <param name="target">The selection's title, such as <c>Button “Sign in”</c>.</param>
    /// <param name="detail">Where it is: its page, and its XAML file and line.</param>
    /// <param name="screenshotsOff">No screenshot will be taken: the card says so.</param>
    /// <param name="onParent">Parent: widens the selection to the element around it.</param>
    /// <param name="onCancel">Closes the card, and the selection with it.</param>
    /// <param name="onSend">Sends the note (comment, intent, severity, People only); returns what went wrong, or null.</param>
    /// <param name="sharedByDefault">Test mode starts shared; Dev mode starts personal.</param>
    public ComposerCard(string target, string? detail, bool screenshotsOff,
        Action onParent, Action onCancel, Func<string, string?, string?, bool, bool, Task<string?>> onSend, bool sharedByDefault = false)
    {
        Ui.Plain(this);
        _onSend = onSend;
        _title = Ui.Text(target, 15, Ui.CardText, bold: true, maxLines: 1);
        _subtitle = Ui.Text(detail, 12, Ui.CardMuted, maxLines: 2);
        _subtitle.IsVisible = !string.IsNullOrEmpty(detail);

        View parentIcon = Ui.Icon(Ui.IconUp, Ui.CardText, 14);
        Label parentText = Ui.Text("Parent", 13.5, Ui.CardText, maxLines: 1, semibold: true);
        parentText.VerticalOptions = LayoutOptions.Center;
        Border parent = Ui.Box(Ui.Plain(new HorizontalStackLayout { Spacing = 4, VerticalOptions = LayoutOptions.Center, Children = { parentIcon, parentText } }), Ui.Soft, 15, new Thickness(11, 0));
        parent.HeightRequest = 30;
        Ui.OnTap(parent, onParent);
        SemanticProperties.SetDescription(parent, "Select the element around this one");
        Border close = Ui.HeaderButton(back: false, onCancel, "NotatoCancel");
        SemanticProperties.SetDescription(close, "Cancel");

        Grid header = Ui.Plain(new Grid
        {
            ColumnDefinitions = { new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto), new ColumnDefinition(GridLength.Auto) },
            ColumnSpacing = 6,
        });
        VerticalStackLayout titles = Ui.Plain(new VerticalStackLayout { Spacing = 1, VerticalOptions = LayoutOptions.Center, Children = { _title, _subtitle } });
        header.Children.Add(titles);
        header.Children.Add(parent);
        header.Children.Add(close);
        Grid.SetColumn(parent, 1);
        Grid.SetColumn(close, 2);
        parent.VerticalOptions = LayoutOptions.Center;
        close.VerticalOptions = LayoutOptions.Center;

        _editor = Ui.Plain<Editor>(new NotatoEditor
        {
            Placeholder = "What should change?",
            PlaceholderColor = Ui.CardMuted,
            TextColor = Ui.CardText,
            BackgroundColor = Colors.Transparent,
            FontSize = 15,
            FontFamily = null,
            HeightRequest = 84,
            AutoSize = EditorAutoSizeOption.Disabled,
            AutomationId = "NotatoComment",
        });
        _editor.TextChanged += (_, _) => Update();

        _intents = new ChipRow("Feedback type", [(AnnotationIntents.Fix, "Fix"), (AnnotationIntents.Change, "Change"), (AnnotationIntents.Question, "Question"), (AnnotationIntents.Approve, "Approve")]);
        _severities = new ChipRow(
            "Severity",
            [(Severities.Blocker, "Blocker"), (Severities.Major, "Major"), (Severities.Minor, "Minor"), (Severities.Nit, "Nit")],
            // The severity's colours, the web composer's.
            new Dictionary<string, Color>
            {
                [Severities.Blocker] = Ui.Danger,
                [Severities.Major] = Color.FromArgb("#d99a1e"),
                [Severities.Minor] = Color.FromArgb("#2f6fde"),
                [Severities.Nit] = Color.FromArgb("#9a9a9a"),
            });
        _mentions = new MentionRow(_editor);
        // Visibility defaults are set from Dev/Test mode by the server; this switch is the separate People only control.
        (Grid sharedRow, _shared) = Ui.SwitchRow("Share with project", "Project members can see this feedback.", sharedByDefault, "NotatoShared");
        (Grid peopleOnlyRow, _peopleOnly) = Ui.SwitchRow(PeopleOnlyToggle.Label, PeopleOnlyToggle.Hint, false, "NotatoPeopleOnly");
        _shared.Toggled += (_, _) => UpdateVisibility();
        _peopleOnly.Toggled += (_, _) => UpdateVisibility();

        // Who will see the note, in a few words; a tap shows the two switches that decide it. Closed on every new note.
        _lockIcon = Ui.Icon(Ui.IconLock, Ui.CardMuted, 14);
        _peopleIcon = Ui.Icon(Ui.IconPeople, Ui.CardMuted, 14);
        _visibilityLabel = Ui.Text(null, 13.5, Ui.CardText, maxLines: 1, semibold: true);
        _visibilityLabel.VerticalOptions = LayoutOptions.Center;
        _chevron = Ui.Icon(Ui.IconChevronDown, Ui.CardMuted, 12);
        _visibility = Ui.Box(
            Ui.Plain(new HorizontalStackLayout { Spacing = 6, VerticalOptions = LayoutOptions.Center, Children = { _lockIcon, _peopleIcon, _visibilityLabel, _chevron } }),
            Colors.Transparent, 17, new Thickness(12, 0), Ui.CardLine, 1);
        _visibility.HeightRequest = 34;
        _visibility.HorizontalOptions = LayoutOptions.Start;
        _visibility.AutomationId = "NotatoVisibility";
        Ui.OnTap(_visibility, () => VisibilityOpen = !VisibilityOpen);
        _visibilityOptions = Ui.Plain(new VerticalStackLayout { Spacing = 10, IsVisible = false, Children = { sharedRow, peopleOnlyRow } });

        _error = Ui.Text(null, 12, Ui.Danger);
        _error.IsVisible = false;
        Label note = Ui.Text(screenshotsOff ? "No screenshot: they are turned off." : "Tap another element to change what this note is about.", 12, Ui.CardMuted);
        _send = Ui.PrimaryButton("Send", () => _ = SendAsync());
        _send.AutomationId = "NotatoSend";
        Grid footer = Ui.Plain(new Grid { ColumnDefinitions = { new ColumnDefinition(GridLength.Star), new ColumnDefinition(GridLength.Auto) }, ColumnSpacing = 10 });
        footer.Children.Add(note);
        footer.Children.Add(_send);
        Grid.SetColumn(_send, 1);
        note.VerticalOptions = LayoutOptions.Center;

        Content = Ui.Card(Ui.Plain(new VerticalStackLayout
        {
            Spacing = 12,
            Children =
            {
                header,
                _intents,
                Fields.EditorBox(_editor),
                Scroll(_mentions),
                _severities,
                Ui.Plain(new VerticalStackLayout { Spacing = 10, Children = { _visibility, _visibilityOptions } }),
                _error,
                footer,
            },
        }));
        Update();
        UpdateVisibility();
    }

    /// <summary>Who will see a note, as the visibility button says it, from its two switches.</summary>
    internal static string VisibilityLabel(bool shared, bool hiddenFromAgent) => (shared, hiddenFromAgent) switch
    {
        (false, false) => "You and your agent",
        (true, false) => "Shared with project",
        (false, true) => "Only you",
        (true, true) => "Project, not agent",
    };

    /// <summary>Whether the visibility switches show under the button.</summary>
    internal bool VisibilityOpen
    {
        get => _visibilityOptions.IsVisible;
        set
        {
            _visibilityOptions.IsVisible = value;
            UpdateVisibility();
        }
    }

    private void UpdateVisibility()
    {
        string label = VisibilityLabel(_shared.IsToggled, _peopleOnly.IsToggled);
        bool open = VisibilityOpen;
        _visibilityLabel.Text = label;
        _lockIcon.IsVisible = !_shared.IsToggled;
        _peopleIcon.IsVisible = _shared.IsToggled;
        _chevron.Rotation = open ? 180 : 0;
        Color fill = open ? Ui.Soft : Colors.Transparent;
        _visibility.BackgroundColor = fill;
        _visibility.Background = new SolidColorBrush(fill);
        SemanticProperties.SetDescription(_visibility, "Visibility: " + label);
        // MAUI has no expanded state for screen readers, so the hint says it.
        SemanticProperties.SetHint(_visibility, open ? "Expanded" : "Collapsed");
    }

    private static ScrollView Scroll(View row) => new() { Orientation = ScrollOrientation.Horizontal, HorizontalScrollBarVisibility = ScrollBarVisibility.Never, Content = row };

    /// <summary>What <c>@</c> can call right now: the server's mention plugins, if it has any.</summary>
    public void SetMentions(IReadOnlyList<MentionInfo> available) => _mentions.SetMentions(available);

    /// <summary>Puts the cursor in the comment and opens the keyboard for it, as the other platforms do.</summary>
    public void FocusComment() => _editor.Focus();

    public void SetTarget(string target, string? detail)
    {
        _title.Text = target;
        _subtitle.Text = detail;
        _subtitle.IsVisible = !string.IsNullOrEmpty(detail);
    }

    private void Update()
    {
        bool ready = !_busy && !string.IsNullOrWhiteSpace(_editor.Text);
        _send.Opacity = ready ? 1 : 0.45;
    }

    /// <summary>What Send does: sends the note as written, unless it is empty or already going.</summary>
    internal async Task SendAsync()
    {
        if (_busy || string.IsNullOrWhiteSpace(_editor.Text))
        {
            return;
        }

        _busy = true;
        Update();
        ((Label)_send.Content!).Text = "Sending…";
        try
        {
            string? problem = await _onSend(_editor.Text.Trim(), _intents.Selected, _severities.Selected, _peopleOnly.IsToggled, _shared.IsToggled);
            if (problem is not null)
            {
                _error.Text = problem;
                _error.IsVisible = true;
            }
        }
        finally
        {
            _busy = false;
            ((Label)_send.Content!).Text = "Send";
            Update();
        }
    }
}
