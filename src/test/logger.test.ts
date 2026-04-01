import * as assert from "assert";
import { Logger } from "../utils/logger.js";

describe("Logger", () => {
  let logger: Logger;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    logger = new Logger("Test");
    // Override the output channel to capture lines
    const channel = (logger as unknown as { channel: { appendLine: (s: string) => void } }).channel;
    channel.appendLine = (s: string) => lines.push(s);
  });

  it("should log INFO messages", () => {
    logger.info("hello");
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("[INFO]"));
    assert.ok(lines[0].includes("hello"));
  });

  it("should log WARN messages", () => {
    logger.warn("caution");
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("[WARN]"));
    assert.ok(lines[0].includes("caution"));
  });

  it("should log ERROR messages", () => {
    logger.error("failure");
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("[ERROR]"));
    assert.ok(lines[0].includes("failure"));
  });

  it("should include ISO timestamp", () => {
    logger.info("timestamped");
    // ISO format: YYYY-MM-DDTHH:mm:ss
    assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lines[0]));
  });

  it("should suppress DEBUG when logLevel is not DEBUG", () => {
    logger.debug("hidden");
    assert.strictEqual(lines.length, 0);
  });
});
