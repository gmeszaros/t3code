# ZCode runtime compatibility

Use this procedure before adopting a new native ZCode runtime. T3's adapter uses the runtime shipped by the official desktop app. A ZCode source commit, source package version and signed app version identify different artifacts. You need the tested artifact's identity before recommending an update.

## Compatibility baseline

| Item                                      | Baseline, 2026-10-16                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Upstream repository                       | [zai-org/ZCode](https://github.com/zai-org/ZCode)                                                                              |
| Last inspected upstream commit            | [`aac4755666d09fdcd70272fcf063c077a639015f`](https://github.com/zai-org/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f) |
| Source package versions at that commit    | Desktop `3.15.1`, Agent CLI `0.16.9`                                                                                           |
| Latest published GitHub release at review | [`v3.14.3`](https://github.com/zai-org/ZCode/releases/tag/v3.14.3)                                                             |
| Tested native artifact                    | macOS arm64 app `3.14.4`, build `3.14.4.7912`                                                                                  |
| Tested `zcode.cjs` SHA-256                | `fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f`                                                             |
| Native boundary verified                  | Capabilities, isolated session create, subscribe, list, resume and close, followed by process cleanup                          |
| Not verified by this smoke check          | Authenticated model turns, quota, native browser/CUA, and source-to-binary provenance                                          |
| Adoption decision                         | Retain the tested runtime. Treat the newer source as an optional candidate requiring verification before adoption.             |

This is the initial source baseline, so there is no previous reviewed range. The source inspection covered the [protocol dispatcher](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts), [session operations](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts), and package versions. The packaged runtime passed the isolated protocol smoke check separately. These findings do not establish that the source commit produced the tested app.

## Review a candidate

1. Read the current release metadata and freeze the candidate source SHA. These commands are read-only and install nothing:

   ```bash
   gh api repos/zai-org/ZCode/releases/latest --jq '{tag_name,published_at,html_url}'
   zcode_candidate_sha="$(gh api repos/zai-org/ZCode/commits/main --jq .sha)"
   gh api "repos/zai-org/ZCode/compare/aac4755666d09fdcd70272fcf063c077a639015f...${zcode_candidate_sha}" --jq '{status,ahead_by,behind_by,total_commits}'
   gh api --paginate "repos/zai-org/ZCode/compare/aac4755666d09fdcd70272fcf063c077a639015f...${zcode_candidate_sha}?per_page=100" --jq '.commits[] | [.sha,.commit.message] | @tsv'
   ```

   Use the baseline SHA in the table after each completed review. If history diverged, stop adoption and establish the correct comparison range. Inspect the release's actual commit and artifact metadata rather than assuming its tag or package version matches `main`.

2. Review changes in these areas against T3's existing adapter and tests:

   | Area                     | Review boundary                                                                              |
   | ------------------------ | -------------------------------------------------------------------------------------------- |
   | App-server protocol      | CLI entry point, framing, capabilities, request/notification schemas, added reverse requests |
   | Sessions and goals       | Create/resume, persistence, cancellation, errors, continuations and goal accounting          |
   | Tools and permissions    | Approval requests, mode changes, MCP configuration, input and consent boundaries             |
   | Models and reasoning     | Catalog and option mapping, unavailable models, selected model on resume                     |
   | Authentication and usage | Native account loading, header refresh, quota errors and usage accounting                    |
   | Browser integration      | Browser callbacks, ownership, cancellation and cleanup                                       |
   | Runtime packaging        | Entry script, executable, bundled catalog, storage roots and environment                     |

   Classify each relevant change as **no action needed**, **optional capability**, or **compatibility fix required**. Record the reason and evidence in the owning issue or PR. Missing evidence keeps adoption pending. Implement required fixes in separate feature PRs.

3. Run the existing focused adapter checks from an isolated feature worktree:

   ```bash
   vp test run apps/server/src/provider/zcode/ZCodeRuntime.test.ts apps/server/src/provider/zcode/ZCodeProtocolConnection.test.ts apps/server/src/provider/zcode/ZCodeSessionRuntime.test.ts apps/server/src/provider/zcode/ZCodeAdapterV2.test.ts apps/server/src/provider/zcode/ZCodeNativeAccount.test.ts apps/server/src/provider/zcode/ZCodeUsageLimits.test.ts apps/server/src/provider/zcode/ZCodeTurnUsage.test.ts apps/server/src/provider/zcode/ZCodeBrowserBridge.test.ts
   ```

4. With the exact candidate official app bundle available, run the isolated protocol smoke check:

   ```bash
   T3CODE_ZCODE_PROTOCOL_SMOKE=1 vp test run apps/server/src/provider/zcode/ZCodeLiveRuntime.test.ts
   ```

   This opt-in check supplies fresh temporary storage and workspace directories, passes no account, and makes no model request. A missing runtime or protocol failure fails the check. On success, the test closes its session and verifies that its child process exited. Scopes terminate the child and remove temporary directories on success, error or timeout. It does not restart a running T3 or ZCode app. Record the app version, build and runtime hash together with the test result.

   When adopting a different artifact, obtain it through the approved installation path while preserving the current runtime for rollback. Installation and authenticated smoke tests require their own authorization. The separate `T3CODE_ZCODE_LIVE_TESTS=1` test uses the native account and quota. Its terminal event can be a model failure, so a passing test alone does not prove successful inference. Browser/CUA checks also require explicit approval.

5. Before recommending adoption, verify the changed integration paths on the exact candidate artifact. Update the baseline table and link the review evidence. Keep unresolved source-to-binary mapping or untested affected paths explicit. If a required check fails, retain the current runtime and open a focused compatibility fix. Follow the [Local desktop release procedure](local-desktop-builds.md) for any T3 change. This procedure creates no schedule, updater or automatic integration.
