// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The vendor preload and bounded bootstrap timer run outside an Effect runtime.
import { close, DataType, load, open } from "ffi-rs";
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

if (
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Node preload executes without an Effect runtime.
  process.platform === "darwin" &&
  process.env.ELECTRON_RUN_AS_NODE === "1" &&
  process.execPath.endsWith("/ZCode.app/Contents/MacOS/ZCode")
) {
  const childProcess = NodeModule.createRequire(__filename)(
    "node:child_process",
  ) as typeof NodeChildProcess;
  const spawn = childProcess.spawn;
  childProcess.spawn = ((
    command: string,
    args?: readonly string[] | NodeChildProcess.SpawnOptions,
    options?: NodeChildProcess.SpawnOptions,
  ) => {
    if (!Array.isArray(args))
      return spawn(command, [], (args as NodeChildProcess.SpawnOptions | undefined) ?? {});
    const nodeMode = options?.env
      ? options.env.ELECTRON_RUN_AS_NODE
      : process.env.ELECTRON_RUN_AS_NODE;
    if (
      command === process.execPath &&
      nodeMode === "1" &&
      Array.isArray(args) &&
      !args.includes(__filename)
    ) {
      return spawn(command, ["--require", __filename, ...args], options ?? {});
    }
    return spawn(command, args as readonly string[], options ?? {});
  }) as typeof NodeChildProcess.spawn;
  // The packaged runtime ignores NODE_OPTIONS and its MCP launcher uses spawn, not fork.
  NodeModule.syncBuiltinESMExports();

  const hideDock = () => {
    const library = "t3-zcode-headless";
    open({
      library,
      path: "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    });
    try {
      // Process Manager only permits a process to transform its own application type.
      const currentProcess = Buffer.alloc(8);
      currentProcess.writeUInt32LE(2, 4);
      const status = load({
        library,
        funcName: "TransformProcessType",
        retType: DataType.I32,
        paramsType: [DataType.U8Array, DataType.U32],
        paramsValue: [currentProcess, 4],
      });
      if (status !== 0) process.stderr.write(`ZCode background activation failed (${status}).\n`);
    } finally {
      close(library);
    }
  };
  hideDock();
  // ZCode registers its CLI identity during bootstrap and resets the application type.
  setImmediate(hideDock);
  if (process.argv.includes("__zcode-plugin-host")) {
    // The Node REPL host registers after asynchronous plugin imports finish.
    let remaining = 100;
    const bootstrap = setInterval(() => {
      hideDock();
      if (process.title === "zcode-node-repl-mcp" || --remaining === 0) clearInterval(bootstrap);
    }, 100);
    bootstrap.unref();
  }
}
