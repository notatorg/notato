using Notato.Maui.Sample.Models;
using Notato.Maui.Sample.ViewModels;

namespace Notato.Maui.Sample.Views;

public partial class ProductsPage : ContentPage
{
    public ProductsPage()
    {
        InitializeComponent();
        BindingContext = new ProductsViewModel();
    }

    private async void OnSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.CurrentSelection.FirstOrDefault() is not Product product)
        {
            return;
        }

        ProductList.SelectedItem = null;
        await Shell.Current.GoToAsync($"details?id={product.Id}");
    }
}
