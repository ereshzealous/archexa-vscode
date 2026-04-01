import * as vscode from "vscode";

const DONE_RESET_MS = 4000;
const ERROR_RESET_MS = 6000;

export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelCommand: vscode.Disposable | undefined;
  private activeTokenSource: vscode.CancellationTokenSource | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.clearTimer();
    this.clearCancelCommand();
    this.item.text = "$(bracket) Archexa";
    this.item.tooltip = "Archexa — click to open sidebar";
    this.item.command = "workbench.view.extension.archexa-sidebar";
    this.item.backgroundColor = undefined;
  }

  setRunning(
    label: string,
    tokenSource: vscode.CancellationTokenSource
  ): void {
    this.clearTimer();
    this.clearCancelCommand();

    this.activeTokenSource = tokenSource;
    const cmdId = `archexa.cancelRun.${Date.now()}`;
    this.cancelCommand = vscode.commands.registerCommand(cmdId, () => {
      this.cancelCurrentRun();
    });

    this.item.text = `$(sync~spin) Archexa: ${label}...`;
    this.item.tooltip = "Click to cancel";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.item.command = cmdId;
  }

  cancelCurrentRun(): void {
    if (this.activeTokenSource) {
      this.item.text = "$(close) Archexa: Cancelling...";
      this.item.tooltip = "Stopping process...";
      this.item.command = undefined;
      this.activeTokenSource.cancel();
      this.activeTokenSource = undefined;
    }
  }

  setDone(summary: string): void {
    this.activeTokenSource = undefined;
    this.clearTimer();
    this.clearCancelCommand();
    this.item.text = `$(check) Archexa: ${summary}`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.prominentBackground"
    );
    this.item.command = "workbench.view.extension.archexa-sidebar";
    this.item.tooltip = summary;
    this.resetTimer = setTimeout(() => this.setIdle(), DONE_RESET_MS);
  }

  setError(message: string): void {
    this.activeTokenSource = undefined;
    this.clearTimer();
    this.clearCancelCommand();
    this.item.text = "$(error) Archexa: failed";
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.item.command = "workbench.view.extension.archexa-sidebar";
    this.resetTimer = setTimeout(() => this.setIdle(), ERROR_RESET_MS);
  }

  dispose(): void {
    this.clearTimer();
    this.clearCancelCommand();
    this.item.dispose();
  }

  private clearTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  private clearCancelCommand(): void {
    this.cancelCommand?.dispose();
    this.cancelCommand = undefined;
  }
}
