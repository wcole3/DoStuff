import esbuild from "esbuild";
import { extensionConfig, webviewConfig } from "./esbuild.config";

const ctxA = await esbuild.context(extensionConfig);
const ctxB = await esbuild.context(webviewConfig);
await Promise.all([ctxA.watch(), ctxB.watch()]);
