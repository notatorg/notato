using Notato.Maui;
using Notato.Maui.Model;

namespace Notato.Maui.Sample.Views;

public partial class FeedbackPage : ContentPage
{
    private readonly INotato _notato;
    private bool _updating;

    public FeedbackPage(INotato notato)
    {
        InitializeComponent();
        _notato = notato;
        notato.Changed += (_, _) => Update();
        Update();
    }

    protected override void OnAppearing()
    {
        base.OnAppearing();
        Update();
    }

    private void Update()
    {
        _updating = true;
        EnabledSwitch.IsToggled = _notato.IsEnabled;
        ToolbarSwitch.IsToggled = _notato.IsToolbarVisible;
        ToolbarSwitch.IsEnabled = _notato.IsEnabled;
        Status.Text = $"{_notato.Connection}{(_notato.ConnectionDetail is { } d ? $": {d}" : "")} · {_notato.Annotations.Count} note(s), {_notato.PendingCount} not sent";
        _updating = false;
    }

    private void OnEnabledToggled(object? sender, ToggledEventArgs e)
    {
        if (_updating)
        {
            return;
        }

        if (e.Value)
        {
            _notato.Enable();
        }
        else
        {
            _notato.Disable();
        }
    }

    private void OnToolbarToggled(object? sender, ToggledEventArgs e)
    {
        if (_updating)
        {
            return;
        }

        if (e.Value)
        {
            _notato.ShowToolbar();
        }
        else
        {
            _notato.HideToolbar();
        }
    }

    private void OnStartAnnotating(object? sender, EventArgs e) => _notato.StartAnnotating();

    private async void OnSelectBanner(object? sender, EventArgs e)
    {
        try
        {
            await _notato.SelectAsync(Banner);
        }
        catch (Exception error)
        {
            await DisplayAlertAsync("Notato", error.Message, "OK");
        }
    }

    private async void OnAnnotateFromCode(object? sender, EventArgs e)
    {
        try
        {
            Annotation note = await _notato.AnnotateAsync("#DemoBanner", "Typo: \"recieve\" should be \"receive\".", new AnnotateOptions { Intent = AnnotationIntents.Fix, Severity = Severities.Minor });
            await DisplayAlertAsync("Notato", $"Made note {note.Id[^6..]} on {note.Target.Identity[0].Selector}", "OK");
        }
        catch (Exception error)
        {
            await DisplayAlertAsync("Notato", error.Message, "OK");
        }
    }

    private void OnReset(object? sender, EventArgs e) => _notato.ResetRuntimeState();
}
