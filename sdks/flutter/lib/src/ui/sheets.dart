import 'dart:async';

import 'package:flutter/material.dart' hide Badge;

import '../annotation.dart';
import '../config.dart';
import '../controller.dart';
import '../note_book.dart';
import '../runtime.dart';
import 'parts.dart';
import 'theme.dart';

/// What the bottom sheet shows: the menu, or what it opens.
sealed class Sheet {
  const Sheet();
}

/// The toolbar's ⋯ menu.
class MenuSheetKind extends Sheet {
  const MenuSheetKind();
}

/// The Notes list.
class ListSheetKind extends Sheet {
  const ListSheetKind();
}

/// The settings.
class SettingsSheetKind extends Sheet {
  const SettingsSheetKind();
}

/// Test mode: whether to clear the notes on the device.
class ClearSheetKind extends Sheet {
  const ClearSheetKind();
}

/// A note's card, opened from its pin or from the Notes list (and Back goes to the list).
class PinSheetKind extends Sheet {
  const PinSheetKind(this.id, {this.fromList = false});
  final String id;
  final bool fromList;
}

String _capital(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

String _device(BuildContext context) => switch (Theme.of(context).platform) {
  TargetPlatform.iOS || TargetPlatform.android => 'phone',
  TargetPlatform.macOS || TargetPlatform.windows || TargetPlatform.linux => 'computer',
  _ => 'device',
};

/// The toolbar's ⋯: who and how, the server's state, and everything else Notato does.
class MenuSheet extends StatelessWidget {
  const MenuSheet({
    super.key,
    required this.runtime,
    required this.here,
    required this.pins,
    required this.open,
    required this.annotate,
    required this.packageAndShare,
  });
  final NotatoRuntime runtime;

  /// The notes on this screen.
  final int here;

  /// Those of them with a pin here: the notes made in a Flutter app.
  final int pins;
  final ValueChanged<Sheet?> open;
  final VoidCallback annotate;
  final VoidCallback packageAndShare;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final host = runtime.serverHost;
    final device = _device(context);
    final pending = runtime.pendingCount;
    final subline = '${_capital(runtime.mode.name)} mode · ${host ?? 'notes stay on this $device'}';
    final pill = !runtime.hasServer
        ? null
        : switch (runtime.connection) {
            NotatoConnection.connected => ('Connected', Brand.connected),
            NotatoConnection.connecting => ('Connecting…', statusColor('acknowledged')),
            NotatoConnection.offline => ('Offline', Brand.offline),
            NotatoConnection.refused => ('Refused', Brand.offline),
            _ => null,
          };
    final problem = !runtime.hasServer
        ? null
        : switch (runtime.connection) {
            NotatoConnection.offline => (
              "Can't reach the server",
              "${host ?? 'The server'} isn't answering. Notes stay on this $device and send when it's back.",
            ),
            NotatoConnection.refused => (
              'The server refused this app',
              runtime.connectionDetail ?? "${host ?? 'The server'} did not accept this app's token or project.",
            ),
            _ => null,
          };
    void run(VoidCallback action) {
      open(null);
      action();
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SheetHeader(
          title: 'Notato',
          subtitle: subline,
          leading: const Potato(size: 38),
          trailing: pill == null
              ? null
              : Semantics(
                  key: const ValueKey('NotatoConnection'),
                  label: pill.$1,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: pill.$2.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(color: pill.$2, shape: BoxShape.circle),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          pill.$1,
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: pill.$2),
                        ),
                      ],
                    ),
                  ),
                ),
        ),
        if (problem != null)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
            decoration: BoxDecoration(
              color: Brand.offline.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        problem.$1,
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: p.text),
                      ),
                      const SizedBox(height: 2),
                      Text(problem.$2, style: TextStyle(fontSize: 13, color: p.muted, height: 1.3)),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Material(
                  key: const ValueKey('NotatoRetry'),
                  color: p.text,
                  borderRadius: BorderRadius.circular(10),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: runtime.retryConnection,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                      child: Text(
                        'Retry',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: p.background),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        Flexible(
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                MenuRow(
                  tile: const SheetTile.icon('crosshair', style: TileStyle.primary),
                  title: 'Annotate',
                  detail: 'Tap an element, write a note',
                  onTap: () => run(annotate),
                ),
                MenuRow(
                  tile: SheetTile.icon(runtime.pinsVisible ? 'eyeOff' : 'eye'),
                  title: runtime.pinsVisible ? 'Hide pins' : 'Show pins',
                  detail: pins == 0
                      ? 'No pins on this screen'
                      : pins == 1
                      ? '1 pin on this screen'
                      : '$pins pins on this screen',
                  onTap: () => run(runtime.togglePins),
                ),
                MenuRow(
                  tile: const SheetTile.icon('list'),
                  title: 'Notes',
                  detail: '$here on this screen · ${runtime.notes.length} in all',
                  opens: true,
                  onTap: () => open(const ListSheetKind()),
                ),
                if (runtime.mode == NotatoMode.test && pending > 0) ...[
                  MenuRow(
                    tile: const SheetTile.icon('package'),
                    title: 'Package and share',
                    detail: 'Zip with screenshots, share anywhere',
                    opens: true,
                    separated: true,
                    onTap: () => run(packageAndShare),
                  ),
                  MenuRow(
                    tile: const SheetTile.icon('trash', style: TileStyle.danger),
                    title: 'Clear notes',
                    detail: pending == 1 ? 'Removes the note on this device' : 'Removes all $pending from this device',
                    danger: true,
                    onTap: () => open(const ClearSheetKind()),
                  ),
                ],
                MenuRow(
                  tile: const SheetTile.icon('sliders'),
                  title: 'Settings',
                  detail: 'Your name, screenshots, server',
                  opens: true,
                  separated: true,
                  onTap: () => open(const SettingsSheetKind()),
                ),
                MenuRow(
                  tile: const SheetTile.icon('minimize'),
                  title: 'Hide toolbar',
                  detail: 'The app can bring it back',
                  separated: true,
                  onTap: () => run(runtime.hideToolbar),
                ),
                MenuRow(
                  tile: const SheetTile.icon('power', style: TileStyle.danger),
                  title: 'Turn Notato off',
                  detail: 'Until the app turns it on again',
                  danger: true,
                  onTap: () => run(runtime.disable),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// Every note on this screen, newest first, each opening its card: a list that builds only the rows in sight.
class NotesSheet extends StatelessWidget {
  const NotesSheet({super.key, required this.runtime, required this.list, required this.open, required this.annotate});
  final NotatoRuntime runtime;

  /// The notes on this screen, numbered, oldest first.
  final ScreenNotes list;
  final ValueChanged<Sheet?> open;
  final VoidCallback annotate;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final others = runtime.notes.length - list.length;
    final footer = others <= 0 ? 0 : 1;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SheetHeader(
          title: 'Notes',
          subtitle: '${list.length} on this screen · ${runtime.notes.length} in all',
          leading: HeaderButton.back(onPressed: () => open(const MenuSheetKind())),
          trailing: HeaderButton.close(onPressed: () => open(null)),
        ),
        if (list.isEmpty)
          MenuRow(
            tile: const SheetTile.icon('crosshair', style: TileStyle.primary),
            title: 'Annotate',
            detail: 'No notes on this screen yet',
            onTap: () {
              open(null);
              annotate();
            },
          ),
        Flexible(
          child: ListView.builder(
            shrinkWrap: true,
            padding: EdgeInsets.zero,
            itemCount: list.length + footer,
            itemBuilder: (context, i) {
              if (i == list.length) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Container(height: 1, color: p.line),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 10, 4, 2),
                      child: Text(
                        others == 1 ? '1 more on another screen.' : '$others more on other screens.',
                        style: TextStyle(fontSize: 12.5, color: p.muted),
                      ),
                    ),
                  ],
                );
              }
              final (:number, :record) = list[list.length - 1 - i];
              return MenuRow(
                key: ValueKey(record.id),
                tile: SheetTile.pin(PinDot(number: number, status: record.status, pending: record.pending)),
                title: '${record.annotation['comment'] ?? ''}',
                titleLines: 2,
                detail: [
                  record.status.replaceAll('_', ' '),
                  if (record.peopleOnly) PeopleOnlyCopy.title,
                  ?ago(record.createdAt),
                ].join(' · '),
                opens: true,
                onTap: () => open(PinSheetKind(record.id, fromList: true)),
              );
            },
          ),
        ),
      ],
    );
  }
}

