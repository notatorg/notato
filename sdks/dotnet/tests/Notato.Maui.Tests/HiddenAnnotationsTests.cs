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
        Assert.Equal(1, controller.HiddenCount);
        controller.HideCompleted();
        Assert.Equal(2001, controller.HiddenCount);
        Assert.Equal(2001, controller.Annotations.Count);
        Assert.Empty(controller.Records.On("/one"));
        Assert.Empty(controller.Records.PinnedOn("/two"));
        controller.Records.Add(new NoteRecord(annotations[0] with { Status = Statuses.Open }));
        controller.Records.Add(new NoteRecord(annotations[1] with { Status = "awaiting_response" }));
        Assert.Single(controller.Records.On("/one"));
        Assert.Single(controller.Records.On("/two"));
        controller.HideAnnotation(annotations[0].Id);
        Assert.Equal(2, controller.VisibleCount);
        controller.RestoreHidden();
        Assert.Equal(2001, controller.VisibleCount);
        Assert.Equal(0, controller.HiddenCount);
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
