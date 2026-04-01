import * as assert from "assert";
import { StatusBarItem } from "../statusBarItem.js";
import * as vscode from "vscode";

describe("StatusBarItem", () => {
  let statusBar: StatusBarItem;

  beforeEach(() => {
    statusBar = new StatusBarItem();
  });

  afterEach(() => {
    statusBar.dispose();
  });

  it("should start in idle state", () => {
    // StatusBarItem constructor calls setIdle
    // Just verify it doesn't throw
    assert.ok(statusBar);
  });

  it("should set running state with cancel support", () => {
    const tokenSource = new vscode.CancellationTokenSource();
    statusBar.setRunning("Review", tokenSource);
    tokenSource.dispose();
  });

  it("should set done state", () => {
    statusBar.setDone("Review complete");
  });

  it("should set error state", () => {
    statusBar.setError("Something failed");
  });

  it("should cancel current run", () => {
    const tokenSource = new vscode.CancellationTokenSource();
    statusBar.setRunning("Review", tokenSource);

    let cancelled = false;
    tokenSource.token.onCancellationRequested(() => {
      cancelled = true;
    });

    statusBar.cancelCurrentRun();
    assert.strictEqual(cancelled, true);
    tokenSource.dispose();
  });

  it("should not throw when cancelling with no active run", () => {
    statusBar.cancelCurrentRun();
  });

  it("should clean up on dispose", () => {
    const tokenSource = new vscode.CancellationTokenSource();
    statusBar.setRunning("Test", tokenSource);
    statusBar.dispose();
    tokenSource.dispose();
  });
});
