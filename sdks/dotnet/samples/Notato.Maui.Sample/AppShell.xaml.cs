using Notato.Maui.Sample.Views;

namespace Notato.Maui.Sample;

public partial class AppShell : Shell
{
    public AppShell()
    {
        InitializeComponent();
        Routing.RegisterRoute("details", typeof(ProductDetailsPage));
    }
}
