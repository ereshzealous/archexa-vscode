/**
 * Test setup: make require("vscode") return the mock module.
 * Uses Node's Module._cache to inject the mock before tests load.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const mockVscode = require("./mock-vscode.js");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};
