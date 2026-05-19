import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { extensionConfig, webviewConfig } from "./esbuild.config";

function copySqlJsWasm(): void {
  mkdirSync("./dist", { recursive: true });
  copyFileSync("./node_modules/sql.js/dist/sql-wasm.wasm", "./dist/sql-wasm.wasm");
}

Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)])
  .then(() => copySqlJsWasm())
  .catch(() => process.exit(1));
