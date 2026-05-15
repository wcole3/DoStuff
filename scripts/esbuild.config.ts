// webview build emits: media/index.js, media/styles.css (referenced by webviewHtml.ts)
import type { BuildOptions } from "esbuild";

export const extensionConfig: BuildOptions = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "./dist",
  outbase: "./src",
  outExtension: {
    ".js": ".cjs",
  },
  format: "cjs",
  external: ["vscode"],
  loader: {
    ".ts": "ts",
    ".js": "js",
  },
  logLevel: "info",
  sourcemap: true,
};

export const webviewConfig: BuildOptions = {
  entryPoints: ["./src/webview/index.tsx", "./src/webview/styles.css"],
  bundle: true,
  platform: "browser",
  target: ["es2020"],
  outdir: "./media",
  outbase: "./src/webview",
  format: "iife",
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
    ".svg": "file",
  },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
  sourcemap: "linked",
  legalComments: "none",
};
