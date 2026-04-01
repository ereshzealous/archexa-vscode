/**
 * Test runner entry point.
 * Discovers and runs all *.test.ts files in this directory.
 */
import * as path from "path";
import Mocha from "mocha";
import * as fs from "fs";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 10000,
  });

  const testsDir = __dirname;
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith(".test.js"));

  for (const file of files) {
    mocha.addFile(path.join(testsDir, file));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
