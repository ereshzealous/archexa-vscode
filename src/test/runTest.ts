/**
 * Entry point for running tests with @vscode/test-electron.
 * This launches a VS Code instance with the extension loaded and runs tests inside it.
 */
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./index");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-extensions"],
  });
}

main().catch((err) => {
  console.error("Failed to run tests:", err);
  process.exit(1);
});
