/**
 * Lightweight VS Code API mock for unit testing.
 * Only stubs the APIs actually used by the modules under test.
 */

const configStore: Record<string, unknown> = {};
let workspacePath = "/tmp/test-workspace";

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const val = configStore[key];
        return val !== undefined ? (val as T) : defaultValue;
      },
      update(key: string, value: unknown) {
        configStore[key] = value;
        return Promise.resolve();
      },
    };
  },
  get workspaceFolders() {
    return [{ uri: { fsPath: workspacePath }, name: "test-workspace" }];
  },
  findFiles: () => Promise.resolve([]),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createStatusBarItem: () => ({
    show: () => {},
    hide: () => {},
    dispose: () => {},
    text: "",
    tooltip: "",
    command: "",
    backgroundColor: undefined,
  }),
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  activeTextEditor: undefined,
  registerWebviewViewProvider: () => ({ dispose: () => {} }),
};

export const languages = {
  createDiagnosticCollection: () => ({
    set: () => {},
    get: () => [],
    delete: () => {},
    clear: () => {},
    dispose: () => {},
  }),
};

export const commands = {
  registerCommand: (_id: string, _cb: Function) => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity?: DiagnosticSeverity
  ) {}
}

export class Range {
  constructor(
    public startLine: number,
    public startChar: number,
    public endLine: number,
    public endChar: number
  ) {}
}

export class Uri {
  static file(path: string) {
    return { fsPath: path, scheme: "file" };
  }
  static joinPath(base: { fsPath: string }, ...segments: string[]) {
    return { fsPath: [base.fsPath, ...segments].join("/") };
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class CancellationTokenSource {
  private _cancelled = false;
  private _listeners: (() => void)[] = [];

  get token() {
    const self = this;
    return {
      get isCancellationRequested() { return self._cancelled; },
      onCancellationRequested(fn: () => void) {
        self._listeners.push(fn);
        return { dispose: () => {} };
      },
    };
  }

  cancel() {
    this._cancelled = true;
    this._listeners.forEach((fn) => fn());
  }

  dispose() {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const env = {
  clipboard: {
    readText: () => Promise.resolve(""),
    writeText: () => Promise.resolve(),
  },
};

/** Reset config store between tests */
export function _resetConfigStore(): void {
  for (const key of Object.keys(configStore)) {
    delete configStore[key];
  }
}

/** Set mock workspace path */
export function _setWorkspacePath(p: string): void {
  workspacePath = p;
}
