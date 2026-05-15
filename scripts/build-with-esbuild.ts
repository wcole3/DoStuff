import esbuild from "esbuild";
import { extensionConfig, webviewConfig } from "./esbuild.config";

Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]).catch(() => process.exit(1));
