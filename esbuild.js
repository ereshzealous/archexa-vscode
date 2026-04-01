const esbuild = require("esbuild");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  esbuild
    .context(opts)
    .then((ctx) => {
      ctx.watch();
      console.log("Watching...");
    });
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
