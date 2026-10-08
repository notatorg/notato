import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'annotation.dart';
import 'events.dart';

/// What went wrong talking to the server: its reason, and its status, or none when it could not be reached.
class NotatoException implements Exception {
  const NotatoException(this.message, [this.status]);
  final String message;
  final int? status;

  /// The server will not take this app as it is (a missing or wrong token, a project it cannot use): not a blip.
  bool get permanent => status != null && status! >= 400 && status! < 500 && status != 408 && status != 429;

  /// The server will never take this note as it is (malformed, too large, an id it has for another): it is marked
  /// failed and the notes after it are still sent. Anything else (401, 403, an unknown project's 404, 408, 429, 5xx, no
  /// answer) is about the server or the app rather than the note, and holds the queue for a later try.
  bool get refusesNote => const {400, 409, 413, 415, 422}.contains(status);

  @override
  String toString() => message;
}

/// How the event stream stands.
enum StreamState { connecting, connected, offline, refused }

/// The project on a Notato server, over its HTTP API (the same one every SDK uses).
class NotatoClient {
  NotatoClient({required String server, required this.project, this.token, http.Client Function()? newClient})
    : server = server.replaceAll(RegExp(r'/+$'), ''),
      _newClient = newClient ?? http.Client.new;

  final String server;
  final String project;
  final String? token;
  final http.Client Function() _newClient;

  Map<String, String> get _auth => {if (token != null) 'Authorization': 'Bearer $token'};
  String get _projectUrl => '$server/projects/${Uri.encodeComponent(project)}';
  static String _segment(String s) => Uri.encodeComponent(s);

  static Object? _decode(http.Response res) {
    Object? body;
    try {
      body = res.body.isEmpty ? null : jsonDecode(res.body);
    } on FormatException {
      body = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final error = body is Map ? body['error'] : null;
      throw NotatoException(error is String ? error : 'the server answered ${res.statusCode}', res.statusCode);
    }
    return body;
  }

  /// A request and its whole answer, within [timeout]: the wait for the answer to start counts as much as reading it.
  /// The client is closed when time runs out, so the request stops there.
  static Future<http.Response> _within(http.Client client, http.BaseRequest request, Duration timeout) {
    Future<http.Response> answer() async => http.Response.fromStream(await client.send(request));
    return answer().timeout(
      timeout,
      onTimeout: () {
        client.close();
        throw TimeoutException('the Notato server did not answer in time', timeout);
      },
    );
  }

  /// One request, with what the server answered decoded, or a [NotatoException].
  Future<Object?> _call(
    String method,
    String url, {
    Object? json,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final client = _newClient();
    try {
      final request = http.Request(method, Uri.parse(url))..headers.addAll(_auth);
      if (json != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(json);
      }
      return _decode(await _within(client, request, timeout));
    } on NotatoException {
      rethrow;
    } on TimeoutException {
      throw const NotatoException('the Notato server did not answer in time');
    } catch (error) {
      throw NotatoException('cannot reach the Notato server at $server ($error)');
    } finally {
      client.close();
    }
  }

  static Map<String, Object?> _map(Object? body) =>
      body is Map ? body.cast<String, Object?>() : throw const NotatoException('the server answered with nothing');

  /// Sends a note and its screenshots (`asset:<id>` files, as every SDK sends them). Returns it as the server stored it:
  /// `{seq, annotation}`.
  Future<Map<String, Object?>> send(Map<String, Object?> annotation, List<Shot> shots) async {
    final client = _newClient();
    try {
      final request = http.MultipartRequest('POST', Uri.parse('$_projectUrl/annotations'))
        ..headers.addAll(_auth)
        ..fields['annotation'] = jsonEncode(annotation);
      for (final shot in shots) {
        request.files.add(http.MultipartFile.fromBytes('asset:${shot.id}', shot.bytes, filename: '${shot.id}.png'));
      }
      return _map(_decode(await _within(client, request, const Duration(seconds: 60))));
    } on NotatoException {
      rethrow;
    } on TimeoutException {
      throw const NotatoException('the Notato server did not answer in time');
    } catch (error) {
      throw NotatoException('cannot reach the Notato server at $server ($error)');
    } finally {
      client.close();
    }
  }

  /// The most pages [list] reads: 100,000 notes.
  static const maxPages = 200;

  /// Every note of the project, oldest first, as `{seq, annotation}`, a page at a time, without what the app never shows
  /// (a note's context and an agent's steps: `fields=summary`, which older servers ignore). Throws when a page does not
  /// come, or the list cannot be read to its end (too many pages, or a server whose pages do not move on): a list cut
  /// short would look like deletions.
  Future<List<Map<String, Object?>>> list() async {
    final all = <Map<String, Object?>>[];
    int? after;
    for (var page = 0; page < maxPages; page++) {
      final body = _map(
        await _call(
          'GET',
          '$_projectUrl/annotations?limit=500&fields=summary${after == null ? '' : '&afterSeq=$after'}',
        ),
      );
      final items = body['items'];
      if (items is List) all.addAll(items.whereType<Map>().map((m) => m.cast<String, Object?>()));
      final next = body['next'];
      if (next == null) return all;
      if (next is! int || (after != null && next <= after)) {
        throw const NotatoException("the server's list of notes did not move on from one page to the next");
      }
      after = next;
    }
    throw const NotatoException('the project has more notes than Notato reads ($maxPages pages)');
  }

  Future<Map<String, Object?>> reply(String id, String body, Map<String, Object?> author, {bool aside = false}) async =>
      _map(
        await _call(
          'POST',
          '$server/annotations/${_segment(id)}/replies',
          json: {'body': body, 'author': author, if (aside) 'aside': true},
        ),
      );

  Future<Map<String, Object?>> setStatus(String id, String status, String note, Map<String, Object?> author) async =>
      _map(
        await _call(
          'PATCH',
          '$server/annotations/${_segment(id)}',
          json: {'status': status, 'note': note, 'author': author},
        ),
      );

  Future<Map<String, Object?>> setPeopleOnly(String id, bool on, Map<String, Object?> author) async =>
      _map(await _call('PATCH', '$server/annotations/${_segment(id)}', json: {'peopleOnly': on, 'author': author}));

  Future<void> delete(String id) => _call('DELETE', '$server/annotations/${_segment(id)}');

  /// Agent mode: what became of a relayed `notato_annotate`.
  Future<void> relayResult(String requestId, Map<String, Object?> result) =>
      _call('POST', '$server/relay/${_segment(requestId)}/result', json: result);

  /// What the server says before anything is captured: whether it takes screenshots.
  Future<bool?> screenshots() async {
    final body = await _call(
      'GET',
      '$server/config?project=${_segment(project)}',
      timeout: const Duration(seconds: 10),
    );
    final value = body is Map ? body['screenshots'] : null;
    return value is bool ? value : null;
  }

  /// Test mode: a package of notes, as the bundle zip `notato_import_bundle` reads.
  Future<void> uploadBundle(List<int> zip) async {
    final client = _newClient();
    try {
      final request = http.Request('POST', Uri.parse('$_projectUrl/bundles'))
        ..headers.addAll({..._auth, 'Content-Type': 'application/zip'})
        ..bodyBytes = zip;
      _decode(await _within(client, request, const Duration(seconds: 120)));
    } on NotatoException {
      rethrow;
    } on TimeoutException {
      throw const NotatoException('the Notato server did not answer in time');
    } catch (error) {
      throw NotatoException('cannot reach the Notato server at $server ($error)');
    } finally {
      client.close();
    }
  }

  /// Follows the project's events (`/projects/:id/events`, with [agent] its relayed annotate requests too): notes made,
  /// changed, replied to and deleted, and whether an agent is there. Reconnects when the stream drops or goes quiet for
  /// [EventFollower.idle]: after a second, then longer, up to 15, and 10 seconds after the server refuses the app.
  /// Cancel the result to stop.
  EventFollower follow(
    void Function(ServerEvent event) onEvent,
    void Function(StreamState state, String? detail) onState, {
    bool agent = false,
  }) => EventFollower._(this, onEvent, onState, agent).._open();
}

class EventFollower {
  EventFollower._(this._client, this._onEvent, this._onState, this._agent);

