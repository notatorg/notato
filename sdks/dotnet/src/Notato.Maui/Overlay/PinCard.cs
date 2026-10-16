using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Inspection;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Overlay;

/// <summary>One annotation: what was said, where it stands, the thread, and what the person can do now.</summary>
internal sealed class PinCard : ContentView
{
    /// <summary>A note's card with no server to send it to (test mode): where the note is, and how it leaves.</summary>
    public const string KeptHere = "Kept on this device. Package it from the menu to share it.";

    /// <summary>A note sent with a capture-only token, which this app can neither read back nor change.</summary>
    public const string SentOnly = "Sent. Its replies and status are on the Notato board.";

    /// <summary>How many of the thread's latest entries the card shows; the board has them all.</summary>
    public const int ThreadShown = 4;

    /// <summary>The line under a long thread, in the words the other SDKs use: "2 earlier on the board."</summary>
    public static string? EarlierLine(int threadLength) =>
        threadLength > ThreadShown ? $"{threadLength - ThreadShown} earlier on the board." : null;

    /// <param name="controller">What the card's buttons ask for.</param>
    /// <param name="session">The window it shows in.</param>
    /// <param name="record">The note.</param>
    /// <param name="number">Its pin's number on this screen; 0 for a note from another screen.</param>
    /// <param name="close">Closes the card.</param>
    /// <param name="back">Back to the list of notes it was opened from; none when its pin was tapped.</param>
    public PinCard(NotatoController controller, OverlaySession session, NoteRecord record, int number, Action close, Action? back = null)
    {
        Ui.Plain(this);
        Annotation a = record.Annotation;

        // ---- header: Back (or the pin), "Note 2" and who wrote it when, Close -------------------------------------------
        string byline = string.Join(" · ", new[] { a.Author.Name ?? (a.Author.Kind == "agent" ? "An agent" : null), Ui.Ago(a.CreatedAt) }
            .Where(s => !string.IsNullOrEmpty(s)));
        View leading = back is null ? Ui.PinTile(number, a.Status, record.Pending, 38) : Ui.HeaderButton(back: true, back);
        Grid header = Ui.SheetHeader(leading, number > 0 ? $"Note {number.ToString(CultureInfo.InvariantCulture)}" : "Note",
            byline.Length > 0 ? Ui.SheetSubtitle(byline) : null, Ui.HeaderButton(back: false, close));

        // ---- what scrolls: badges, the note, what it is about, People only, the thread, the reply ------------------------
        VerticalStackLayout rows = Ui.Plain(new VerticalStackLayout { Spacing = 12, Padding = new Thickness(4, 0) });
        HorizontalStackLayout badges = Ui.Plain(new HorizontalStackLayout { Spacing = 5, Children = { Ui.Badge(Ui.Humanize(a.Status), a.Status) } });
        if (PeopleOnlyToggle.IsOn(a))
        {
            Border kept = Ui.Badge("Hidden from agent", Ui.PeopleOnlyBadge);
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
            string what = target.Tag + (target.TestId is { } id ? "#" + id : "") + (ElementText.Clip(target.Text, 30) is { } text ? $" “{text}”" : "");
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
            rows.Children.Add(Ui.Text(state, 12.5, Ui.NotSent));
        }

        // Sent with a capture-only token: the server took it, and the board is where it goes on from here.
        bool sentOnly = controller.CaptureOnly && !record.Pending;
        if (sentOnly)
        {
            rows.Children.Add(Ui.Text(SentOnly, 12.5, Ui.CardMuted));
        }

        Label status = Ui.Text(null, 12.5, Ui.Danger);
        status.IsVisible = false;
        status.Margin = new Thickness(4, 0);

        // People only, for the note as it is now: anyone on the thread can turn it on or off, and the thread records it.
        (Grid peopleOnlyRow, Switch peopleOnly) = Ui.SwitchRow(PeopleOnlyToggle.Label, PeopleOnlyToggle.Hint, PeopleOnlyToggle.IsOn(a), "NotatoPeopleOnly");
        peopleOnly.IsEnabled = !sentOnly;
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
        VerticalStackLayout options = Ui.Plain(new VerticalStackLayout { Spacing = 10 });
        options.Children.Add(peopleOnlyRow);
        options.IsVisible = false;
        options.AutomationId = "NotatoCardOptions";
        SheetBody body = new(rows);

        foreach (Reply reply in a.Thread.TakeLast(ThreadShown))
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
        // A note sent with a capture-only token gets none: replying, reverting and deleting are the board's.
        VerticalStackLayout deleteConfirmation = Ui.Plain(new VerticalStackLayout { Spacing = 8, IsVisible = false });
        deleteConfirmation.Children.Add(Ui.Text("Delete this note permanently?", 13, Ui.CardText));
        deleteConfirmation.Children.Add(Ui.ButtonRow([
            Ui.SheetButton("Cancel", () => deleteConfirmation.IsVisible = false),
            Ui.SheetButton("Delete note", () => _ = Run(() => controller.DeleteAsync(a.Id), "Note deleted"), Ui.SheetButtonKind.Danger),
        ]));
        List<Border> actions = [];
        if (!sentOnly)
        {
            Border more = Ui.SheetButton("More options", () =>
            {
                options.IsVisible = !options.IsVisible;
                if (options.IsVisible)
                {
                    _ = body.ScrollToAsync(options, ScrollToPosition.End, false);
                }
            });
            more.AutomationId = "NotatoMoreOptions";
            actions.Add(more);
        }
        if (controller.HasServer && !record.Pending && !sentOnly)
        {
            Entry reply = Fields.Text(null, a.Status == Statuses.Resolved ? "Reply, or say what was wrong" : "Reply");
            reply.AutomationId = "NotatoReply";
            rows.Children.Add(Fields.Box(reply));
            // The server's mention plugins, if it has any. The agent needs none: it gets every reply that is not an aside.
            MentionRow replyMentions = new(reply);
            replyMentions.SetMentions(controller.AvailableMentions);
            rows.Children.Add(replyMentions);
            (Grid asideRow, Switch aside) = Ui.SwitchRow(PeopleOnlyToggle.AsideLabel, PeopleOnlyToggle.AsideHint, false, "NotatoAside");
            options.Children.Add(asideRow);
            Label replyPrivacy = Ui.Text("Next reply hidden from agent", 12, Ui.CardMuted);
            replyPrivacy.IsVisible = false;
            rows.Children.Add(replyPrivacy);
            aside.Toggled += (_, e) => replyPrivacy.IsVisible = e.Value;

            if (a.Status == Statuses.Resolved && a.Intent is not ("question" or "approve"))
            {
                options.Children.Add(Ui.SheetButton("Revert this change…", () => _ = Run(() => controller.RequestRevertAsync(a.Id, reply.Text), "Asked the agent to undo that change")));
            }

            if (a.Status == Statuses.RevertRequested)
            {
                options.Children.Add(Ui.SheetButton("Cancel revert request", () => _ = Run(() => controller.CancelRevertAsync(a.Id), "Revert request taken back")));
            }

            if (a.Status is Statuses.Open or Statuses.Acknowledged && record.Mine)
            {
                options.Children.Add(Ui.SheetButton("Delete", () => deleteConfirmation.IsVisible = true, Ui.SheetButtonKind.Danger));
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
        else if (!sentOnly)
        {
            options.Children.Add(Ui.SheetButton("Delete", () => deleteConfirmation.IsVisible = true, Ui.SheetButtonKind.Danger));
        }

        options.Children.Add(deleteConfirmation);
        rows.Children.Add(options);
        Content = Ui.Sheet(Ui.Plain(new VerticalStackLayout { Spacing = 14, Children = { header, body, Ui.ButtonRow([.. actions]), status } }), close);
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
            text.Spans.Add(new Span { Text = "Hidden from agent · ", FontSize = 11, FontAttributes = FontAttributes.Bold, TextColor = Ui.CardMuted });
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
