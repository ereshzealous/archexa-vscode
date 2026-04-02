import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { Logger } from "./utils/logger.js";
import { PLATFORM_KEY, BINARY_NAME } from "./utils/platform.js";

const GITHUB_OWNER = "ereshzealous";
const GITHUB_REPO = "archexa";

/** Lightweight version manifest — checked instead of full GitHub Releases API */
const VERSION_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/version.json`;

interface VersionManifest {
  latest: string;
  minimum: string;
  changelog: string;
  message: string;
}

const PLATFORM_ASSET: Record<string, string> = {
  "darwin-arm64":  "archexa-macos-arm64",
  "darwin-x64":    "archexa-macos-x86_64",
  "linux-x64":     "archexa-linux-x86_64",
  "linux-arm64":   "archexa-linux-arm64",
  "win32-x64":     "archexa-windows-x86_64.exe",
};

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    size: number;
    browser_download_url: string;
  }>;
}

export interface DownloadProgress {
  step: string;
  pct: number;
  termLine: string;
}

export class BinaryManager {
  private readonly binDir: string;
  private readonly destPath: string;
  private readonly versionFile: string;
  private onProgress?: (p: DownloadProgress) => void;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.binDir = path.join(ctx.globalStorageUri.fsPath, "bin");
    this.destPath = path.join(this.binDir, BINARY_NAME);
    this.versionFile = path.join(this.binDir, "version.txt");
  }

  setProgressCallback(cb: (p: DownloadProgress) => void): void {
    this.onProgress = cb;
  }

  async ensureBinary(): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("archexa");

    // 1. User override
    const userPath = cfg.get<string>("binaryPath", "");
    if (userPath && fs.existsSync(userPath)) {
      this.logger.info(`Using user-configured binary: ${userPath}`);
      void this.checkForUpdateSilently().catch(() => {});
      return userPath;
    }

    // 2. Previously downloaded
    if (fs.existsSync(this.destPath)) {
      this.logger.info(`Using cached binary: ${this.destPath}`);
      void this.checkForUpdateSilently().catch(() => {});
      return this.destPath;
    }

    // 3. Nothing found — need to download
    throw new Error("No Archexa binary found. First-time setup required.");
  }

  async downloadLatest(): Promise<string> {
    const asset = PLATFORM_ASSET[PLATFORM_KEY];
    if (!asset) {
      throw new Error(
        `No Archexa bundle for ${PLATFORM_KEY}. Visit https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
      );
    }

    this.emitProgress("Detecting platform", 0, `-> Platform: ${PLATFORM_KEY}`);

    // Fetch release info
    this.emitProgress(
      "Fetching release info",
      5,
      `-> Contacting api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    );
    const release = await this.fetchLatestRelease();
    const tag = release.tag_name;
    const releaseAsset = release.assets.find((a) => a.name === asset);

    if (!releaseAsset) {
      throw new Error(
        `Asset "${asset}" not found in release ${tag}. Available: ${release.assets.map((a) => a.name).join(", ")}`
      );
    }

    const sizeMB = (releaseAsset.size / (1024 * 1024)).toFixed(1);
    this.emitProgress(
      "Fetching release info",
      10,
      `-> Found: ${tag} (${asset}, ${sizeMB} MB)`
    );

    // Ensure bin dir
    fs.mkdirSync(this.binDir, { recursive: true });
    const tmpPath = this.destPath + ".tmp";

    // Download
    this.emitProgress(
      "Downloading bundle",
      15,
      `-> Downloading from github.com (redirecting to CDN)...`
    );

    await this.downloadFile(
      releaseAsset.browser_download_url,
      tmpPath,
      releaseAsset.size
    );

    this.emitProgress(
      "Downloading bundle",
      75,
      `-> Download complete (${sizeMB} MB)`
    );

    // Verify
    this.emitProgress("Verifying integrity", 80, `-> Verifying download...`);
    const stat = fs.statSync(tmpPath);
    if (stat.size < 1024 * 1024) {
      fs.unlinkSync(tmpPath);
      throw new Error(
        `Downloaded file too small (${stat.size} bytes). Download may have failed.`
      );
    }

    // Atomic rename
    this.emitProgress(
      "Installing to extension dir",
      85,
      `-> Moving to: ${this.destPath}`
    );
    fs.renameSync(tmpPath, this.destPath);

    // chmod on unix
    if (process.platform !== "win32") {
      fs.chmodSync(this.destPath, 0o755);
      this.emitProgress(
        "Installing to extension dir",
        88,
        `-> chmod +x (setting execute permissions)`
      );
    }

    // Write version
    this.emitProgress(
      "Installing to extension dir",
      90,
      `-> Writing version cache: ${this.versionFile}`
    );
    fs.writeFileSync(this.versionFile, tag, "utf8");

    // Update settings
    const config = vscode.workspace.getConfiguration("archexa");
    await config.update("binaryPath", this.destPath, vscode.ConfigurationTarget.Global);
    await config.update("binaryVersion", tag, vscode.ConfigurationTarget.Global);
    this.ctx.globalState.update("archexa.resolvedBinaryPath", this.destPath);

    this.emitProgress("Ready", 100, `-> Archexa ${tag} is ready`);
    this.logger.info(`Archexa ${tag} installed at ${this.destPath}`);

    return this.destPath;
  }

  async downloadLatestWithNotification(): Promise<string> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Archexa: Installing...",
        cancellable: false,
      },
      async (progress) => {
        this.setProgressCallback((p) => {
          progress.report({ message: p.step, increment: p.pct });
        });
        return this.downloadLatest();
      }
    );
  }

  async checkForUpdateSilently(): Promise<void> {
    try {
      const manifest = await this.fetchVersionManifest();
      const current = this.normalizeVersion(this.readCachedVersion());

      if (!current) return;

      const latest = this.normalizeVersion(manifest.latest);
      const minimum = this.normalizeVersion(manifest.minimum);

      // Force update if below minimum version
      if (minimum && this.isOlderThan(current, minimum)) {
        const choice = await vscode.window.showWarningMessage(
          `Archexa ${manifest.latest} is required (you have ${current}). Your version is no longer supported.`,
          { modal: true },
          "Update Now"
        );
        if (choice === "Update Now") {
          await this.downloadLatestWithNotification();
        }
        return;
      }

      // Suggest update if newer version available
      if (latest && this.isOlderThan(current, latest)) {
        const msg = manifest.message
          ? `Archexa ${manifest.latest} available: ${manifest.message}`
          : `Archexa ${manifest.latest} available (you have ${current})`;

        const actions = manifest.changelog
          ? ["Update Now", "Changelog", "Later"]
          : ["Update Now", "Later"];

        const choice = await vscode.window.showInformationMessage(msg, ...actions);

        if (choice === "Update Now") {
          await this.downloadLatestWithNotification();
        } else if (choice === "Changelog" && manifest.changelog) {
          void vscode.env.openExternal(vscode.Uri.parse(manifest.changelog));
        }
      }
    } catch {
      this.logger.debug("Update check failed (network unavailable)");
    }
  }

  private async fetchVersionManifest(): Promise<VersionManifest> {
    const body = await this.httpsGet(VERSION_URL, {
      "User-Agent": "archexa-vscode",
      "Cache-Control": "no-cache",
    });
    return JSON.parse(body) as VersionManifest;
  }

  /** Strip 'v' prefix and '-beta'/'-alpha' suffixes for comparison */
  private normalizeVersion(v: string): string {
    return v.replace(/^v/, "").replace(/-(beta|alpha)\.\d+$/, "").replace(/-(beta|alpha)$/, "");
  }

  /** True if version a is strictly older than version b (semver major.minor.patch) */
  private isOlderThan(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va < vb) return true;
      if (va > vb) return false;
    }
    return false;
  }

  async forceUpdate(): Promise<void> {
    await this.downloadLatestWithNotification();
  }

  getInstallPath(): string {
    return this.destPath;
  }

  getAssetName(): string {
    return PLATFORM_ASSET[PLATFORM_KEY] ?? "unknown";
  }

  getPlatformLabel(): string {
    const labels: Record<string, string> = {
      "darwin-arm64": "macOS (Apple Silicon)",
      "darwin-x64": "macOS (Intel)",
      "linux-x64": "Linux (x86_64)",
      "win32-x64": "Windows (x64)",
    };
    return labels[PLATFORM_KEY] ?? PLATFORM_KEY;
  }

  getPlatformIcon(): string {
    if (process.platform === "darwin") return "🍎";
    if (process.platform === "linux") return "🐧";
    return "🪟";
  }

  readCachedVersion(): string {
    try {
      return fs.readFileSync(this.versionFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  private emitProgress(step: string, pct: number, termLine: string): void {
    this.logger.debug(`[${pct}%] ${step}: ${termLine}`);
    this.onProgress?.({ step, pct, termLine });
  }

  private async fetchLatestRelease(): Promise<GitHubRelease> {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const body = await this.httpsGet(url, {
      "User-Agent": "archexa-vscode",
      Accept: "application/vnd.github+json",
    });
    return JSON.parse(body) as GitHubRelease;
  }

  private async downloadFile(
    url: string,
    dest: string,
    expectedSize: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const request = (downloadUrl: string, redirects: number): void => {
        if (redirects > 5) {
          file.close();
          reject(new Error("Too many redirects"));
          return;
        }
        const parsedUrl = new URL(downloadUrl);
        const mod = parsedUrl.protocol === "https:" ? https : http;
        mod
          .get(
            downloadUrl,
            { headers: { "User-Agent": "archexa-vscode" } },
            (res) => {
              if (
                res.statusCode &&
                [301, 302, 303, 307, 308].includes(res.statusCode) &&
                res.headers.location
              ) {
                res.resume();
                request(res.headers.location, redirects + 1);
                return;
              }
              if (res.statusCode && res.statusCode >= 400) {
                file.close();
                reject(
                  new Error(`HTTP ${res.statusCode} downloading ${downloadUrl}`)
                );
                return;
              }

              let received = 0;
              res.on("data", (chunk: Buffer) => {
                received += chunk.length;
                file.write(chunk);
                if (expectedSize > 0) {
                  const pct = Math.min(
                    75,
                    15 + Math.round((received / expectedSize) * 60)
                  );
                  this.emitProgress(
                    "Downloading bundle",
                    pct,
                    `-> ${((received / 1024 / 1024)).toFixed(1)} / ${((expectedSize / 1024 / 1024)).toFixed(1)} MB`
                  );
                }
              });
              res.on("end", () => {
                file.end(() => resolve());
              });
              res.on("error", (err) => {
                file.close();
                reject(err);
              });
            }
          )
          .on("error", (err) => {
            file.close();
            reject(err);
          });
      };
      request(url, 0);
    });
  }

  private async httpsGet(
    url: string,
    headers: Record<string, string>
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = (
        requestUrl: string,
        redirectCount: number
      ): void => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"));
          return;
        }
        https
          .get(requestUrl, { headers }, (res) => {
            if (
              res.statusCode &&
              [301, 302, 303, 307, 308].includes(res.statusCode) &&
              res.headers.location
            ) {
              res.resume();
              request(res.headers.location, redirectCount + 1);
              return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8"))
            );
            res.on("error", reject);
          })
          .on("error", reject);
      };
      request(url, 0);
    });
  }
}