  /// The server says something at least every 15 seconds: a stream silent for this long has gone without saying so.
  static const idle = Duration(seconds: 45);

  final NotatoClient _client;
  final void Function(ServerEvent) _onEvent;
  final void Function(StreamState, String?) _onState;
  final bool _agent;
  http.Client? _http;
  Timer? _retry;
  Timer? _idle;
  var _wait = const Duration(seconds: 1);
  var _stopped = false;
  var _generation = 0;

  Future<void> _open() async {
    if (_stopped) return;
    final generation = ++_generation;
    _onState(StreamState.connecting, null);
    final connection = _http = _client._newClient();
    var refused = false;
    var quiet = false;
    String? detail;
    // Watched from the start, and again at every chunk: a server that never answers is as quiet as one that stopped.
    // Closing the client ends the stream, and the reconnecting below follows.
    void watch() {
      _idle?.cancel();
      _idle = Timer(idle, () {
        if (generation != _generation) return;
        quiet = true;
        connection.close();
      });
    }

    watch();
    try {
      final request = http.Request('GET', Uri.parse('${_client._projectUrl}/events${_agent ? '?agent=1' : ''}'))
        ..headers.addAll({..._client._auth, 'Accept': 'text/event-stream'});
      final res = await connection.send(request);
      if (res.statusCode == 200) {
        _wait = const Duration(seconds: 1);
        final parser = EventParser();
        await for (final chunk in res.stream.transform(utf8.decoder)) {
          if (_stopped || generation != _generation || quiet) break;
          watch();
          parser.add(chunk).forEach(_onEvent);
        }
        detail = quiet ? 'The server stopped answering.' : 'The server closed the connection.';
      } else {
        final body = await res.stream.bytesToString().timeout(const Duration(seconds: 5), onTimeout: () => '');
        try {
          NotatoClient._decode(http.Response(body, res.statusCode));
        } on NotatoException catch (error) {
          refused = error.permanent;
          detail = error.message;
        }
      }
    } catch (error) {
      detail = quiet ? 'The server stopped answering.' : 'cannot reach the Notato server at ${_client.server}';
    } finally {
      if (generation == _generation) _idle?.cancel();
      connection.close();
    }
    if (_stopped || generation != _generation) return;
    _onState(refused ? StreamState.refused : StreamState.offline, detail);
    _retry = Timer(refused ? const Duration(seconds: 10) : _wait, _open);
    if (!refused) _wait = Duration(milliseconds: min(_wait.inMilliseconds * 2, 15000));
  }

  /// Tries again now, instead of waiting out the pause (the menu's Retry).
  void retry() {
    if (_stopped) return;
    _retry?.cancel();
    _wait = const Duration(seconds: 1);
    _http?.close();
    _open();
  }

  void cancel() {
    _stopped = true;
    _retry?.cancel();
    _idle?.cancel();
    _http?.close();
  }
}
