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

/** The ZCode glyph as plain data; the detail stroke bakes the old 55% opacity into its fills. */
const zcodeIcon: ProviderIcon = {
  viewBox: "0 0 24 24",
  fill: { light: "#0F0F0F", dark: "#F5F5F5" },
  paths: [
    { d: "M4.2 3h9.3l6.3 8.1-8.7 9.9H4.2l8.4-9.6L6.9 6H4.2V3z" },
    {
      d: "M6.6 18.3h9.9V21H6.6v-2.7z",
      fill: { light: "#7B7B7B", dark: "#919191" },
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
