import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { MarkdownFindContext } from "./markdownFindContext";
import { useThreadFindHighlights } from "./threadFindHighlights";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make([]).pipe(Atom.keepAlive);
  const noConfig = Atom.make(null);
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});

const SHORT_SCRIPT =
  "export const meta = { name: 'repo-check' }\nagent('Run SCRIPTONLY with Bash')";
const LONG_SCRIPT = [
  "export const meta = { name: 'repo-check' }",
  ...Array.from({ length: 24 }, (_, index) => `const step${index} = await agent('Step ${index}')`),
  "return 'TAILONLY'",
].join("\n");

const opening = (script: string): WorkflowOpening => ({
  messageId: "message-script",
  script,
  name: "repo-check",
  description: "Two agents each inspect one file",
  driver: null,
  providerInstanceId: null,
  group: null,
});

function Find(props: { readonly container: HTMLElement | null; readonly query: string }) {
  useThreadFindHighlights({
    container: props.container,
    query: props.query,
    activeRowId: "opening",
    activeOccurrence: 0,
    onActiveRange: () => undefined,
  });
  return null;
}

function content(host: HTMLElement, script: string, query = "") {
  return (
    <AppAtomRegistryProvider>
      <MarkdownFindContext value={query.length > 0}>
        <div data-timeline-row-id="opening">
          <WorkflowOpeningBlock
            opening={opening(script)}
            environmentId={EnvironmentId.make("environment-local")}
            onOpenThread={() => undefined}
          />
        </div>
      </MarkdownFindContext>
      <Find container={host} query={query} />
    </AppAtomRegistryProvider>
  );
}

function container() {
  const host = document.createElement("div");
  host.style.width = "720px";
  return host;
}

const foldToggle = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) =>
    /Show full script|Show less/.test(button.textContent ?? ""),
  );

it("shows a short script as highlighted code with nothing to open", async () => {
  const host = container();
  await using _screen = await render(content(host, SHORT_SCRIPT), { container: host });
  expect(host.querySelector('[data-language="javascript"]')?.textContent).toContain("SCRIPTONLY");
  await act(async () => {
    await getSyntaxHighlighterPromise("javascript");
  });
  expect(host.querySelector(".chat-markdown-shiki")).not.toBeNull();
  expect(foldToggle(host)).toBeUndefined();
});

it("folds a long script until it is opened", async () => {
  const host = container();
  await using _screen = await render(content(host, LONG_SCRIPT), { container: host });
  expect(foldToggle(host)?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("[data-thread-find-fold]")).not.toBeNull();
  await act(async () => foldToggle(host)?.click());
  await vi.waitFor(() => expect(foldToggle(host)?.getAttribute("aria-expanded")).toBe("true"));
  expect(host.querySelector("[data-thread-find-fold]")).toBeNull();
});

it("finds the workflow's name and opens a folded script on a match below the fold", async () => {
  const host = container();
  await using screen = await render(content(host, LONG_SCRIPT, "repo-check"), { container: host });
  await vi.waitFor(() => expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1));
  expect(foldToggle(host)?.getAttribute("aria-expanded")).toBe("false");

  await screen.rerender(content(host, LONG_SCRIPT, "TAILONLY"));
  await vi.waitFor(() => expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1));
  await vi.waitFor(() => expect(foldToggle(host)?.getAttribute("aria-expanded")).toBe("true"));
});
