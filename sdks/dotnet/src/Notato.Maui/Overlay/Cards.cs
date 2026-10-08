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
    private readonly Ui.ChipRow _intents;
    private readonly Ui.ChipRow _severities;
    private readonly Ui.MentionRow _mentions;
    private readonly Switch _peopleOnly;
    private readonly Func<string, string?, string?, bool, Task<string?>> _onSend;
    private readonly Border _send;
    private readonly Label _error;
    private bool _busy;

    // onSend sends the note (comment, intent, severity, People only) and returns what went wrong, or null.
    public ComposerCard(string target, string? detail, bool screenshotsOff,
        Action onParent, Action onCancel, Func<string, string?, string?, bool, Task<string?>> onSend)
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

        _intents = new Ui.ChipRow([(AnnotationIntents.Fix, "Fix"), (AnnotationIntents.Change, "Change"), (AnnotationIntents.Question, "Question"), (AnnotationIntents.Approve, "Approve")]);
        _severities = new Ui.ChipRow([(Severities.Blocker, "Blocker"), (Severities.Major, "Major"), (Severities.Minor, "Minor"), (Severities.Nit, "Nit")]);
        _mentions = new Ui.MentionRow(_editor);
        // Everything people write reaches the agent, unless they keep it between themselves.
        (Grid peopleOnlyRow, _peopleOnly) = Ui.SwitchRow(PeopleOnlyToggle.Label, PeopleOnlyToggle.Hint, false, "NotatoPeopleOnly");

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
                OverlayFields.Box(_editor),
                Scroll(_mentions),
                Scroll(_intents),
                Scroll(_severities),
                peopleOnlyRow,
                _error,
                footer,
            },
        }));
        Update();
    }

    private static ScrollView Scroll(View row) => new() { Orientation = ScrollOrientation.Horizontal, HorizontalScrollBarVisibility = ScrollBarVisibility.Never, Content = row };

    /// <summary>What <c>@</c> can call right now: the server's mention plugins, if it has any.</summary>
    public void SetMentions(IReadOnlyList<MentionInfo> available) => _mentions.SetMentions(available);

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
            string? problem = await _onSend(_editor.Text.Trim(), _intents.Selected, _severities.Selected, _peopleOnly.IsToggled);
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

/// <summary>Notato's own text fields, told apart from the app's so only they lose Android's underline.</summary>
internal sealed class NotatoEditor : Editor;

internal sealed class NotatoEntry : Entry;

internal static class OverlayFields
{
    public static Border Box(View field) => Ui.Box(field, Ui.Soft, 12, new Thickness(8, 2));
}

/// <summary>One annotation: what was said, where it stands, the thread, and what the person can do now.</summary>
internal sealed class PinCard : ContentView
{
    /// <summary>A note's card with no server to send it to (test mode): where the note is, and how it leaves.</summary>
    public const string KeptHere = "Kept on this device. Package it from the menu to share it.";

    /// <summary>How many of the thread's latest entries the card shows; the board has them all.</summary>
    public const int ThreadShown = 4;

    /// <summary>The line under a long thread, in the words the other SDKs use: "2 earlier on the board."</summary>
    public static string? EarlierLine(int threadLength) =>
        threadLength > ThreadShown ? $"{threadLength - ThreadShown} earlier on the board." : null;

