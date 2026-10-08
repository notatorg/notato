namespace Notato.Maui.Sample.Views;

public partial class CheckoutPage : ContentPage
{
    public CheckoutPage() => InitializeComponent();

    private async void OnClose(object? sender, EventArgs e) => await Navigation.PopModalAsync();
}
