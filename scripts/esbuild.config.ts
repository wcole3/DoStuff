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
  minify: true,
  treeShaking: true,
  legalComments: "none",
};

// Headless server bundle. Deliberately NO `external: ["vscode"]` — this build
// is the vscode-free guard for the core: if anything in serverMain's import
// graph (storageCore, mcpServer, mcpHost, syncMerge, …) picks up a `vscode`
// import, esbuild fails loudly right here instead of at headless runtime.
export const serverConfig: BuildOptions = {
  entryPoints: ["./src/serverMain.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "./dist/server.cjs",
  format: "cjs",
  loader: {
    ".ts": "ts",
    ".js": "js",
  },
  logLevel: "info",
  sourcemap: true,
  minify: true,
  treeShaking: true,
  legalComments: "none",
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
  minify: true,
  treeShaking: true,
};
