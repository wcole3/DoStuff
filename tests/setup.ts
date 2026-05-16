// Global test setup. Registers a happy-dom DOM on `globalThis` so React
// component tests (src/webview/**) can render. Loaded via `preload` in
// bunfig.toml.
//
// NOTE: happy-dom installs `window`, `document`, `HTMLElement`, etc., as
// globals. The host-side tests (extension/storage/mcpServer) don't *use*
// these globals — they're pure module tests — so registering them is a
// harmless no-op for those suites. The one quirk is `globalThis.crypto`:
// happy-dom replaces Bun's native `crypto` with a DOM-shaped one. The DOM
// `crypto` still has `randomUUID`/`getRandomValues`, so host code is fine.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import React from "react";

GlobalRegistrator.register({ url: "http://localhost/" });

// ─── ResizeObserver + measurement shim ─────────────────────────────────
// happy-dom does not implement ResizeObserver; webview components use it
// (via `useParentSize`) to size react-window lists. Provide a no-op
// observer so `ro.observe(el)` doesn't throw — the actual list rendering
// is taken care of by the `react-window` mock below, which ignores the
// sizing logic entirely.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// @ts-expect-error — install on globalThis & window
globalThis.ResizeObserver = FakeResizeObserver;
// @ts-expect-error
window.ResizeObserver = FakeResizeObserver;

// `useParentSize` only renders the list when clientHeight > 0; happy-dom
// returns 0 for layout dimensions. Force a positive value at the prototype
// level so every measured element appears to be 800×600.
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(): number {
    return 800;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(): number {
    return 600;
  },
});

// ─── react-window stub ─────────────────────────────────────────────────
// FixedSizeList is unrenderable in a virtualized DOM (it requires real
// pixel dimensions). Replace it with a simple list that renders ALL items.
// Tests can then assert against the resulting DOM directly.
//
// Mirrors the props used by Sidebar.tsx + Board.tsx:
//   { height, width, itemCount, itemSize, itemData, itemKey, children }
// where `children` is a row component that receives
// { index, style, data } and returns JSX.
mock.module("react-window", () => {
  interface FakeListProps {
    height: number;
    width: number;
    itemCount: number;
    itemSize: number | ((index: number) => number);
    itemData: unknown;
    itemKey?: (index: number, data: unknown) => string | number;
    children: React.ComponentType<{
      index: number;
      style: React.CSSProperties;
      data: unknown;
    }>;
  }
  function renderItems(props: FakeListProps): React.ReactNode {
    const { itemCount, itemData, itemKey, children: Row } = props;
    const items: React.ReactNode[] = [];
    for (let i = 0; i < itemCount; i++) {
      const key = itemKey ? itemKey(i, itemData) : i;
      items.push(
        React.createElement(Row, { key, index: i, style: {}, data: itemData }),
      );
    }
    return React.createElement(
      "div",
      { "data-testid": "react-window-list" },
      items,
    );
  }
  function FixedSizeList(props: FakeListProps) {
    return renderItems(props);
  }
  // VariableSizeList exposes a `resetAfterIndex` method via ref; provide a
  // no-op imperative handle so callers using `ref={...}` don't break.
  const VariableSizeList = React.forwardRef<
    { resetAfterIndex(index: number, shouldForceUpdate?: boolean): void },
    FakeListProps & { estimatedItemSize?: number }
  >(function VariableSizeList(props, ref) {
    React.useImperativeHandle(ref, () => ({ resetAfterIndex() {} }), []);
    return renderItems(props);
  });
  return { FixedSizeList, VariableSizeList };
});
