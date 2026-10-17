import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ZCodeSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import type { ProviderIcon } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The official Z.ai mark; evenodd knocks the Z out of the rounded square. */
const zcodeIcon: ProviderIcon = {
  viewBox: "0 0 30 30",
  fill: { light: "#0F0F0F", dark: "#F5F5F5" },
  paths: [
    {
      fillRule: "evenodd",
      d: "M24.51 28.51H5.49c-2.21 0-4-1.79-4-4V5.49c0-2.21 1.79-4 4-4h19.03c2.21 0 4 1.79 4 4v19.03c0 2.21-1.79 4-4 4ZM15.47 7.1l-1.3 1.85c-.2.29-.54.47-.9.47h-7.1V7.09C6.16 7.1 15.47 7.1 15.47 7.1ZM24.3 7.1 13.14 22.91H5.7L16.86 7.1ZM14.53 22.91l1.31-1.86c.2-.29.54-.47.9-.47h7.09v2.33H14.53Z",
    },
  ],
};

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  {
    driverKind: ProviderDriverKind.make("zcode"),
    label: "ZCode",
    icon: zcodeIcon,
    settingsSchema: ZCodeSettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
