using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Shapes;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Inspection;

/// <summary>Describes an element the way the schema's <see cref="ElementIdentity"/> does, so the agent can find it in the code.</summary>
internal sealed class ElementInspector(SourceLocator sources)
{
    private static readonly string[] FrameworkPrefixes = ["Microsoft.", "System.", "Mono.", "Xamarin.", "CommunityToolkit.", "Java.", "UIKit.", "Foundation."];

    public SourceLocator Sources => sources;

    public ElementIdentity Describe(Element element, bool maskInputs)
    {
        string? automationId = string.IsNullOrWhiteSpace(element.AutomationId) ? null : element.AutomationId;
        List<string>? classes = (element as VisualElement)?.StyleClass?.Where(c => !string.IsNullOrWhiteSpace(c)).ToList();
        return new ElementIdentity
        {
            Selector = Selectors.For(element),
            TestId = automationId,
            PlatformId = automationId,
            Role = ElementText.RoleOf(element),
            Name = ElementText.NameOf(element),
            Tag = VisualTree.TypeName(element.GetType()),
            Classes = classes is { Count: > 0 } ? classes : null,
            Text = ElementText.Visible(element, maskInputs),
            Source = sources.Locate(element),
            Component = ComponentOf(element),
            Styles = element is VisualElement visual ? StylesOf(visual) : null,
            Ancestors = AncestorsOf(element),
        };
    }

    /// <summary>A type the app wrote (a page, a ContentView, a custom control), as opposed to one from a framework.</summary>
    public static bool IsAppType(Type type)
    {
        string name = type.Assembly.GetName().Name ?? "";
        return !FrameworkPrefixes.Any(p => name.StartsWith(p, StringComparison.Ordinal)) && name != "Notato.Maui";
    }

    /// <summary>The app's own pages and views around the element, outermost first; the nearest one names the component.</summary>
    public ComponentInfo? ComponentOf(Element element, int limit = 8)
    {
        List<Element> components = [.. VisualTree.SelfAndAncestors(element).Where(e => IsAppType(e.GetType()))];
        if (components.Count == 0)
        {
            return null;
        }

        Element nearest = components[0];
        List<string> names = [];
        foreach (Element c in components)
        {
            string n = VisualTree.TypeName(c.GetType());
            if (names.Count == 0 || names[^1] != n)
            {
                names.Add(n);
            }

            if (names.Count == limit)
            {
                break;
            }
        }
        names.Reverse();
        // The instance's own source info says where it is used (ProductsPage.xaml), not where it is written.
        string? file = sources.XamlFileOf(nearest);
        return new ComponentInfo
        {
            Name = VisualTree.TypeName(nearest.GetType()),
            Source = file,
            Path = names.Count >= 2 ? names : null,
        };
    }

    /// <summary>The elements around this one, outermost first, nearest six, up to its page.</summary>
    public static IReadOnlyList<string>? AncestorsOf(Element element, int limit = 6)
    {
        List<string> names = [];
        foreach (Element? e in VisualTree.SelfAndAncestors(element).Skip(1))
        {
            if (names.Count == limit)
            {
                break;
            }

            names.Insert(0, Selectors.Segment(e, withPosition: false));
            if (e is Page)
            {
                break;
            }
        }
        return names.Count > 0 ? names : null;
    }

    private static string Number(double value) => Math.Round(value, 2).ToString(CultureInfo.InvariantCulture);

    private static string Hex(Color color) => color.Alpha >= 0.999 ? color.ToRgbaHex(false).ToLowerInvariant() : color.ToRgbaHex(true).ToLowerInvariant();

    private static string Thickness(Thickness t) =>
        t.Left == t.Right && t.Top == t.Bottom
            ? t.Left == t.Top ? Number(t.Left) : $"{Number(t.Top)} {Number(t.Left)}"
            : $"{Number(t.Left)} {Number(t.Top)} {Number(t.Right)} {Number(t.Bottom)}";

    private static string? BrushText(Brush? brush) => brush switch
    {
        null => null,
        SolidColorBrush { Color: { } c } => c.Alpha <= 0.001 ? null : Hex(c),
        LinearGradientBrush linear => $"linear-gradient({string.Join(", ", linear.GradientStops.Select(s => Hex(s.Color)))})",
        RadialGradientBrush radial => $"radial-gradient({string.Join(", ", radial.GradientStops.Select(s => Hex(s.Color)))})",
        // MAUI's own wrappers (an ImmutableBrush made from BackgroundColor) say nothing the colour does not.
        _ => null,
    };

