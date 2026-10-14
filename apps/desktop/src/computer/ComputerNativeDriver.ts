// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native driver uses synchronous hashes outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import type { App, Element } from "@crowecawcaw/xa11y";
import { ComputerError } from "./ComputerError.ts";

import type {
  ComputerAction,
  ComputerCapture,
  ComputerDriver,
  ComputerElement,
} from "./ComputerSession.ts";

type NativeApi = Pick<typeof import("@crowecawcaw/xa11y"), "App" | "screenshot">;

const MAX_ELEMENTS = 400;
const MAX_TEXT = 20_000;

/**
 * Cheap window identity over the app's top-level window list: the AX stable id
 * when present, else name plus frame. Never walks window contents.
 */
const sameWindow = (active: Element, previous: Element): boolean =>
  previous.stableId != null
    ? active.stableId === previous.stableId
    : active.name === previous.name &&
      JSON.stringify(active.bounds) === JSON.stringify(previous.bounds);

/** Only loaded in the disposable worker, never in Electron's main process. */
export function makeComputerNativeDriver(api: NativeApi): ComputerDriver {
  let handles: Element[] = [];
  let fingerprints: string[] = [];
  let target: App | undefined;
  let capturedWindow: Element | undefined;
  let closed = false;

  const requireOpen = () => {
    if (closed) throw new Error("Computer worker is closed.");
  };

  const readElements = async (active: Element) => {
    const elements: ComputerElement[] = [];
    const handles: Element[] = [];
    const fingerprints: string[] = [];
    let textRemaining = MAX_TEXT;
    let truncated = false;
    const boundText = (value: string | null) => {
      if (!value) return undefined;
      const limit = Math.min(textRemaining, 500);
      const text = value.slice(0, limit);
      textRemaining -= text.length;
      if (text.length < value.length) truncated = true;
      return text || undefined;
    };
    const walk = async (element: Element, depth: number): Promise<void> => {
      requireOpen();
      if (depth > 16 || elements.length >= MAX_ELEMENTS || textRemaining === 0) {
        truncated = true;
        return;
      }
      // Secure fields must not expose their contents or become write targets.
      const secure = /secure|password/i.test(
        `${element.role} ${String(element.raw.ax_subrole ?? "")}`,
      );
      const actions: Array<"press" | "fill" | "scrollIntoView"> = [];
      if (!secure && element.enabled) {
        if (element.visible && element.actions.includes("press")) actions.push("press");
        if (element.visible && element.editable) actions.push("fill");
        if (element.actions.includes("scroll_into_view")) actions.push("scrollIntoView");
      }
      // xa11y getters are captured data, not live reads. Compare freshly
      // queried nodes before using a semantic handle, including unabridged text
      // and topology. Hashes keep retained metadata bounded by MAX_ELEMENTS.
      fingerprints.push(
        NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify([
              depth,
              element.stableId,
              element.role,
              secure ? null : element.name,
              secure ? null : element.value,
              element.raw.ax_subrole,
              element.enabled,
              element.visible,
              element.editable,
              element.actions,
            ]),
          )
          .digest("hex"),
      );
      handles.push(element);
      elements.push({
        role: element.role.slice(0, 100),
        ...(!secure ? { name: boundText(element.name), value: boundText(element.value) } : {}),
        actions,
      });
      if (secure) return;
      const children = await element.children();
      for (const child of children) {
        if (elements.length >= MAX_ELEMENTS || textRemaining === 0) {
          truncated = true;
          break;
        }
        await walk(child, depth + 1);
      }
    };
    await walk(active, 0);
    return { handles, fingerprints, elements, truncated };
  };

  return {
    async foreground() {
      requireOpen();
      const app = await api.App.foreground({ timeout: 0 });
      if (app.pid === null) throw new Error("Foreground application has no process identity.");
      return { processId: app.pid, application: app.name };
    },
    async capture(processId): Promise<ComputerCapture> {
      requireOpen();
      handles = [];
      fingerprints = [];
      target = await api.App.byPid(processId, { timeout: 0 });
      const windows = await target.children();
      const active = windows.find((window) => window.active);
      if (!active)
        throw new ComputerError(
          "snapshot-unavailable",
          "No active accessible window. Bring the approved app to the foreground.",
        );
      capturedWindow = active;
      const content = await readElements(active);
      handles = content.handles;
      fingerprints = content.fingerprints;
      let truncated = content.truncated;
      // This is a screen-region capture; overlays in that region remain visible.
      const bounds = active.bounds;
      let image: ComputerCapture["image"];
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        const shot = await api.screenshot({ region: bounds });
        const png = shot.toPng();
        if (png.byteLength <= 5_000_000)
          image = { data: png.toString("base64"), mimeType: "image/png" };
        else truncated = true;
      }
      requireOpen();
      return { elements: content.elements, truncated, ...(image ? { image } : {}) };
    },
    async act(action: ComputerAction) {
      requireOpen();
      const element = handles[action.element];
      const previousFingerprints = fingerprints;
      handles = [];
      fingerprints = [];
      if (!element || !target) throw new Error("Unknown computer element.");
      const foreground = await api.App.foreground({ timeout: 0 });
      requireOpen();
      if (foreground.pid !== target.pid || foreground.name !== target.name) {
        throw new ComputerError(
          foreground.pid !== target.pid
            ? "focus-before-action-process"
            : "focus-before-action-name",
          "The foreground application changed.",
        );
      }
      const windows = await foreground.children();
      requireOpen();
      const active = windows.find((window) => window.active);
      const previous = capturedWindow;
      capturedWindow = undefined;
      if (!active || !previous || !sameWindow(active, previous)) {
        throw new ComputerError(
          "window-changed",
          "The active window changed. Take a new snapshot.",
        );
      }
      // Validate current AX contents before acting; no additional screenshot is needed.
      const current = await readElements(active);
      requireOpen();
      if (JSON.stringify(current.fingerprints) !== JSON.stringify(previousFingerprints)) {
        throw new ComputerError(
          "snapshot-unavailable",
          "Window contents changed. Take a new snapshot.",
        );
      }
      // Traversal awaits native calls. Recheck focus/window after it as well.
      const latest = await api.App.foreground({ timeout: 0 });
      requireOpen();
      if (latest.pid !== target.pid || latest.name !== target.name) {
        throw new ComputerError(
          latest.pid !== target.pid ? "focus-before-action-process" : "focus-before-action-name",
          "The foreground application changed.",
        );
      }
      const latestWindows = await latest.children();
      requireOpen();
      const latestActive = latestWindows.find((window) => window.active);
      if (!latestActive || !sameWindow(latestActive, previous)) {
        throw new ComputerError(
          "window-changed",
          "The active window changed. Take a new snapshot.",
        );
      }
      const freshElement = current.handles[action.element];
      if (!freshElement) throw new Error("Unknown computer element.");
      // Semantic element operations avoid global keystrokes landing in another app.
      switch (action.kind) {
        case "press":
          return freshElement.press();
        case "fill":
          return freshElement.setValue(action.text);
        case "scrollIntoView":
          return freshElement.scrollIntoView();
      }
    },
    close() {
      closed = true;
      target = undefined;
      capturedWindow = undefined;
      handles = [];
      fingerprints = [];
    },
  };
}
