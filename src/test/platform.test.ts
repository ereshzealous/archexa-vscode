import * as assert from "assert";
import { PLATFORM_KEY, BINARY_NAME } from "../utils/platform.js";

describe("Platform Utils", () => {
  describe("PLATFORM_KEY", () => {
    it("should be a valid platform-arch string", () => {
      assert.ok(PLATFORM_KEY.includes("-"), "Should contain a hyphen");
      const [platform, arch] = PLATFORM_KEY.split("-");
      assert.ok(
        ["darwin", "linux", "win32"].includes(platform),
        `Unknown platform: ${platform}`
      );
      assert.ok(
        ["arm64", "x64", "x86_64"].includes(arch),
        `Unknown arch: ${arch}`
      );
    });
  });

  describe("BINARY_NAME", () => {
    it("should be 'archexa' on unix or 'archexa.exe' on windows", () => {
      if (process.platform === "win32") {
        assert.strictEqual(BINARY_NAME, "archexa.exe");
      } else {
        assert.strictEqual(BINARY_NAME, "archexa");
      }
    });
  });
});
