using Notato.Maui.Sample.Models;
using Notato.Maui.Sample.ViewModels;

namespace Notato.Maui.Sample.Views;

[QueryProperty(nameof(ProductId), "id")]
public partial class ProductDetailsPage : ContentPage
{
    public ProductDetailsPage() => InitializeComponent();

    public string ProductId
    {
        set
        {
            if (int.TryParse(value, out int id) && Catalog.Find(id) is { } product)
            {
                BindingContext = new ProductDetailsViewModel(product);
            }
        }
    }

    private async void OnAddToCart(object? sender, EventArgs e) =>
        await DisplayAlertAsync("Added", $"{Quantity.Value} in your cart.", "OK");

    // A modal page, to show that Notato stays on top of one.
    private async void OnCheckout(object? sender, EventArgs e) => await Navigation.PushModalAsync(new CheckoutPage());
}
