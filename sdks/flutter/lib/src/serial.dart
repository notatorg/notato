/// Runs tasks one at a time, in the order they come, and says when the last of them is done. Screenshots are taken
/// this way: one that finishes first must not take the covers off what the next is photographing.
class Serial {
  Serial(this._idle);
  final void Function() _idle;
  Future<void> _tail = Future.value();
  var _waiting = 0;

  Future<T> run<T>(Future<T> Function() task) {
    _waiting++;
    final result = _tail.then((_) => task()).whenComplete(() {
      _waiting--;
      if (_waiting == 0) _idle();
    });
    _tail = result.then((_) {}, onError: (Object _) {});
    return result;
  }
}
