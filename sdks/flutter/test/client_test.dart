import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:notato/src/client.dart';

/// A server that takes the request and never answers, or answers and then says nothing. Closing the client ends what
/// it was doing, as a real client's does.
class SilentClient extends http.BaseClient {
  SilentClient({this.headers = false});

  /// Answers with a 200 and a stream that stays open, rather than not answering at all.
  final bool headers;
  final _answer = Completer<http.StreamedResponse>();
  final _body = StreamController<List<int>>();
  var closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (headers) _answer.complete(http.StreamedResponse(_body.stream, 200));
    return _answer.future;
  }

  @override
  void close() {
    closed = true;
    if (!_answer.isCompleted) _answer.completeError(http.ClientException('Client is already closed'));
    if (!_body.isClosed) {
      _body
        ..addError(http.ClientException('Connection closed while receiving data'))
        ..close();
    }
  }
}

void main() {
  test('reads every page of the list, without what the app never shows', () async {
    final urls = <String>[];
    final client = NotatoClient(
      server: 'http://localhost:4799',
      project: 'shop',
      newClient: () => MockClient((request) async {
        urls.add('${request.url}');
        final after = request.url.queryParameters['afterSeq'];
        return http.Response(
          jsonEncode(
            after == null
                ? {
                    'items': [
                      {
                        'seq': 1,
                        'annotation': {'id': 'a'},
                      },
                    ],
                    'next': 1,
                  }
                : {
                    'items': [
                      {
                        'seq': 2,
                        'annotation': {'id': 'b'},
                      },
                    ],
                  },
          ),
          200,
        );
      }),
    );
    final items = await client.list();
    expect([for (final i in items) (i['annotation'] as Map)['id']], ['a', 'b']);
    expect(urls, [
      'http://localhost:4799/projects/shop/annotations?limit=500&fields=summary',
      'http://localhost:4799/projects/shop/annotations?limit=500&fields=summary&afterSeq=1',
    ]);
  });

  test('throws rather than give a list cut short: a page that does not move on, or too many pages', () async {
    NotatoClient listing(Object? Function() next) => NotatoClient(
      server: 'http://localhost:4799',
      project: 'shop',
      newClient: () => MockClient((_) async => http.Response(jsonEncode({'items': const [], 'next': next()}), 200)),
    );
    await expectLater(
      listing(() => 7).list(),
      throwsA(isA<NotatoException>().having((e) => e.message, 'message', contains('did not move on'))),
    );
    var pages = 0;
    await expectLater(
      listing(() => ++pages).list(),
      throwsA(isA<NotatoException>().having((e) => e.message, 'message', contains('more notes than Notato reads'))),
    );
    expect(pages, NotatoClient.maxPages);
  });

  testWidgets('gives up on a request whose answer never starts, and closes it', (tester) async {
    final http = SilentClient();
    final client = NotatoClient(server: 'http://localhost:4799', project: 'shop', newClient: () => http);
    Object? error;
    unawaited(client.screenshots().then((_) {}, onError: (Object e) => error = e));
    await tester.pump(const Duration(seconds: 9));
    expect(error, isNull);
    await tester.pump(const Duration(seconds: 2));
    expect(
      error,
      isA<NotatoException>().having((e) => e.message, 'message', 'the Notato server did not answer in time'),
    );
    expect(http.closed, isTrue);
  });

  testWidgets('starts the event stream again when it says nothing for 45 seconds (the server pings every 15)', (
    tester,
  ) async {
    final states = <String>[];
    final made = <SilentClient>[];
    final follower = NotatoClient(
      server: 'http://localhost:4799',
      project: 'shop',
      newClient: () {
        final client = SilentClient(headers: true);
        made.add(client);
        return client;
      },
    ).follow((_) {}, (state, detail) => states.add(detail == null ? state.name : '${state.name}: $detail'));
    await tester.pump(const Duration(seconds: 44));
    expect(states, ['connecting']);
    await tester.pump(const Duration(milliseconds: 1500));
    expect(states, ['connecting', 'offline: The server stopped answering.']);
    expect(made.single.closed, isTrue);
    await tester.pump(const Duration(seconds: 1));
    expect(made, hasLength(2));
    follower.cancel();
  });

  testWidgets('gives up on an event stream that never answers at all, the same way', (tester) async {
    final states = <String>[];
    final follower = NotatoClient(
      server: 'http://localhost:4799',
      project: 'shop',
      newClient: SilentClient.new,
    ).follow((_) {}, (state, detail) => states.add(detail == null ? state.name : '${state.name}: $detail'));
    await tester.pump(const Duration(milliseconds: 45500));
    expect(states, ['connecting', 'offline: The server stopped answering.']);
    follower.cancel();
  });
}
