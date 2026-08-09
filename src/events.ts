// Minimal typed event emitter — the vscode.EventEmitter shape the codebase
// actually uses (subscribe → Disposable, fire, dispose), without the vscode
// dependency, so core modules (storageCore, gitSync) can run headless. The
// VSCode adapters expose these events unchanged; `vscode.Disposable` is
// structurally identical to `Disposable` here.

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> {
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
    for (const l of [...this.listeners]) l(value);
  }

  dispose(): void {
    this.listeners = [];
  }
}
