using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;
using Notato.Maui.Model;
using System.Globalization;

namespace Notato.Maui.Overlay;

// The sheets: the note being written, the ⋯ menu, and what its rows open (Notes, Settings, Clear notes). One shows at
// a time, over the app, fitted to the room the window and the keyboard leave.
internal sealed partial class NotatoOverlay
{
    /// <summary>The note being written goes at the top, away from a selection in the bottom half.</summary>
    private bool _sheetAtTop;
    /// <summary>
    /// The sheet that is open. One going away is still in the host until it is out of sight, but no longer open: what
    /// asks whether a sheet (or the note being written) is open reads this.
    /// </summary>
    private View? _sheet;
    /// <summary>The open sheet's height when it was last fitted: how far it slides in.</summary>
    private double _sheetMeasured;

    public bool SheetOpen => _sheet is not null;

    /// <summary>The note goes in the half of the screen the selection is not in, so the outline stays in view.</summary>
    private void PlaceSheetAwayFrom(SelectionView selection)
    {
        if (selection.Rects.Count == 0 || Height <= 0)
        {
            return;
        }

        double middle = selection.Rects[0].Center.Y;
        _sheetAtTop = middle > Height / 2;
        ApplySheetPosition();
    }

    private void ApplySheetPosition()
    {
        // With the keyboard up, the bottom is taken: the sheet sits just above the keyboard instead.
        bool top = _sheetAtTop && _keyboard <= 0;
        _sheetHost.VerticalOptions = top ? LayoutOptions.Start : LayoutOptions.End;
#if IOS || MACCATALYST
        // A bottom sheet floats 8 off the screen's edge, over the home indicator's strip, as iOS's own sheets do; the
        // note being written stays clear of it.
        bool floating = _sheetHost.Content is not null and not ComposerCard;
        double bottom = _keyboard > 0 ? _keyboard + 10 : floating ? 8 : _safe.Bottom + 10;
#else
        double bottom = Math.Max(_safe.Bottom, _keyboard) + 10;
#endif
        _sheetHost.Margin = new Thickness(Math.Max(8, _safe.Left + 6), _safe.Top + 12, Math.Max(8, _safe.Right + 6), bottom);
    }

    /// <param name="card">What to show.</param>
    /// <param name="dim">Dim the app behind it, and close it on a tap there.</param>
    /// <param name="fromBar">Opened from the toolbar's menu: folding the toolbar closes it.</param>
    public void ShowSheet(View card, bool dim, bool fromBar = false)
    {
        if (card is not ComposerCard)
        {
            _sheetAtTop = false;
        }

        _sheetFromBar = fromBar;
        _sheet = card;
        _sheetMeasured = 0;
        _sheetHost.Content = card;
        _sheetHost.InputTransparent = false;
        _backdrop.InputTransparent = false;
        ApplySheetPosition();
        FitSheet();
        // Up out of the bottom; one replacing another (Back, or a menu row) is swapped where it is.
        MoveSheet(show: true, dim);
        Render();
    }

    /// <summary>
    /// What scrolls in the sheet (its <see cref="SheetBody"/>) gets the room the rest of it leaves between the sheet's
    /// margins: the window less the status bar, and less the keyboard while it is up. The rest is measured, so stacked
    /// buttons, a long error or large text are allowed for.
    /// </summary>
    private void FitSheet()
    {
        if (_sheetHost.Content is not View sheet || Width <= 0 || Height <= 0
            || sheet.GetVisualTreeDescendants().OfType<SheetBody>().FirstOrDefault() is not { } body)
        {
            return;
        }

        Thickness margin = _sheetHost.Margin;
        double width = Math.Min(_sheetHost.MaximumWidthRequest, Width - margin.Left - margin.Right);
        double room = Height - margin.Top - margin.Bottom;
        // The whole sheet as tall as it wants to be, the body as it is now: the difference is everything else.
        double whole = ((IView)sheet).Measure(width, double.PositiveInfinity).Height;
        _sheetMeasured = whole;
        double rest = whole - body.DesiredSize.Height;
        double cap = Math.Max(SheetBody.Least, room - rest);
        // Only a real change: setting it lays the sheet out again, which fits it again.
        if (Math.Abs(cap - body.MaximumHeightRequest) > 0.5)
        {
            body.MaximumHeightRequest = cap;
        }
    }

