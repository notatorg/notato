/// Notato for Flutter: people pin notes to the widgets of your running app, and your coding agent gets them over MCP
/// with a screenshot and the file and line each widget is written at.
library;

export 'src/client.dart' show NotatoException;
export 'src/config.dart' show NotatoMode, NotatoPosition;
export 'src/controller.dart' show NoteRecord, NotatoConnection, NotatoController, notato;
export 'src/mask.dart' show NotatoMask;
export 'src/notato.dart' show Notato, NotatoRouteObserver;
export 'src/storage.dart' show LocalNote, NotatoStorage, NotatoStorageFactory;
export 'src/storage_memory.dart' show MemoryStorage;
export 'src/version.dart' show notatoSdkName, notatoSdkVersion;
