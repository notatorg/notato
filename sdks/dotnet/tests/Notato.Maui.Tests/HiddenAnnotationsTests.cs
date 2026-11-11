using Notato.Maui.Model;
using Notato.Maui.Runtime;

namespace Notato.Maui.Tests;

public class HiddenAnnotationsTests
{
    [Fact]
    public void Hiding_keeps_feedback_and_restores_reopened_tasks_and_questions()
    {
        NotatoController controller = Fixtures.Controller();
        Annotation[] annotations = [.. Enumerable.Range(0, 2001).Select(i => Fixtures.Annotation() with
        {
            Id = $"note-{i}",
            Route = i % 2 == 0 ? "/one" : "/two",
            Status = Statuses.Resolved,
        })];
        foreach (Annotation a in annotations)
        {
            controller.Records.Add(new NoteRecord(a));
        }

        controller.HideAnnotation(annotations[0].Id);
        controller.HideAnnotation(annotations[1].Id);
        Assert.Equal(2, controller.HiddenCount);
        Assert.Equal(1999, controller.VisibleCount);
        controller.SetHideDone(true);
        Assert.Equal(2, controller.HiddenCount);
        Assert.Equal(2001, controller.Annotations.Count);
        Assert.Empty(controller.Records.On("/one"));
        Assert.Empty(controller.Records.PinnedOn("/two"));
        controller.Records.Add(new NoteRecord(annotations[0] with { Status = Statuses.Open }));
        controller.Records.Add(new NoteRecord(annotations[1] with { Status = "awaiting_response" }));
        Assert.Single(controller.Records.On("/one"));
        Assert.Single(controller.Records.On("/two"));
        controller.SetHideDone(false);
        controller.HideAnnotation(annotations[2].Id);
        Assert.Equal(2000, controller.VisibleCount);
        controller.RestoreHidden();
        Assert.Equal(2001, controller.VisibleCount);
        Assert.Equal(0, controller.HiddenCount);
    }

    [Fact]
    public void Hide_done_leaves_out_notes_finished_later_until_reopened_or_turned_off()
    {
        NotatoController controller = Fixtures.Controller();
        Annotation open = Fixtures.Annotation() with { Id = "open", Route = "/one", Status = Statuses.Open };
        Annotation resolved = Fixtures.Annotation() with { Id = "resolved", Route = "/one", Status = Statuses.Resolved };
        Annotation reverted = Fixtures.Annotation() with { Id = "reverted", Route = "/one", Status = Statuses.Reverted };
        Annotation dismissed = Fixtures.Annotation() with { Id = "dismissed", Route = "/two", Status = Statuses.Dismissed };
        foreach (Annotation a in new[] { open, resolved, reverted, dismissed })
        {
            controller.Records.Add(new NoteRecord(a));
        }

        Assert.False(controller.HideDone);
        Assert.Equal(4, controller.VisibleCount);

        controller.SetHideDone(true);
        Assert.True(controller.HideDone);
        Assert.Equal(["open"], controller.Records.On("/one").Select(x => x.Record.Annotation.Id));
        Assert.Equal(["open"], controller.Records.PinnedOn("/one").Select(x => x.Record.Annotation.Id));
        Assert.Empty(controller.Records.On("/two"));
        Assert.Equal(1, controller.VisibleCount);
        // Nothing was hidden one at a time, and the notes themselves are all still there.
        Assert.Equal(0, controller.HiddenCount);
        Assert.Equal(4, controller.Annotations.Count);

        // Finished after the switch went on: left out too.
        controller.Records.Add(new NoteRecord(open with { Status = Statuses.Resolved }));
        Assert.Empty(controller.Records.On("/one"));
        Assert.Equal(0, controller.VisibleCount);

        // Reopened: back by itself, keeping its number.
        controller.Records.Add(new NoteRecord(resolved with { Status = Statuses.Open }));
        Assert.Equal([(2, "resolved")], controller.Records.On("/one").Select(x => (x.Number, x.Record.Annotation.Id)));
        controller.Records.Add(new NoteRecord(dismissed with { Status = "awaiting_response" }));
        Assert.Single(controller.Records.On("/two"));

        controller.SetHideDone(false);
        Assert.False(controller.HideDone);
        Assert.Equal(3, controller.Records.On("/one").Count);
        Assert.Equal(4, controller.VisibleCount);
    }

    [Fact]
    public void Hide_done_is_remembered_on_the_device_until_reset()
    {
        RuntimeState state = new(remember: false);
        Annotation resolved = Fixtures.Annotation() with { Id = "resolved", Route = "/one", Status = Statuses.Resolved };
        NotatoController first = Fixtures.Controller(state: state);
        first.SetHideDone(true);
        Assert.True(state.HideDone);

        NotatoController restarted = Fixtures.Controller(state: state);
        restarted.Records.Add(new NoteRecord(resolved));
        Assert.True(restarted.HideDone);
        Assert.Empty(restarted.Records.On("/one"));
        Assert.Equal(0, restarted.VisibleCount);

        restarted.SetHideDone(false);
        Assert.Null(state.HideDone);
        Assert.False(Fixtures.Controller(state: state).HideDone);

        state.HideDone = true;
        state.Reset();
        Assert.Null(state.HideDone);
    }

    [Fact]
    public void Hidden_preferences_survive_reload_and_are_private_to_each_connection_and_person()
    {
        RuntimeState state = new(remember: false);
        HiddenAnnotations hidden = new();
        string?[] parts = ["https://stub.test", "shop", "dev", "credential", "Alice"];
        hidden.Select(parts, state.HiddenAnnotations);
        Annotation a = Fixtures.Annotation() with { Status = Statuses.Reverted };
        Assert.True(hidden.Hide([a]));
        state.HiddenAnnotations = hidden.Encoded;
        Assert.DoesNotContain("credential", state.HiddenAnnotations!);
        HiddenAnnotations reload = new();
        for (int i = 0; i < parts.Length; i++)
        {
            string?[] other = [.. parts];
            other[i] = "other";
            reload.Select(other, state.HiddenAnnotations);
            Assert.False(reload.Contains(a));
        }

        reload.Select(parts, state.HiddenAnnotations);
        Assert.True(reload.Contains(a));
        state.Reset();
        reload.Select(parts, state.HiddenAnnotations);
        Assert.False(reload.Contains(a));
    }
}
