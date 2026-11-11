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
        _records.SetHideDone(HideDone);
    }

    /// <summary>
    /// Settings' "Hide done annotations": every finished note (resolved, reverted, dismissed) is left out of the pins
    /// and the lists, including ones finished later, until it is reopened or this is turned off. Kept on this device.
    /// </summary>
    internal bool HideDone => _state.HideDone ?? false;

    internal int HiddenCount { get { SyncHidden(); return _hidden.Ids.Count; } }
    internal int VisibleCount { get { SyncHidden(); return _records.Count(r => !_records.IsHidden(r.Annotation)); } }

    internal void SetHideDone(bool on)
    {
        if (on == HideDone)
        {
            return;
        }

        _state.HideDone = on ? true : null;
        SyncHidden();
        RenderAll();
    }

    internal void HideAnnotation(string id)
    {
        SyncHidden();
        if (_records.Find(id)?.Annotation is { } a && _hidden.Hide([a]))
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
