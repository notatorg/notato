#if canImport(UIKit)
import SwiftUI

/// The notes on this screen, newest last as their pins are numbered; each opens its card.
struct NotesSheet: View {
    let notato: Notato
    let hooks: PlatformHooks
    let session: WeakSession
    let open: (String) -> Void
    let annotate: () -> Void
    let back: () -> Void
    let close: () -> Void

    /// The notes listed: the newest on this screen. The board has every one.
    static let shown = 50

    var body: some View {
        let notes = session.value.map { hooks.notes(on: $0) } ?? ScreenNotes()
        VStack(spacing: 10) {
            SheetHeader(title: "Notes", subtitle: "\(notes.count) on this screen · \(notato.records.count) in all") {
                HeaderButton(.back, action: back)
            } trailing: {
                HeaderButton(.close, action: close)
            }
            // One scroll view, not ViewThatFits: measuring the scrolling choice builds the rows on SwiftUI's render
            // thread during the sheet's animation, off the main actor, which Swift 6 stops the app for.
            SheetScroll { rows(notes) }
        }
    }

    /// The newest `shown`, in pin order (so the newest is last, as its pin's number is the highest), built as they
    /// scroll into view; then how many more there are, here and on other screens.
    private func rows(_ notes: ScreenNotes) -> some View {
        let newest = notes.newest(Self.shown)
        let older = notes.count - newest.count
        let others = notato.records.count - notes.count
        let more = [older > 0 ? "\(older) older on this screen." : nil, others > 0 ? "\(others) more on other screens." : nil].compactMap { $0 }
        return LazyVStack(alignment: .leading, spacing: 0) {
            if notes.all.isEmpty {
                MenuRow(icon: .crosshair, title: "Annotate", detail: "No notes on this screen yet", style: .primary, action: annotate)
            }
            ForEach(newest, id: \.record.id) { number, record in
                let a = record.annotation
                MenuRow(icon: .pin(number: number, status: a.status, pending: record.pending), title: a.comment,
                        detail: [a.status.replacingOccurrences(of: "_", with: " "), a.isPeopleOnly ? PeopleOnlyCopy.title : nil, Ago.text(a.createdAt)]
                            .compactMap { $0 }.joined(separator: " · "),
                        titleLines: 2, opens: true) { open(a.id) }
            }
            if !more.isEmpty {
                Text(more.joined(separator: " "))
                    .font(.system(size: 12.5)).foregroundStyle(Palette.muted)
                    .padding(.horizontal, 4).padding(.top, 14).padding(.bottom, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1).padding(.top, 4) }
            }
        }
    }
}
#endif
