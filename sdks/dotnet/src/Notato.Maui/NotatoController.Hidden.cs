using Notato.Maui.Model;
using Notato.Maui.Runtime;

namespace Notato.Maui;

internal sealed partial class NotatoController
{
    private readonly HiddenAnnotations _hidden = new();

    private void SyncHidden()
    {
        _hidden.Select([Server, Project, ModeName, Options.TokenFor(Server), AuthorName], _state.HiddenAnnotations);
        _records.SetHidden(_hidden.Ids);
    }

    internal int HiddenCount { get { SyncHidden(); return _hidden.Ids.Count; } }
    internal int CompletedCount { get { SyncHidden(); return _records.Count(r => HiddenAnnotations.IsCompleted(r.Annotation.Status) && !_hidden.Contains(r.Annotation)); } }
    internal int VisibleCount { get { SyncHidden(); return _records.Count(r => !_hidden.Contains(r.Annotation)); } }

    internal void HideAnnotation(string id)
    {
        SyncHidden();
        if (_records.Find(id)?.Annotation is { } a && _hidden.Hide([a]))
        {
            SaveHidden();
        }
    }

    internal void HideCompleted()
    {
        SyncHidden();
        if (_hidden.Hide(_records.Select(r => r.Annotation)))
        {
            SaveHidden();
        }
    }

    internal void RestoreHidden()
    {
        SyncHidden();
        _hidden.Clear();
        SaveHidden();
    }

    private void SaveHidden()
    {
        _state.HiddenAnnotations = _hidden.Encoded;
        _records.SetHidden(_hidden.Ids);
        RenderAll();
    }
}
