namespace Notato.Maui.Sample.Models;

public sealed record Product(int Id, string Name, string Tagline, decimal Price, string Color, string Initials, int Stock)
{
    public string PriceText => Price.ToString("C", System.Globalization.CultureInfo.GetCultureInfo("en-GB"));
    public string StockText => Stock switch { 0 => "Out of stock", < 5 => $"Only {Stock} left", _ => "In stock" };
    public bool InStock => Stock > 0;
}

public static class Catalog
{
    public static readonly IReadOnlyList<Product> Products =
    [
        new(1, "Trail Runner", "Light shoes for long days on rough ground", 89.00m, "#2563eb", "TR", 12),
        new(2, "Summit Jacket", "Waterproof shell that packs into its own pocket", 179.00m, "#db2777", "SJ", 3),
        new(3, "Camp Mug", "Enamel steel, holds a proper amount of tea", 14.50m, "#16a34a", "CM", 40),
        new(4, "Headlamp 400", "400 lumens, red night mode, USB-C", 39.99m, "#d97706", "HL", 0),
        new(5, "Dry Bag 20L", "Roll-top bag that keeps the rain out", 24.00m, "#7c3aed", "DB", 8),
        new(6, "Wool Socks", "Merino blend, two pairs", 18.00m, "#0d9488", "WS", 25),
    ];

    public static Product? Find(int id) => Products.FirstOrDefault(p => p.Id == id);
}
