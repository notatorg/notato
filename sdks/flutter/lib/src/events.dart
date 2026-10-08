import 'dart:convert';

/// One server-sent event: its name, and its data, parsed as JSON when it is JSON.
class ServerEvent {
  const ServerEvent(this.event, this.data);
  final String event;
  final Object? data;
}

/// Reads a text/event-stream as it arrives: feed it each chunk of text, and it returns the events completed so far.
class EventParser {
  final _buffer = StringBuffer();

  List<ServerEvent> add(String chunk) {
    _buffer.write(chunk);
    var text = _buffer.toString().replaceAll('\r\n', '\n');
    final events = <ServerEvent>[];
    var end = text.indexOf('\n\n');
    while (end >= 0) {
      final block = text.substring(0, end);
      text = text.substring(end + 2);
      var event = 'message';
      final data = <String>[];
      for (final line in block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.substring(6).trim();
        if (line.startsWith('data:')) data.add(line.substring(5).replaceFirst(RegExp('^ '), ''));
      }
      if (data.isNotEmpty) {
        final raw = data.join('\n');
        Object? parsed = raw;
        try {
          parsed = jsonDecode(raw);
        } on FormatException {
          // plain text
        }
        events.add(ServerEvent(event, parsed));
      }
      end = text.indexOf('\n\n');
    }
    _buffer
      ..clear()
      ..write(text);
    return events;
  }
}