    // back: to the list of notes it was opened from; none when its pin was tapped.
    public PinCard(NotatoController controller, OverlaySession session, NotatoController.Record record, int number, Action close, Action? back = null)
    {
        Ui.Plain(this);
        Annotation a = record.Annotation;

        // ---- header: Back (or the pin), "Note 2" and who wrote it when, Close -------------------------------------------
        string byline = string.Join(" · ", new[] { a.Author.Name ?? (a.Author.Kind == "agent" ? "An agent" : null), Ui.Ago(a.CreatedAt) }
            .Where(s => !string.IsNullOrEmpty(s)));
        View leading = back is null ? Ui.PinTile(number, a.Status, record.Pending, 38) : Ui.HeaderButton(back: true, back);
        Grid header = Ui.SheetHeader(leading, number > 0 ? $"Note {number.ToString(System.Globalization.CultureInfo.InvariantCulture)}" : "Note",
            byline.Length > 0 ? Ui.SheetSubtitle(byline) : null, Ui.HeaderButton(back: false, close));

        // ---- what scrolls: badges, the note, what it is about, People only, the thread, the reply ------------------------
        VerticalStackLayout rows = Ui.Plain(new VerticalStackLayout { Spacing = 12, Padding = new Thickness(4, 0) });
        HorizontalStackLayout badges = Ui.Plain(new HorizontalStackLayout { Spacing = 5, Children = { Ui.Badge(Ui.Humanize(a.Status), a.Status) } });
        if (PeopleOnlyToggle.IsOn(a))
        {
            Border kept = Ui.Badge(PeopleOnlyToggle.Label, Ui.PeopleOnlyBadge);
            kept.AutomationId = "NotatoPeopleOnlyBadge";
            badges.Children.Add(kept);
        }

        if (a.Intent is { } intent)
        {
            badges.Children.Add(Ui.Badge(intent, "intent"));
        }

        if (a.Severity is { } severity)
        {
            badges.Children.Add(Ui.Badge(severity, severity));
        }

        foreach (View child in badges.Children.OfType<View>())
        {
            child.VerticalOptions = LayoutOptions.Center;
        }

        rows.Children.Add(badges);
        rows.Children.Add(Ui.Text(a.Comment, 16, Ui.CardText));
        ElementIdentity? target = a.Target.Identity.FirstOrDefault();
        if (target is not null)
        {
            string what = target.Tag + (target.TestId is { } id ? "#" + id : "") + (target.Text is { } text ? $" “{(text.Length > 30 ? text[..29] + "…" : text)}”" : "");
            rows.Children.Add(Ui.Text(what, 12.5, Ui.CardMuted, maxLines: 2));
        }

        if (record.Pending && !controller.HasServer)
        {
            // Test mode, or no server: nothing is waiting to be sent, the note goes out in a package.
            rows.Children.Add(Ui.Text(KeptHere, 12.5, Ui.CardMuted));
        }
        else if (record.Pending)
        {
            string state = record switch
            {
                { Error: { } refused } => $"Not sent: the server refused it. {refused}",
                { Held: { } held } => $"Not sent yet. The server said: {held}",
                _ => "Not sent yet: it goes when the server can be reached.",
            };
            rows.Children.Add(Ui.Text(state, 12.5, Color.FromArgb("#b45309")));
        }

        Label status = Ui.Text(null, 12.5, Ui.Danger);
        status.IsVisible = false;
        status.Margin = new Thickness(4, 0);

        // People only, for the note as it is now: anyone on the thread can turn it on or off, and the thread records it.
        (Grid peopleOnlyRow, Switch peopleOnly) = Ui.SwitchRow(PeopleOnlyToggle.Label, PeopleOnlyToggle.Hint, PeopleOnlyToggle.IsOn(a), "NotatoPeopleOnly");
        bool puttingBack = false;
        peopleOnly.Toggled += async (_, e) =>
        {
            if (puttingBack)
            {
                return;
            }

            peopleOnly.IsEnabled = false;
            try
            {
                await controller.SetPeopleOnlyAsync(a.Id, e.Value);
                controller.Toast(session, e.Value ? "Made this people only" : "Shared this with the agent");
                // The card again, with its badge and the thread's new entry.
                controller.OpenPin(session, a.Id, back);
            }
            catch (Exception error)
            {
                puttingBack = true;
                peopleOnly.IsToggled = !e.Value;
                puttingBack = false;
                status.Text = error.Message;
                status.IsVisible = true;
            }
            finally
            {
                peopleOnly.IsEnabled = true;
            }
        };
        rows.Children.Add(peopleOnlyRow);

        foreach (Reply? reply in a.Thread.TakeLast(ThreadShown))
        {
            rows.Children.Add(ReplyView(reply));
        }
        if (EarlierLine(a.Thread.Count) is { } earlier)
        {
            Label line = Ui.Text(earlier, 12.5, Ui.CardMuted);
            line.AutomationId = "NotatoEarlierReplies";
            rows.Children.Add(line);
        }

        async Task Run(Func<Task> action, string? done)
        {
            try
            {
                await action();
                if (done is not null)
                {
                    controller.Toast(session, done);
                }

                close();
            }
            catch (Exception error)
            {
                status.Text = error.Message;
                status.IsVisible = true;
            }
        }

        // ---- the buttons: what can be done with it now -------------------------------------------------------------
        List<Border> actions = [];
        if (controller.HasServer && !record.Pending)
        {
            Entry reply = NotatoOverlay.Field(null, a.Status == Statuses.Resolved ? "Reply, or say what was wrong" : "Reply");
            reply.AutomationId = "NotatoReply";
            rows.Children.Add(NotatoOverlay.FieldBox(reply));
            // The server's mention plugins, if it has any. The agent needs none: it gets every reply that is not an aside.
            Ui.MentionRow replyMentions = new(reply);
            replyMentions.SetMentions(controller.AvailableMentions);
            rows.Children.Add(replyMentions);
            (Grid asideRow, Switch aside) = Ui.SwitchRow(PeopleOnlyToggle.AsideLabel, PeopleOnlyToggle.AsideHint, false, "NotatoAside");
            rows.Children.Add(asideRow);

            if (a.Status == Statuses.Resolved)
            {
                actions.Add(Ui.SheetButton("Ask the agent to revert", () => _ = Run(() => controller.RequestRevertAsync(a.Id, reply.Text), "Asked the agent to undo that change")));
            }

            if (a.Status == Statuses.RevertRequested)
            {
                actions.Add(Ui.SheetButton("Cancel request", () => _ = Run(() => controller.CancelRevertAsync(a.Id), "Revert request taken back")));
            }

            if (a.Status is Statuses.Open or Statuses.Acknowledged && record.Mine)
            {
                actions.Add(Ui.SheetButton("Delete", () => _ = Run(() => controller.DeleteAsync(a.Id), "Note deleted"), Ui.SheetButtonKind.Danger));
            }

            Border send = Ui.SheetButton("Reply", () => _ = Run(async () =>
            {
                if (string.IsNullOrWhiteSpace(reply.Text))
                {
                    throw new InvalidOperationException("Write a reply first.");
                }

                await controller.ReplyAsync(a.Id, reply.Text, aside.IsToggled);
                // An aside is one reply: the next is an ordinary one again.
                aside.IsToggled = false;
            }, "Reply sent"), Ui.SheetButtonKind.Primary);
            send.AutomationId = "NotatoSendReply";
            actions.Add(send);
        }
        else
        {
            actions.Add(Ui.SheetButton("Delete", () => _ = Run(() => controller.DeleteAsync(a.Id), "Note deleted"), Ui.SheetButtonKind.Danger));
        }

        Content = Ui.Sheet(Ui.Plain(new VerticalStackLayout { Spacing = 14, Children = { header, new SheetBody(rows), Ui.ButtonRow([.. actions]), status } }), close);
    }