/// Your name, screenshots and the server; Reset goes back to the app's configuration.
class SettingsSheet extends StatefulWidget {
  const SettingsSheet({super.key, required this.runtime, required this.open, required this.toast});
  final NotatoRuntime runtime;
  final ValueChanged<Sheet?> open;
  final ValueChanged<String> toast;

  @override
  State<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<SettingsSheet> {
  late final _name = TextEditingController(text: widget.runtime.authorName ?? '');
  late final _server = TextEditingController(
    text: widget.runtime.server != widget.runtime.configuration?.server ? (widget.runtime.server ?? '') : '',
  );
  late bool _screenshots = widget.runtime.screenshotsWanted;

  @override
  void dispose() {
    _name.dispose();
    _server.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final runtime = widget.runtime;
    final p = Palette.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SheetHeader(
          title: 'Settings',
          subtitle: 'Project ${runtime.configuration?.project ?? ''} · ${_capital(runtime.mode.name)} mode',
          leading: HeaderButton.back(onPressed: () => widget.open(const MenuSheetKind())),
          trailing: HeaderButton.close(onPressed: () => widget.open(null)),
        ),
        Flexible(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const FieldLabel('Your name'),
                const SizedBox(height: 6),
                TextField(
                  key: const ValueKey('NotatoName'),
                  controller: _name,
                  textCapitalization: TextCapitalization.words,
                  style: TextStyle(color: p.text, fontSize: 15),
                  decoration: fieldDecoration(context, 'Your name, on your notes'),
                ),
                const SizedBox(height: 14),
                const FieldLabel('Server'),
                const SizedBox(height: 6),
                TextField(
                  key: const ValueKey('NotatoServer'),
                  controller: _server,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  style: TextStyle(color: p.text, fontSize: 15),
                  decoration: fieldDecoration(
                    context,
                    runtime.configuration?.server ?? 'No server: notes stay on this device',
                  ),
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Text(runtime.describeConnection(), style: TextStyle(fontSize: 12, color: p.muted)),
                ),
                const SizedBox(height: 8),
                FlagToggle(
                  tile: const SheetTile.icon('camera'),
                  title: 'Screenshots',
                  hint: runtime.serverScreenshots
                      ? 'Each note takes one of the screen'
                      : 'The server has them turned off',
                  value: _screenshots,
                  onChanged: (v) => setState(() => _screenshots = v),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: SheetButton(
                'Reset',
                onPressed: () {
                  runtime.resetRuntimeState();
                  widget.open(null);
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: SheetButton(
                'Save',
                key: const ValueKey('NotatoSaveSettings'),
                kind: ButtonKind.primary,
                onPressed: () {
                  final message = runtime.saveSettings(
                    name: _name.text,
                    screenshots: _screenshots,
                    server: _server.text,
                  );
                  widget.open(null);
                  if (message != null) widget.toast(message);
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// Test mode: asks before the notes on the device are cleared.
class ClearSheet extends StatelessWidget {
  const ClearSheet({super.key, required this.runtime, required this.open, required this.toast});
  final NotatoRuntime runtime;
  final ValueChanged<Sheet?> open;
  final ValueChanged<String> toast;

  @override
  Widget build(BuildContext context) {
    final n = runtime.pendingCount;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SheetHeader(
          title: 'Clear notes?',
          subtitle: n == 1 ? 'Removes the note on this device' : 'Removes all $n from this device',
          leading: HeaderButton.back(onPressed: () => open(const MenuSheetKind())),
          trailing: HeaderButton.close(onPressed: () => open(null)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            'A package you already shared keeps them.',
            style: TextStyle(fontSize: 13.5, color: Palette.of(context).muted),
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(child: SheetButton('Keep them', onPressed: () => open(null))),
            const SizedBox(width: 10),
            Expanded(
              child: SheetButton(
                'Clear',
                kind: ButtonKind.destructive,
                onPressed: () {
                  runtime.clearLocal();
                  open(null);
                  toast('Notes cleared');
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// One entry in a note's thread. A recorded change is a quiet line; an aside is marked, and drawn outlined.
class _ThreadEntry extends StatelessWidget {
  const _ThreadEntry(this.reply);
  final Map<String, Object?> reply;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final author = reply['author'] as Map? ?? const {};
    final name = author['name'] as String? ?? (author['kind'] == 'agent' ? 'Agent' : 'You');
    final body = '${reply['body'] ?? ''}';
    if (reply['automatic'] == true) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: name,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              TextSpan(text: ' · $body'),
            ],
          ),
          style: TextStyle(fontSize: 12, color: p.muted),
        ),
      );
    }
    final aside = reply['aside'] == true;
    return Semantics(
      label: aside ? 'Aside, kept from the agent' : null,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: aside ? Colors.transparent : p.soft,
          border: aside ? Border.all(color: p.line) : null,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (aside)
              Text(
                PeopleOnlyCopy.aside,
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: p.muted),
              ),
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: '$name: ',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  TextSpan(text: body),
                ],
              ),
              style: TextStyle(fontSize: 14.5, color: aside ? p.muted : p.text),
            ),
          ],
        ),
      ),
    );
  }
}

const _keptHere = 'Kept on this device. Package it from the menu to share it.';

/// A note's card: its status, comment and thread; People only, a reply or an aside; revert, cancel or delete.
class NoteCard extends StatefulWidget {
  const NoteCard({
    super.key,
    required this.runtime,
    required this.record,
    required this.number,
    required this.fromList,
    required this.open,
    required this.toast,
  });
  final NotatoRuntime runtime;
  final NoteRecord record;
  final int number;
  final bool fromList;
  final ValueChanged<Sheet?> open;
  final ValueChanged<String> toast;

  @override
  State<NoteCard> createState() => _NoteCardState();
}

class _NoteCardState extends State<NoteCard> {
  final _reply = TextEditingController();
  var _aside = false;
  String? _problem;
  var _busy = false;
  bool? _asked;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  /// Runs one of the card's actions: the card closes and says [done] when it worked, and says what went wrong when it
  /// did not. One at a time.
  Future<void> _run(Future<void> Function() action, String done) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _problem = null;
    });
    try {
      await action();
      widget.open(null);
      widget.toast(done);
    } catch (e) {
      if (mounted) setState(() => _problem = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The People only switch: shows the new value while the change is made, and the old one again if it fails.
  Future<void> _setPeopleOnly(bool on) async {
    if (_asked != null || on == widget.record.peopleOnly) return;
    setState(() {
      _asked = on;
      _problem = null;
    });
    try {
      await widget.runtime.setPeopleOnly(widget.record.id, on);
    } catch (e) {
      if (mounted) setState(() => _problem = '$e');
    } finally {
      if (mounted) setState(() => _asked = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final runtime = widget.runtime;
    final record = widget.record;
    final a = record.annotation;
    final status = record.status;
    final live = runtime.hasServer && !record.pending;
    final author = a['author'] as Map? ?? const {};
    final byline = [
      author['name'] as String? ?? (author['kind'] == 'agent' ? 'An agent' : null),
      ago(record.createdAt),
    ].whereType<String>().join(' · ');
    final identity = ((a['target'] as Map?)?['identity'] as List?)?.firstOrNull as Map?;
    String? target;
    if (identity != null) {
      final text = identity['text'] as String?;
      target =
          '${identity['tag']}${identity['testId'] != null ? ' #${identity['testId']}' : ''}'
          '${text != null ? ' “${clip(text, 30)}”' : ''}';
    }
    final thread = ((a['thread'] as List?) ?? const []).whereType<Map>().map((m) => m.cast<String, Object?>()).toList();
    final intent = a['intent'] as String?;
    final severity = a['severity'] as String?;
    final actions = <Widget>[
      if (live) ...[
        if (status == 'resolved')
          SheetButton(
            'Ask the agent to revert',
            onPressed: () => _run(
              () => runtime.requestRevert(record.id, reason: _reply.text),
              'Asked the agent to undo that change',
            ),
          ),
        if (status == 'revert_requested')
          SheetButton(
            'Cancel request',
            onPressed: () => _run(() => runtime.cancelRevert(record.id), 'Revert request taken back'),
          ),
        if (record.mine && status == 'open')
          SheetButton(
            'Delete',
            kind: ButtonKind.danger,
            onPressed: () => _run(() => runtime.delete(record.id), 'Note deleted'),
          ),
        SheetButton(
          'Reply',
          key: const ValueKey('NotatoSendReply'),
          kind: ButtonKind.primary,
          onPressed: () {
            final text = _reply.text.trim();
            if (text.isEmpty) {
              setState(() => _problem = 'Write a reply first.');
              return;
            }
            final aside = _aside;
            unawaited(
              _run(() async {
                await runtime.reply(record.id, text, aside: aside);
                if (mounted) setState(() => _aside = false);
              }, aside ? 'Aside sent' : 'Reply sent'),
            );
          },
        ),
      ] else
        SheetButton(
          'Delete',
          kind: ButtonKind.danger,
          onPressed: () => _run(() => runtime.delete(record.id), 'Note deleted'),
        ),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SheetHeader(
          title: widget.number > 0 ? 'Note ${widget.number}' : 'Note',
          subtitle: byline.isEmpty ? null : byline,
          leading: widget.fromList
              ? HeaderButton.back(onPressed: () => widget.open(const ListSheetKind()))
              : SheetTile.pin(PinDot(number: widget.number, status: status, pending: record.pending), size: 38),
          trailing: HeaderButton.close(onPressed: () => widget.open(null)),
        ),
        // A long thread scrolls; the reply field and the buttons stay.
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  spacing: 5,
                  runSpacing: 5,
                  children: [
                    Badge(status, color: statusColor(status)),
                    if (intent != null) Badge(intent, color: p.muted),
                    if (severity != null) Badge(severity, color: severity == 'blocker' ? Brand.danger : p.muted),
                    if (record.peopleOnly) const PeopleOnlyBadge(),
                  ],
                ),
                const SizedBox(height: 12),
                Text('${a['comment'] ?? ''}', style: TextStyle(fontSize: 16, color: p.text)),
                if (target != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    target,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, color: p.muted),
                  ),
                ],
                if (record.pending) ...[
                  const SizedBox(height: 8),
                  Text(
                    !runtime.hasServer
                        ? _keptHere
                        : record.failed != null
                        ? 'Not sent: ${record.failed}'
                        : 'Not sent yet: ${record.waiting ?? 'it goes when the server can be reached.'}',
                    style: TextStyle(fontSize: 12.5, color: runtime.hasServer ? statusColor('acknowledged') : p.muted),
                  ),
                ],
                const SizedBox(height: 12),
                FlagToggle(
                  key: const ValueKey('NotatoNotePeopleOnly'),
                  title: PeopleOnlyCopy.title,
                  hint: PeopleOnlyCopy.hint,
                  value: _asked ?? record.peopleOnly,
                  onChanged: _asked == null ? _setPeopleOnly : null,
                ),
                for (final reply in thread.length > 4 ? thread.sublist(thread.length - 4) : thread) ...[
                  const SizedBox(height: 8),
                  _ThreadEntry(reply),
                ],
                if (thread.length > 4) ...[
                  const SizedBox(height: 6),
                  Text('${thread.length - 4} earlier on the board.', style: TextStyle(fontSize: 12, color: p.muted)),
                ],
              ],
            ),
          ),
        ),
        // Outside the scrolling thread, so the keyboard never hides what is being typed.
        if (live) ...[
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('NotatoReply'),
            controller: _reply,
            minLines: 1,
            maxLines: 4,
            style: TextStyle(color: p.text, fontSize: 15),
            decoration: fieldDecoration(context, status == 'resolved' ? 'Reply, or say what was wrong' : 'Reply'),
          ),
          const SizedBox(height: 8),
          FlagToggle(
            key: const ValueKey('NotatoAside'),
            title: PeopleOnlyCopy.aside,
            hint: PeopleOnlyCopy.asideHint,
            value: _aside,
            onChanged: (v) => setState(() => _aside = v),
          ),
        ],
        const SizedBox(height: 12),
        if (actions.length > 1)
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (i, button) in actions.indexed) ...[if (i > 0) const SizedBox(height: 8), button],
            ],
          )
        else
          Row(
            children: [
              for (final (i, button) in actions.indexed) ...[
                if (i > 0) const SizedBox(width: 10),
                Expanded(child: button),
              ],
            ],
          ),
        if (_problem != null) ...[
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(_problem!, style: const TextStyle(fontSize: 12.5, color: Brand.danger)),
          ),
        ],
      ],
    );
  }
}
