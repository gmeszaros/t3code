// @effect-diagnostics globalDate:off -- Desktop grant timestamps cross a native process boundary.
import type * as Electron from "electron";

import { ComputerAccessHost } from "./ComputerAccessHost.ts";
import { startComputerProcess } from "./ComputerProcess.ts";
import type { ComputerGrant } from "./ComputerSession.ts";

export function createDesktopComputerAccess(input: {
  readonly workerPath: string;
  readonly dialog: {
    readonly showMessageBox: (
      options: Electron.MessageBoxOptions,
    ) => Promise<Electron.MessageBoxReturnValue>;
  };
  readonly changed: (grant: ComputerGrant | undefined) => void;
}) {
  return new ComputerAccessHost({
    now: Date.now,
    changed: input.changed,
    start: (grant) => startComputerProcess(input.workerPath, grant),
    async resolveApplication(name, signal) {
      if (signal.aborted) throw new Error("Computer access stopped.");
      const probe = startComputerProcess(input.workerPath);
      const stop = () => probe.close();
      signal.addEventListener("abort", stop, { once: true });
      try {
        return await probe.resolveApplication(name);
      } finally {
        signal.removeEventListener("abort", stop);
        probe.close();
      }
    },
    async approve({ application, threadTitle, readOnly, signal }) {
      if (signal.aborted) return false;
      const consentSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const result = await input.dialog.showMessageBox({
        type: "question",
        title: "Computer access",
        message: `${readOnly ? "Allow viewing" : "Allow control of"} ${application}?`,
        detail: `Thread: ${threadTitle}\n\nAccess lasts up to 10 minutes. ${readOnly ? "Input is disabled." : "The agent can activate controls and edit text in this application."} Screenshots include the visible screen area occupied by its active window, including any overlapping content. Bring the application to the foreground when ready. Use Stop Computer Access in the T3 menu to revoke access immediately.`,
        buttons: ["Deny", readOnly ? "Allow Viewing" : "Allow Control"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: consentSignal,
      });
      return !consentSignal.aborted && result.response === 1;
    },
  });
}