    /// <summary>
    /// A curated set of the values the element actually has: colour, type, size, spacing, shape. Defaults are left out,
    /// so what is listed is what someone chose.
    /// </summary>
    public static IReadOnlyDictionary<string, string> StylesOf(VisualElement e)
    {
        Dictionary<string, string> s = [];
        void Set(string key, string? value)
        {
            if (!string.IsNullOrEmpty(value))
            {
                s[key] = value;
            }
        }

        Set("width", Number(e.Width));
        Set("height", Number(e.Height));
        if (e.WidthRequest >= 0)
        {
            Set("width-request", Number(e.WidthRequest));
        }

        if (e.HeightRequest >= 0)
        {
            Set("height-request", Number(e.HeightRequest));
        }

        if (e.MinimumHeightRequest >= 0)
        {
            Set("min-height", Number(e.MinimumHeightRequest));
        }

        if (e is View view)
        {
            if (view.Margin != default)
            {
                Set("margin", Thickness(view.Margin));
            }

            if (view.HorizontalOptions.Alignment != LayoutAlignment.Fill)
            {
                Set("horizontal-options", view.HorizontalOptions.Alignment.ToString());
            }

            if (view.VerticalOptions.Alignment != LayoutAlignment.Fill)
            {
                Set("vertical-options", view.VerticalOptions.Alignment.ToString());
            }
        }
        if (e is IPadding padded && padded.Padding != default)
        {
            Set("padding", Thickness(padded.Padding));
        }

        Set("background", e.BackgroundColor is { Alpha: > 0.001f } bg ? Hex(bg) : BrushText(e.Background));
        if (e.Opacity < 1)
        {
            Set("opacity", Number(e.Opacity));
        }

        if (!e.IsEnabled)
        {
            Set("enabled", "false");
        }

        if (e.InputTransparent)
        {
            Set("input-transparent", "true");
        }

        if (e.Shadow is { } shadow)
        {
            Set("shadow", $"{BrushText(shadow.Brush) ?? "#000000"} {Number(shadow.Offset.X)} {Number(shadow.Offset.Y)} {Number(shadow.Radius)}");
        }

        if (e is ITextStyle text)
        {
            if (text.TextColor is { } color)
            {
                Set("color", Hex(color));
            }

            Microsoft.Maui.Font font = text.Font;
            if (font.Size > 0)
            {
                Set("font-size", Number(font.Size));
            }

            if (!string.IsNullOrEmpty(font.Family))
            {
                Set("font-family", font.Family);
            }

            if (font.Weight != FontWeight.Regular)
            {
                Set("font-weight", ((int)font.Weight).ToString(CultureInfo.InvariantCulture));
            }

            if (font.Slant != FontSlant.Default)
            {
                Set("font-style", font.Slant.ToString().ToLowerInvariant());
            }

            if (text.CharacterSpacing != 0)
            {
                Set("letter-spacing", Number(text.CharacterSpacing));
            }
        }
        switch (e)
        {
            case Label label:
                if (label.LineHeight >= 0)
                {
                    Set("line-height", Number(label.LineHeight));
                }

                if (label.HorizontalTextAlignment != TextAlignment.Start)
                {
                    Set("text-align", label.HorizontalTextAlignment.ToString().ToLowerInvariant());
                }

                if (label.MaxLines >= 0)
                {
                    Set("max-lines", label.MaxLines.ToString(CultureInfo.InvariantCulture));
                }

                if (label.LineBreakMode != LineBreakMode.WordWrap)
                {
                    Set("line-break", label.LineBreakMode.ToString());
                }

                if (label.TextDecorations != TextDecorations.None)
                {
                    Set("text-decoration", label.TextDecorations.ToString().ToLowerInvariant());
                }

                break;
            case Button button:
                if (button.CornerRadius >= 0)
                {
                    Set("corner-radius", Number(button.CornerRadius));
                }

                if (button.BorderWidth > 0)
                {
                    Set("border-width", Number(button.BorderWidth));
                    if (button.BorderColor is { } border)
                    {
                        Set("border-color", Hex(border));
                    }
                }
                break;
            case Border border:
                if (border.StrokeThickness > 0 && BrushText(border.Stroke) is { } stroke)
                {
                    Set("stroke", stroke);
                    Set("stroke-thickness", Number(border.StrokeThickness));
                }
                if (border.StrokeShape is RoundRectangle round)
                {
                    CornerRadius r = round.CornerRadius;
                    Set("corner-radius", r.TopLeft == r.TopRight && r.TopLeft == r.BottomLeft && r.TopLeft == r.BottomRight
                        ? Number(r.TopLeft)
                        : $"{Number(r.TopLeft)} {Number(r.TopRight)} {Number(r.BottomRight)} {Number(r.BottomLeft)}");
                }
                break;
            case Image image:
                Set("aspect", image.Aspect.ToString());
                break;
            case StackBase stack:
                if (stack.Spacing != 0)
                {
                    Set("spacing", Number(stack.Spacing));
                }

                break;
            case Grid grid:
                if (grid.RowSpacing != 0)
                {
                    Set("row-spacing", Number(grid.RowSpacing));
                }

                if (grid.ColumnSpacing != 0)
                {
                    Set("column-spacing", Number(grid.ColumnSpacing));
                }

                break;
        }
        return s;
    }
}
