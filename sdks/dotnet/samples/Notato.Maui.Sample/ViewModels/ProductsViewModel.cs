using Notato.Maui.Sample.Models;
using System.Collections.ObjectModel;

namespace Notato.Maui.Sample.ViewModels;

public sealed class ProductsViewModel
{
    public ObservableCollection<Product> Products { get; } = new(Catalog.Products);

    public string Summary => $"{Products.Count} products · free delivery over £50";
}

public sealed class ProductDetailsViewModel(Product product)
{
    public Product Product { get; } = product;
}