    /// <summary>Closes the sheet: it is closed at once, and slides away (out of reach of taps) before it leaves the host.</summary>
    public void CloseSheet()
    {
        bool wasComposer = _sheet is ComposerCard;
        _session.Host.ReturnFocus();
        _sheet = null;
        _sheetFromBar = false;
        _sheetHost.InputTransparent = true;
        _backdrop.InputTransparent = true;
        MoveSheet(show: false, dim: false);
        if (wasComposer)
        {
            _controller.CancelSelection(_session);
        }

        Render();
    }

    public ComposerCard? Composer => _sheet as ComposerCard;

    public void OpenComposer(SelectionView selection, bool screenshotsOff)
    {
        if (_sheet is ComposerCard existing)
        {
            existing.SetTarget(selection.Title, selection.Subtitle);
            PlaceSheetAwayFrom(selection);
            return;
        }
        PlaceSheetAwayFrom(selection);
        ComposerCard card = new(selection.Title, selection.Subtitle, screenshotsOff,
            onParent: () => _controller.SelectParent(_session),
            onCancel: CloseSheet,
            onSend: (comment, intent, severity, peopleOnly) => _controller.SubmitAsync(_session, comment, intent, severity, peopleOnly));
        card.SetMentions(_controller.AvailableMentions);
        ShowSheet(card, dim: false);
    }

    private void OpenMenu()
    {
        MenuSheet menu = new(_controller, _session, action =>
        {
            CloseSheet();
            switch (action)
            {
                case MenuAction.Annotate: _controller.StartAnnotating(); break;
                case MenuAction.TogglePins: _controller.TogglePins(); break;
                case MenuAction.Notes: OpenList(); break;
                case MenuAction.Package: _ = _controller.PackageFromMenuAsync(_session); break;
                case MenuAction.Clear: ConfirmClear(); break;
                case MenuAction.Settings: OpenSettings(); break;
                case MenuAction.HideToolbar: _controller.HideToolbar(); break;
                case MenuAction.TurnOff: _controller.Disable(); break;
            }
        }, CloseSheet);
        ShowSheet(menu, dim: true, fromBar: true);
    }

    /// <summary>A sheet the menu opened: Back reopens the menu, Close closes it.</summary>
    private Grid SubHeader(string title, string? subtitle) =>
        Ui.SheetHeader(Ui.HeaderButton(back: true, OpenMenu), title, Ui.SheetSubtitle(subtitle), Ui.HeaderButton(back: false, CloseSheet));

