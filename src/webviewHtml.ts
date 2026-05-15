// Shared webview HTML generator.
// Reused by both the sidebar (WebviewViewProvider) and the board (WebviewPanel).

import * as vscode from "vscode";

export function getNonce(): string {
  // crypto.randomUUID() is available on VSCode's Node runtime (>=19) and is a
  // stronger source than Math.random for CSP nonces.
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

interface WebviewOpts {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  mode: "sidebar" | "board";
}

/**
 * Returns the HTML payload for a DoStuff webview.
 *
 * The webview is a self-contained React app under `media/`. esbuild emits
 * `media/index.js` and `media/styles.css` (see scripts/esbuild.config.ts).
 * CSP is locked to nonced inline scripts + same-origin assets.
 */
export function getWebviewHtml({ webview, extensionUri, mode }: WebviewOpts): string {
  const asset = (p: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", p));

  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset("styles.css")}" />
  <title>DoStuff</title>
</head>
<body data-mode="${mode}">
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__DOSTUFF_MODE__ = "${mode}";
    window.__VSCODE_API__ = acquireVsCodeApi();
  </script>
  <script nonce="${nonce}" src="${asset("index.js")}"></script>
</body>
</html>`;
}
