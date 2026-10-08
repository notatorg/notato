using Microsoft.Maui.Controls;

namespace Notato.Maui;

/// <summary>
/// Attached properties for marking up the app's own XAML, and the running Notato for code that cannot take it from DI.
/// <code>
/// xmlns:notato="clr-namespace:Notato.Maui;assembly=Notato.Maui"
/// &lt;Label notato:Feedback.Mask="True" /&gt;      private: covered in screenshots, its text never recorded
/// &lt;Entry notato:Feedback.Mask="False" /&gt;     shown even when MaskInputs is on (a search box)
/// &lt;Grid notato:Feedback.Ignore="True"&gt;         the picker looks through it
/// </code>
/// </summary>
public static class Feedback
{
    /// <summary>
    /// <c>True</c>: private. Covered with a grey box in every screenshot, and neither its text nor that of anything inside
    /// it goes into a note (its text, name, selector or a container's text). For a customer's name, an address, a
    /// balance. <c>False</c>: an input that is shown and recorded even when <see cref="NotatoOptions.MaskInputs"/> is on,
    /// unless a container around it is private. Unset (null) is the default. Password entries are always masked.
    /// </summary>
    public static readonly BindableProperty MaskProperty =
        BindableProperty.CreateAttached("Mask", typeof(bool?), typeof(Feedback), null);

    /// <summary>The picker never selects this element or anything in it: a debug banner, a watermark.</summary>
    public static readonly BindableProperty IgnoreProperty =
        BindableProperty.CreateAttached("Ignore", typeof(bool), typeof(Feedback), false);

    /// <summary>Whether <paramref name="view"/> is marked private (true), opted out of input masking (false), or neither (null).</summary>
    public static bool? GetMask(BindableObject view) => (bool?)view.GetValue(MaskProperty);

    /// <summary>Marks <paramref name="view"/> private (true), opts an input out of masking (false), or clears it (null).</summary>
    public static void SetMask(BindableObject view, bool? value) => view.SetValue(MaskProperty, value);

    /// <summary>Whether the picker looks through <paramref name="view"/>.</summary>
    public static bool GetIgnore(BindableObject view) => (bool)view.GetValue(IgnoreProperty);

    /// <summary>Makes the picker look through <paramref name="view"/> and everything in it.</summary>
    public static void SetIgnore(BindableObject view, bool value) => view.SetValue(IgnoreProperty, value);

    /// <summary>The running Notato, once the app has started with <c>UseNotato</c>; null before that or without it.</summary>
    public static INotato? Current { get; internal set; }
}
