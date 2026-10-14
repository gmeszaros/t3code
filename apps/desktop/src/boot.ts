// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime.
import * as NodeOS from "node:os";
import { applyPackagedLocalBuildEnvironment } from "./app/PackagedLocalBuild.ts";

const { app } = require("electron");
if (app.isPackaged && require("../../../package.json").t3codeLocalBuild === true) {
  applyPackagedLocalBuildEnvironment(process.env, NodeOS.homedir());
}
require("./compileCache.cjs");
require("./main.cjs");
