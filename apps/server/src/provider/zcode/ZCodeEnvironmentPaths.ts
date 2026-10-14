import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** Matches the vendor CLI's data root and personal provider config overrides. */
export const resolveZCodeEnvironmentPaths = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || (yield* HostProcess.HomeDirectory);
  const dataHome = environment.ZCODE_DATA_BASE_DIR?.trim() || home;
  const settingsHome = environment.ZCODE_DESKTOP_HOME_DIR?.trim() || dataHome;
  const root = path.join(dataHome, ".zcode", "v2");
  return {
    home,
    // T3 reads this store; the vendor child retains its isolated data root.
    credentialsPath:
      environment.T3CODE_ZCODE_CREDENTIALS_FILE?.trim() || path.join(root, "credentials.json"),
    personalConfigPath:
      environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ||
      path.join(root, "provider_config.json"),
    // ZCode's settings service reads ZCODE_DESKTOP_HOME_DIR; T3 mirrors its
    // isolated data root there when no explicit desktop home is configured.
    settingsPath: path.join(settingsHome, ".zcode", "v2", "setting.json"),
  };
});
