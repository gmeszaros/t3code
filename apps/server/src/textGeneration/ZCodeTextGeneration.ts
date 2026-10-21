import { makeZCodeNativeAccountReader } from "../provider/zcode/ZCodeNativeAccount.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";

import { TextGenerationError, type ZCodeSettings } from "@t3tools/contracts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as ZCodeRuntime from "../provider/zcode/ZCodeRuntime.ts";

const ZCODE_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeWorkspaceText = Schema.decodeUnknownEffect(
  Schema.Struct({
    text: Schema.String,
    toolCalls: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);

/** Uses the native single model request API with an explicitly empty tool list. */
export const makeZCodeTextGeneration = Effect.fn("makeZCodeTextGeneration")(function* (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtime = yield* ZCodeRuntime.resolveZCodeRuntime(zcodeSettings);
  const readNativeAccount = yield* makeZCodeNativeAccountReader(environment);

  const runZcodeJson = Effect.fn("ZCodeTextGeneration.runZcodeJson")(function* <
    S extends Schema.Top,
  >(
    request: TextGenerationOperations.Request<S>,
  ): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    return yield* Effect.gen(function* () {
      const { operation, cwd, prompt, outputSchema, modelSelection } = request;
      const nativeAccount =
        runtime.kind === "app-bundle" && runtime.builtinProviderConfigFile
          ? yield* readNativeAccount(runtime.builtinProviderConfigFile)
          : undefined;
      const scope = yield* Scope.fork(yield* Scope.Scope);
      const spawned = yield* Effect.mapError(
        ZCodeRuntime.spawnZCodeAppServer({
          runtime,
          cwd,
          environment,
          launchArgs: zcodeSettings.launchArgs,
          spawner: commandSpawner,
          scope,
          nativeAccount,
        }),
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to spawn the ZCode app-server.",
            cause,
          }),
      );

      return yield* Effect.gen(function* () {
        const workspace = { workspacePath: cwd, workspaceKey: cwd };
        const slash = modelSelection.model.indexOf("/");
        const modelId = slash > 0 ? modelSelection.model.slice(slash + 1) : modelSelection.model;
        const reasoning = modelSelection.options?.find(
          (option) => option.id === "reasoningLevel",
        )?.value;
        const selection = {
          providerId:
            slash > 0 ? modelSelection.model.slice(0, slash) : "account:zai-individual-coding-plan",
          modelId,
          ...(typeof reasoning === "string"
            ? { options: { reasoningLevel: reasoning } }
            : /^GLM-5\.3(?:-Flash)?$/i.test(modelId)
              ? { options: { reasoningLevel: "low" } }
              : {}),
        };
        const result = yield* spawned.client
          .request("workspace/generateText", {
            workspace,
            selection,
            prompt,
            tools: [],
            querySource: `t3_${operation}`,
            maxOutputTokens: 4096,
          })
          .pipe(Effect.flatMap(decodeWorkspaceText), Effect.timeout(ZCODE_TIMEOUT_MS));
        if ((result.toolCalls?.length ?? 0) > 0) {
          return yield* new TextGenerationError({
            operation,
            detail: "ZCode returned unexpected tool calls during metadata generation.",
          });
        }
        const trimmed = result.text.trim();
        if (!trimmed) {
          return yield* new TextGenerationError({
            operation,
            detail: "ZCode returned empty output.",
          });
        }
        return yield* TextGenerationOperations.decodeJsonReply(request, "ZCode", trimmed);
      }).pipe(
        Effect.ensuring(spawned.terminate.pipe(Effect.ignore)),
        Effect.provideService(Scope.Scope, scope),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: request.operation,
              detail: "ZCode text generation failed.",
              cause,
            }),
      ),
    );
  });

  return TextGenerationOperations.fromRunner(
    "ZCodeTextGeneration",
    TextGenerationOperations.withoutInvestigation("ZCode", runZcodeJson),
  );
});
