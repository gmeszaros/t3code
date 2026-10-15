// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { SortableOrder, SortableOrderItem } from "./SortableOrder";

it.each(["keyboard", "pointer"])(
  "reorders with %s without selecting a row, and Escape cancels",
  async (input) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const select = vi.fn();
    const move = vi.fn();
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const row = this.closest("[data-test-row]");
        const index = row ? [...container.querySelectorAll("[data-test-row]")].indexOf(row) : 0;
        return {
          top: index * 50,
          bottom: index * 50 + 50,
          left: 0,
          right: 300,
          width: 300,
          height: 50,
          x: 0,
          y: index * 50,
          toJSON: () => ({}),
        };
      });
    function List() {
      const [ids, setIds] = useState(["codex:sol", "claude:opus", "codex:luna"]);
      return (
        <SortableOrder
          ids={ids}
          onMove={(id, before) => {
            move(id, before);
            setIds((current) => {
              const next = current.filter((entry) => entry !== id);
              next.splice(before === null ? next.length : next.indexOf(before), 0, id);
              return next;
            });
          }}
        >
          {ids.map((id) => (
            <div key={id} data-test-row={id}>
              <SortableOrderItem id={id} label={id}>
                <button onClick={() => select(id)}>{id}</button>
              </SortableOrderItem>
            </div>
          ))}
        </SortableOrder>
      );
    }
    const key = async (target: EventTarget, code: string) => {
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: code === "Space" ? " " : code,
            code,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    try {
      await act(async () => root.render(<List />));
      const handle = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Reorder codex:sol"]',
      )!;
      handle.focus();
      if (input === "keyboard") {
        await key(handle, "Space");
        await key(document, "ArrowDown");
        await key(document, "Space");
      } else {
        const pointer = async (target: EventTarget, type: string, y: number) => {
          await act(async () => {
            const event = new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: 1,
              clientX: 50,
              clientY: y,
            });
            Object.defineProperty(event, "isPrimary", { value: true });
            target.dispatchEvent(event);
          });
        };
        await pointer(handle, "pointerdown", 25);
        await pointer(document, "pointermove", 35);
        await pointer(document, "pointermove", 75);
        await pointer(document, "pointerup", 75);
      }
      expect(move).toHaveBeenCalledWith("codex:sol", "codex:luna");
      expect(
        [...container.querySelectorAll("[data-test-row]")].map((row) =>
          row.getAttribute("data-test-row"),
        ),
      ).toEqual(["claude:opus", "codex:sol", "codex:luna"]);
      expect(select).not.toHaveBeenCalled();
      move.mockClear();
      await key(handle, "Space");
      await key(document, "ArrowDown");
      await key(document, "Escape");
      expect(move).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      rect.mockRestore();
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
