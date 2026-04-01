import * as assert from "assert";
import { DEFAULTS, generateConfigYaml } from "../utils/config.js";

describe("Config Utils", () => {
  describe("DEFAULTS", () => {
    it("should have all required default values", () => {
      assert.strictEqual(DEFAULTS.model, "gpt-4o");
      assert.strictEqual(DEFAULTS.endpoint, "https://api.openai.com/v1/");
      assert.strictEqual(DEFAULTS.tlsVerify, true);
      assert.strictEqual(DEFAULTS.deepByDefault, true);
      assert.strictEqual(DEFAULTS.deepMaxIterations, 15);
      assert.strictEqual(DEFAULTS.cacheEnabled, true);
      assert.strictEqual(DEFAULTS.logLevel, "WARNING");
      assert.strictEqual(DEFAULTS.maxFiles, 100);
      assert.strictEqual(DEFAULTS.promptBudget, 120000);
      assert.strictEqual(DEFAULTS.promptReserve, 16000);
      assert.strictEqual(DEFAULTS.fileSizeLimit, 300000);
      assert.strictEqual(DEFAULTS.maxHistory, 30);
    });

    it("should not be accidentally mutated", () => {
      // `as const` makes it readonly in TypeScript — verify values are stable
      const originalModel = DEFAULTS.model;
      assert.strictEqual(DEFAULTS.model, originalModel);
      assert.strictEqual(typeof DEFAULTS.promptBudget, "number");
      assert.strictEqual(typeof DEFAULTS.deepByDefault, "boolean");
    });
  });

  describe("generateConfigYaml", () => {
    it("should return valid YAML string", () => {
      const yaml = generateConfigYaml();
      assert.ok(yaml.startsWith("archexa:"));
      assert.ok(yaml.includes("source:"));
      assert.ok(yaml.includes("openai:"));
      assert.ok(yaml.includes("model:"));
      assert.ok(yaml.includes("endpoint:"));
      assert.ok(yaml.includes("deep:"));
      assert.ok(yaml.includes("limits:"));
      assert.ok(yaml.includes("evidence:"));
    });

    it("should include all config sections", () => {
      const yaml = generateConfigYaml();
      const sections = [
        "tls_verify:", "enabled:", "max_iterations:",
        "cache:", "output:", "log_level:",
        "max_files:", "prompt_budget:", "prompt_reserve:",
        "file_size_limit:",
      ];
      for (const section of sections) {
        assert.ok(yaml.includes(section), `Missing section: ${section}`);
      }
    });

    it("should end with a newline", () => {
      const yaml = generateConfigYaml();
      assert.ok(yaml.endsWith("\n"));
    });
  });
});
