using Microsoft.Extensions.Logging;

namespace Notato.Maui.Sample.Views;

public partial class AccountPage : ContentPage
{
    private readonly ILogger<AccountPage> _logger;

    public AccountPage(ILogger<AccountPage> logger)
    {
        InitializeComponent();
        _logger = logger;
    }

    private void OnSignIn(object? sender, EventArgs e)
    {
        // Something for Notato's log capture to attach to a note about this button.
        _logger.LogWarning("Sign in failed for {Email}: the demo has no accounts", Email.Text);
    }
}
