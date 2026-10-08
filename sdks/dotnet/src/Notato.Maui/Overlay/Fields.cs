using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

namespace Notato.Maui.Overlay;

/// <summary>
/// Notato's own multi-line field. A type of its own so the handler customisations in
/// <see cref="NotatoAppBuilderExtensions"/> (no platform underline or border) reach Notato's fields and not the app's.
/// </summary>
internal sealed class NotatoEditor : Editor;

/// <summary>Notato's own one-line field (see <see cref="NotatoEditor"/>).</summary>
internal sealed class NotatoEntry : Entry;

/// <summary>Notato's text fields, and the soft boxes they sit in.</summary>
internal static class Fields
{
    /// <summary>A one-line field for a sheet, unstyled by the app, with no spelling help (names, addresses, replies).</summary>
    public static Entry Text(string? text, string placeholder) => Ui.Plain<Entry>(new NotatoEntry
    {
        Text = text,
        Placeholder = placeholder,
        PlaceholderColor = Ui.CardMuted,
        TextColor = Ui.CardText,
        BackgroundColor = Colors.Transparent,
        FontSize = 15,
        FontFamily = null,
        ClearButtonVisibility = ClearButtonVisibility.WhileEditing,
        IsSpellCheckEnabled = false,
        IsTextPredictionEnabled = false,
    });

    /// <summary>The box a one-line field sits in: at least 46 tall, so it is easy to tap.</summary>
    public static Border Box(View field)
    {
        field.VerticalOptions = LayoutOptions.Center;
        Border box = Ui.Box(field, Ui.Soft, 12, new Thickness(12, 2));
        box.MinimumHeightRequest = 46;
        return box;
    }

    /// <summary>The box the composer's editor sits in.</summary>
    public static Border EditorBox(View editor) => Ui.Box(editor, Ui.Soft, 12, new Thickness(8, 2));
}
