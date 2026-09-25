// Builds the static GitHub Pages demo into ./demo-dist:
//   index.html + shell.js/.css — page chrome + the in-browser DemoHost
//   view.html + index.js/styles.css — the unmodified webview bundle, one
//     iframe per view (sidebar / board / graph)
// `bun run build:demo` builds; `bun run demo` builds and serves on :4173.
// .github/workflows/demo-pages.yml publishes the output to GitHub Pages.

import esbuild, { type Plugin } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { webviewConfig } from "./esbuild.config";

const OUT = "./demo-dist";

// The shared rules (issueRules → syncMerge) import `node:crypto`; the browser
// gets a small shim instead. A plugin rather than `alias` so the `node:`
// scheme resolves predictably.
const nodeCryptoShim: Plugin = {
  name: "node-crypto-shim",
  setup(build) {
    build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({
      path: resolve("./demo/cryptoShim.ts"),
    }));
  },
};

async function build(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await Promise.all([
    esbuild.build({ ...webviewConfig, outdir: OUT, sourcemap: false }),
    esbuild.build({
      entryPoints: ["./demo/shell.ts"],
      bundle: true,
      platform: "browser",
      target: ["es2020"],
      format: "iife",
      outfile: `${OUT}/shell.js`,
      plugins: [nodeCryptoShim],
      logLevel: "info",
      legalComments: "none",
      minify: true,
    }),
  ]);
  for (const f of ["index.html", "view.html", "shell.css", "theme.css"]) {
    copyFileSync(`./demo/${f}`, `${OUT}/${f}`);
  }
  copyFileSync("./media/dostuff-icon-sm.png", `${OUT}/favicon.png`);
}

async function serve(port: number): Promise<void> {
  const root = resolve(OUT);
  Bun.serve({
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = Bun.file(resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`));
      if (!file.name?.startsWith(root) || !(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file);
    },
  });
  console.log(`DoStuff demo: http://localhost:${port}/`);
}

await build().catch((e) => {
  console.error(e);
  process.exit(1);
});
if (process.argv.includes("--serve")) await serve(Number(process.env.PORT ?? 4173));
