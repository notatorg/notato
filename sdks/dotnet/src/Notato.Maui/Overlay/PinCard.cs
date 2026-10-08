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
        List<Border> actions = [];
        if (controller.HasServer && !record.Pending)
        {
            Entry reply = Fields.Text(null, a.Status == Statuses.Resolved ? "Reply, or say what was wrong" : "Reply");
            reply.AutomationId = "NotatoReply";
            rows.Children.Add(Fields.Box(reply));
            // The server's mention plugins, if it has any. The agent needs none: it gets every reply that is not an aside.
            MentionRow replyMentions = new(reply);
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
