# Webview assets

This folder holds the compiled React webview bundle and its CSS. In the source repo
they're produced by your bundler of choice (esbuild, Vite, Rollup, etc) from the
JSX/TSX in the parent project. For a quick prototype you can copy the files from
the top-level prototype directly:

```
DoStuff.html        → not needed (webview generates its own HTML)
src/styles.css      → media/styles.css
src/data.js         → bundle into media/webview.js
src/storage.js      → bundle into media/webview.js
src/icons.jsx       → bundle into media/webview.js
src/sidebar.jsx     → bundle into media/webview.js
src/board.jsx       → bundle into media/webview.js
src/modals.jsx      → bundle into media/webview.js
src/app.jsx         → bundle into media/webview.js (entry)
```

A minimal `esbuild` config:

```js
require("esbuild").build({
  entryPoints: ["src/webview/app.jsx"],
  bundle: true,
  format: "iife",
  outfile: "media/webview.js",
  jsx: "automatic",
  loader: { ".jsx": "jsx", ".tsx": "tsx" },
  define: { "process.env.NODE_ENV": '"production"' },
}).catch(() => process.exit(1));
```

The webview entry should:
1. Read `window.__DOSTUFF_MODE__` (`"sidebar"` or `"board"`) and render the corresponding
   root component.
2. Replace the prototype's `localStorage` calls with messages to `window.__VSCODE_API__`:
   - `postMessage({type:"ready"})` on mount, expect `{type:"init", issues, settings}` back.
   - `postMessage({type:"updateIssue", issue})` etc. on every mutation.
   - `addEventListener("message", ...)` to receive `{type:"issues", issues}` broadcasts.
