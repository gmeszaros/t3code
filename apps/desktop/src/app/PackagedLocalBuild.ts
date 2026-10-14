// @effect-diagnostics nodeBuiltinImport:off - Bootstrap configuration runs before the Effect runtime.
import * as NodePath from "node:path";

export function applyPackagedLocalBuildEnvironment(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): void {
  env.T3_LOCAL_BUILD = "1";
  env.T3CODE_HOME = env.T3CODE_HOME?.trim() || NodePath.join(homeDirectory, ".t3-zcode-test");
  env.T3CODE_PORT = env.T3CODE_PORT?.trim() || "49883";
}