    /// <summary>
    /// One entry of a thread: who said what. An aside, which only the people on the thread see, is labelled and
    /// outlined rather than filled. An automatic entry (People only turned on or off) reads like any other.
    /// </summary>
    internal static Border ReplyView(Reply reply)
    {
        bool aside = reply.Aside == true;
        string who = reply.Author.Name ?? (reply.Author.Kind == "agent" ? "Agent" : "You");
        FormattedString text = new();
        if (aside)
        {
            text.Spans.Add(new Span { Text = PeopleOnlyToggle.AsideLabel + " · ", FontSize = 11, FontAttributes = FontAttributes.Bold, TextColor = Ui.CardMuted });
        }

        text.Spans.Add(new Span { Text = who + ": ", FontAttributes = FontAttributes.Bold, TextColor = Ui.CardText });
        text.Spans.Add(new Span { Text = reply.Body, TextColor = Ui.CardText });
        Label line = new()
        {
            Style = new Style(typeof(Label)),
            FontSize = 13,
            TextColor = Ui.CardText,
            LineBreakMode = LineBreakMode.WordWrap,
            MaxLines = 6,
            FormattedText = text,
        };
        return aside
            ? Ui.Box(line, Colors.Transparent, 8, new Thickness(10, 7), Ui.CardLine, 1)
            : Ui.Box(line, Ui.Soft, 8, new Thickness(10, 7));
    }
}
