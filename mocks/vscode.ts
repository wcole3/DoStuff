// Minimal stubs for the vscode API surface the extension code actually uses.
// Hand-rolled per test as needed; defaults are no-ops returning undefined.

export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export interface UriLike {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
  with(change: { scheme?: string; path?: string }): UriLike;
}

export type Uri = UriLike;

function makeUri(scheme: string, path: string): UriLike {
  return {
    scheme,
    path,
    fsPath: path,
    toString: () => `${scheme}://${path}`,
    with(change) {
      return makeUri(change.scheme ?? scheme, change.path ?? path);
    },
  };
}

export const Uri = {
  file(path: string): UriLike { return makeUri("file", path); },
  parse(value: string): UriLike {
    const colon = value.indexOf(":");
    const scheme = colon >= 0 ? value.slice(0, colon) : "file";
    const path = colon >= 0 ? value.slice(colon + 1).replace(/^\/+/, "/") : value;
    return makeUri(scheme, path);
  },
  joinPath(base: UriLike, ...segments: string[]): UriLike {
    const joined = [base.path.replace(/\/+$/, ""), ...segments].join("/");
    return makeUri(base.scheme, joined);
  },
};

export interface Webview {
  html: string;
  cspSource: string;
  asWebviewUri(uri: UriLike): UriLike;
  onDidReceiveMessage<T = unknown>(
    cb: (msg: T) => void,
    thisArg?: unknown,
    disposables?: Disposable[]
  ): Disposable;
  postMessage(msg: unknown): Thenable<boolean>;
  options: unknown;
}

export interface WebviewView {
  webview: Webview;
  visible: boolean;
  onDidChangeVisibility(cb: () => void, thisArg?: unknown, disposables?: Disposable[]): Disposable;
  onDidDispose(cb: () => void, thisArg?: unknown, disposables?: Disposable[]): Disposable;
  show?(preserveFocus?: boolean): void;
  title?: string;
  description?: string;
}

export interface WebviewPanel {
  webview: Webview;
  visible: boolean;
  active: boolean;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  onDidDispose(cb: () => void, thisArg?: unknown, disposables?: Disposable[]): Disposable;
  onDidChangeViewState(cb: (e: unknown) => void, thisArg?: unknown, disposables?: Disposable[]): Disposable;
  dispose(): void;
  title: string;
  iconPath?: UriLike | { light: UriLike; dark: UriLike };
}

export interface WebviewViewProvider {
  resolveWebviewView(
    view: WebviewView,
    ctx: WebviewViewResolveContext,
    token: CancellationToken
  ): void | Thenable<void>;
}

export interface WebviewViewResolveContext<TState = unknown> {
  state?: TState;
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(cb: (e: unknown) => void): Disposable;
}

export interface TextEditor {
  viewColumn?: number;
  document: { uri: UriLike };
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
} as const;

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}