    private void ConfirmClear()
    {
        Label note = Ui.Text("A package you already shared keeps them.", 13.5, Ui.CardMuted);
        note.Margin = new Thickness(4, 0);
        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                SubHeader("Clear notes?", MenuText.ClearLine(_controller.PendingCount)),
                note,
                Ui.ButtonRow(Ui.SheetButton("Keep them", CloseSheet), Ui.SheetButton("Clear", () => _ = ClearAsync(), Ui.SheetButtonKind.Destructive)),
            },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);

        async Task ClearAsync()
        {
            try
            {
                await _controller.ClearLocalAsync();
                CloseSheet();
                Toast("Notes cleared");
            }
            catch (Exception error)
            {
                // The notes are still on the device: say so, and leave the sheet open to try again.
                Toast($"Couldn't clear the notes: {error.Message}");
            }
        }
    }

    private void OpenList()
    {
        IReadOnlyList<(int Number, NoteRecord Record)> list = _controller.RecordsOnRoute(_session);
        VerticalStackLayout rows = Ui.Plain(new VerticalStackLayout { Spacing = 0 });
        if (list.Count == 0)
        {
            Border annotate = Ui.SheetRow(Ui.IconTile(Ui.IconCrosshair, MenuRowKind.Primary), "Annotate", "No notes on this screen yet", () =>
            {
                CloseSheet();
                _controller.StartAnnotating();
            });
            annotate.AutomationId = "NotatoNotesAnnotate";
            rows.Children.Add(annotate);
        }

        foreach ((int number, NoteRecord record) in list.Take(10))
        {
            Annotation a = record.Annotation;
            string about = string.Join(" · ", new[] { Ui.Humanize(a.Status), PeopleOnlyToggle.IsOn(a) ? PeopleOnlyToggle.Label : null, Ui.Ago(a.CreatedAt) }
                .Where(s => !string.IsNullOrEmpty(s)));
            string id = a.Id;
            Border row = Ui.SheetRow(Ui.PinTile(number, a.Status, record.Pending), a.Comment, about, () => _controller.OpenPin(_session, id, back: OpenList),
                chevron: true, titleLines: 2);
            row.AutomationId = "NotatoNote-" + number.ToString(CultureInfo.InvariantCulture);
            rows.Children.Add(row);
        }

        int others = _controller.Annotations.Count - list.Count;
        string more = string.Join(" ", new[]
        {
            list.Count > 10 ? $"{list.Count - 10} more here: tap their pins." : null,
            others > 0 ? $"{others} more on other screens." : null,
        }.Where(s => s is not null));
        if (more.Length > 0)
        {
            rows.Children.Add(Ui.Rule());
            Label footer = Ui.Text(more, 12.5, Ui.CardMuted);
            footer.Margin = new Thickness(4, 5, 4, 2);
            rows.Children.Add(footer);
        }

        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 10,
            Children = { SubHeader("Notes", MenuText.NotesLine(list.Count, _controller.Annotations.Count)), new SheetBody(rows) },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);
    }

    private void OpenSettings()
    {
        Entry name = Fields.Text(_controller.AuthorName, "Your name, on your notes");
        Entry server = Fields.Text(_controller.ServerOverride, _controller.ConfiguredServer ?? "No server: notes stay on this device");
        server.Keyboard = Keyboard.Url;
        (Grid shotsRow, Switch screenshots) = Ui.SwitchTileRow(Ui.IconTile(Ui.IconCamera), "Screenshots",
            _controller.ServerScreenshotsAllowed ? "Each note takes one of the screen" : "The server has them turned off",
            _controller.ScreenshotsWanted, "NotatoScreenshots");

        Label connection = Ui.Text(_controller.DescribeConnection(), 12, Ui.CardMuted);
        connection.Margin = new Thickness(4, 0);
        // The fields scroll when the keyboard leaves too little room for all of it; the header and buttons stay.
        VerticalStackLayout fields = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                Ui.Plain(new VerticalStackLayout { Spacing = 6, Children = { Ui.FieldLabel("Your name"), Fields.Box(name) } }),
                Ui.Plain(new VerticalStackLayout { Spacing = 6, Children = { Ui.FieldLabel("Server"), Fields.Box(server), connection } }),
                shotsRow,
            },
        });
        VerticalStackLayout body = Ui.Plain(new VerticalStackLayout
        {
            Spacing = 14,
            Children =
            {
                SubHeader("Settings", $"Project {_controller.Project} · {_controller.Mode} mode"),
                new SheetBody(fields),
                Ui.ButtonRow(
                    Ui.SheetButton("Reset", () =>
                    {
                        _controller.ResetRuntimeState();
                        CloseSheet();
                        Toast("Back to the app's configured settings");
                    }),
                    Ui.SheetButton("Save", () =>
                    {
                        _controller.SaveSettings(name.Text, screenshots.IsToggled, server.Text);
                        CloseSheet();
                    }, Ui.SheetButtonKind.Primary)),
            },
        });
        ShowSheet(Ui.Sheet(body, CloseSheet), dim: true, fromBar: true);
    }
}
