import { useState } from "react";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { SortableOrder, SortableOrderItem } from "./SortableOrder";
import { Combobox, ComboboxListVirtualized } from "./ui/combobox";

it.each(["keyboard", "keyboard inside a combobox", "pointer"])(
  "reorders with %s without selecting a row, and Escape cancels",
  async (input) => {
    const container = document.createElement("div");
    const select = vi.fn();
    const move = vi.fn();
    using _rect = vi
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
      const list = (
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
      return input === "keyboard inside a combobox" ? (
        <Combobox inline open items={ids}>
          <ComboboxListVirtualized>{list}</ComboboxListVirtualized>
        </Combobox>
      ) : (
        list
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
    await using _screen = await render(<List />, { container });
    const handle = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Reorder codex:sol"]',
    )!;
    handle.focus();
    if (input.startsWith("keyboard")) {
      await key(handle, "Space");
      await key(handle, "ArrowDown");
      await key(handle, "Space");
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
    await key(handle, "ArrowDown");
    await key(handle, "Escape");
    expect(move).not.toHaveBeenCalled();
  },
);