export interface OutputChannel {
  name: string;
  appendLine(value: string): void;
  append(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

export interface StatusBarItem {
  alignment: number;
  priority?: number;
  text: string;
  tooltip?: string;
  command?: string;
  color?: string;
  backgroundColor?: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  update(section: string, value: unknown, target?: number | boolean): Thenable<void>;
  inspect<T>(section: string): { defaultValue?: T; globalValue?: T; workspaceValue?: T } | undefined;
  has(section: string): boolean;
}

export interface WorkspaceFolder {
  uri: UriLike;
  name: string;
  index: number;
}

export interface SecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}

export interface ExtensionContext {
  subscriptions: Disposable[];
  globalState: Memento;
  workspaceState: Memento;
  extensionUri: UriLike;
  globalStorageUri: UriLike;
  storageUri?: UriLike;
  extensionPath: string;
  secrets: SecretStorage;
  asAbsolutePath(relativePath: string): string;
}

export const commands = {
  registerCommand: (..._args: unknown[]): Disposable => ({ dispose() {} }),
  executeCommand: <T = unknown>(..._args: unknown[]): Thenable<T | undefined> => Promise.resolve(undefined),
};

export const window: {
  activeTextEditor: TextEditor | undefined;
  showInformationMessage: (..._args: unknown[]) => Promise<string | undefined>;
  showWarningMessage: (..._args: unknown[]) => Promise<string | undefined>;
  showErrorMessage: (..._args: unknown[]) => Promise<string | undefined>;
  showInputBox: (..._args: unknown[]) => Promise<string | undefined>;
  showQuickPick: <T extends QuickPickItem | string>(
    items: readonly T[] | Thenable<readonly T[]>,
    options?: unknown
  ) => Promise<T | undefined>;
  showOpenDialog: (..._args: unknown[]) => Promise<UriLike[] | undefined>;
  showSaveDialog: (..._args: unknown[]) => Promise<UriLike | undefined>;
  createOutputChannel: (name: string) => OutputChannel;
  createStatusBarItem: (..._args: unknown[]) => StatusBarItem;
  registerWebviewViewProvider: (..._args: unknown[]) => Disposable;
  createWebviewPanel: (..._args: unknown[]) => WebviewPanel;
  withProgress: (
    _options: unknown,
    task: (progress: unknown, token: unknown) => Thenable<unknown>
  ) => Thenable<unknown>;
} = {
  activeTextEditor: undefined,
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showInputBox: (..._args: unknown[]) => Promise.resolve(undefined),
  showQuickPick: (<T extends QuickPickItem | string>(_items: unknown, _options?: unknown) =>
    Promise.resolve<T | undefined>(undefined)) as (<T extends QuickPickItem | string>(
    items: readonly T[] | Thenable<readonly T[]>,
    options?: unknown
  ) => Promise<T | undefined>),
  showOpenDialog: (..._args: unknown[]) => Promise.resolve(undefined),
  showSaveDialog: (..._args: unknown[]) => Promise.resolve(undefined),
  createOutputChannel: (name: string): OutputChannel => ({
    name,
    appendLine() {},
    append() {},
    clear() {},
    show() {},
    hide() {},
    dispose() {},
  }),
  createStatusBarItem: (..._args: unknown[]): StatusBarItem => ({
    alignment: StatusBarAlignment.Left,
    text: "",
    show() {},
    hide() {},
    dispose() {},
  }),
  registerWebviewViewProvider: (..._args: unknown[]): Disposable => ({ dispose() {} }),
  createWebviewPanel: (..._args: unknown[]): WebviewPanel => {
    throw new Error("createWebviewPanel: not stubbed; provide a hand-rolled mock in tests");
  },
  withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => Thenable<unknown>) =>
    task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
};

export const workspace = {
  workspaceFolders: undefined as WorkspaceFolder[] | undefined,
  name: undefined as string | undefined,
  getConfiguration: (_section?: string, _scope?: unknown): WorkspaceConfiguration => ({
    get: (<T>(_key: string, defaultValue?: T) => defaultValue) as WorkspaceConfiguration["get"],
    update: (..._args: unknown[]) => Promise.resolve(),
    inspect: () => undefined,
    has: () => false,
  }),
  onDidChangeConfiguration: (_cb: (e: ConfigurationChangeEvent) => unknown): Disposable => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: (_cb: (e: unknown) => unknown): Disposable => ({ dispose() {} }),
  fs: {
    readFile: (_uri: UriLike): Thenable<Uint8Array> => Promise.resolve(new Uint8Array()),
    writeFile: (_uri: UriLike, _content: Uint8Array): Thenable<void> => Promise.resolve(),
    createDirectory: (_uri: UriLike): Thenable<void> => Promise.resolve(),
    delete: (_uri: UriLike, _options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void> => Promise.resolve(),
    stat: (_uri: UriLike): Thenable<{ type: number; ctime: number; mtime: number; size: number }> =>
      Promise.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: (_uri: UriLike): Thenable<Array<[string, FileType]>> => Promise.resolve([]),
  },
  openTextDocument: (..._args: unknown[]) => Promise.resolve(undefined),
};

interface Thenable<T> extends PromiseLike<T> {}
