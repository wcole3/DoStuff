import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { extensionConfig, serverConfig, webviewConfig } from "./esbuild.config";

mkdirSync("./dist", { recursive: true });
copyFileSync("./node_modules/sql.js/dist/sql-wasm.wasm", "./dist/sql-wasm.wasm");

const ctxA = await esbuild.context(extensionConfig);
const ctxB = await esbuild.context(webviewConfig);
const ctxC = await esbuild.context(serverConfig);
await Promise.all([ctxA.watch(), ctxB.watch(), ctxC.watch()]);
