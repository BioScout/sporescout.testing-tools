# PLAN

## Branch Purpose

- Branch: codex/bau-phase-1-cartridge-subassembly-tester-p01
- Repo or worktree: sporescout.testing-tools
- Goal: Testing Tools linear-stage split-mode manufacturing dashboard and portable Windows launch path.
- Risk class: Class 3, hardware-adjacent operator UI and serial command dispatch.
- Planning status: Approved in the current thread. Implementation is active.

## Workspace And Resource Claims

- Real writable worktree: C:\sporescout-worktrees\bau\phase-1-cartridge-subassembly-tester-p01\sporescout.testing-tools
- Paired firmware worktree: C:\sporescout-worktrees\bau\phase-1-cartridge-subassembly-tester-p01\sporescout.msom
- Reference docs: C:\GitHub\sporescout.agents
- Current-thread approved real device: SS-A-001-101A-0112 only.
- Approved device details: Particle id 0a10aced202194944a087ec4, Particle product id 33608, SSH alias SS-A-001-101A-0112. No local serial port is currently connected or approved for this device in this thread.
- Exact-port validation path: only use a local serial port if the user explicitly provides and approves the exact port for SS-A-001-101A-0112 in this thread.
- Forbidden device behavior: do not probe, list-test, flash, reboot, command, SSH, serial-connect, or inspect any other real device.

## Approved Scope

- Split the Linear Stage page into operator-selectable modes:
  - Full test
  - Mechanics-only / no optics
  - Optics-only
- Derive operator commands from mode:
  - test linear_stage full
  - test linear_stage mechanics
  - test linear_stage optics
- Keep the app's operator and engineering UI on canonical split-mode commands. Firmware preserves legacy aliases for manual engineering compatibility outside the app.
- Show mode-specific current phase, completed pass/fail state, next phase, early fail status, artifacts, metadata, and history.
- Carry `linear_stage_mode` through active run context, serial parsing, mirrored records, mock device results, and history.
- Keep stage-clear arming mandatory and one-shot for all modes.
- Tighten command validation to exact command matching with no trailing arguments.
- Add a one-click Windows launch path from a cloned repo using a prebuilt portable app artifact by default, with explicit source/bootstrap fallback only.

## Out Of Scope

- Do not interact with any real device other than SS-A-001-101A-0013.
- Do not claim browser Web Serial can enforce exact COM port selection.
- Do not make mock mode silently satisfy exact-port real-device validation.
- Do not revert unrelated dirty work from prior UI and cartridge-subassembly changes.

## Execution Slices

1. Refresh branch-local execution files.
2. Add shared mode contracts and command policy.
3. Extract linear-stage mode workflow helpers.
4. Update Linear Stage page, mock device, serial parser, storage/history, and tests.
5. Add portable launch scripts, manifest, package scripts, README, and release workflow updates.
6. Run no-device UI/build/package validation.
7. Run real COM8 GUI validation on SS-A-001-101A-0013 only after firmware/device validation is ready.
8. Commit logical blocks without reverting unrelated dirty work.

## Validation Plan

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run package:dir`
- `npm run dist:portable`
- Mock-mode UI smoke for all three modes.
- Packaged launcher smoke using local release output.
- Clean-clone launcher smoke by simulating no local portable artifact and confirming exact-tag release and checked-out-commit GitHub Actions artifact selection. Artifact availability must be verified after a successful release workflow run.
- Real GUI serial validation with SPORESCOUT_TESTING_TOOLS_EXACT_PORT=COM8 on SS-A-001-101A-0013 only.

## Current State

- 2026-05-11: Created task branch from `main` preserving the existing dirty worktree.
- 2026-05-11: Planning and five parallel inspection subagents completed. Implementation is now active.
- 2026-05-12: Added shared linear-stage mode contracts, exact command validation, mode-aware Linear Stage workflow helpers, UI mode selector plumbing, mock mode responses/events, and mirrored record parsing/indexing.
- 2026-05-12: Focused validation passed: `npm run typecheck`; `npm test -- --run src/shared/contracts.test.ts src/shared/serialParser.test.ts src/features/linearStage/linearStageWorkflow.test.ts`.
- 2026-05-12: Added dedicated `runLinearStageTest` API/IPC path. Generic active-run context cannot arm stage-clear; main process stamps fresh one-shot stage-clear arm id/timestamp and stores the pre-consume audit context with the command record.
- 2026-05-12: Browser preview is mock-only by default. Real serial validation must use Electron, and exact-port validation must set `SPORESCOUT_TESTING_TOOLS_EXACT_PORT=COM8`.
- 2026-05-12: Added linear-stage mirrored-event columns/indexes (`workflow`, `linear_stage_run_id`, `linear_stage_mode`) and preserved separate local run id plus firmware run uid for history.
- 2026-05-12: Updated live-run parsing to use active mode fallback, reject mismatched modes/local run ids, surface live artifacts, and mark omitted final payloads as fail/incomplete instead of pass.
- 2026-05-12: Added portable Windows launch path: root `.cmd`, manifest-driven PowerShell launcher, portable/default electron-builder scripts, release workflow, README docs, and automatic GitHub latest-release portable download for clean clones.
- 2026-05-12: Aligned UI planned step order with CM4 execution and live firmware progress: `CM4 task running`, initialize, mechanical subchecks, optical region, scan audit, direct optical checks, park.
- 2026-05-12: Review findings addressed:
  - Packaging clean-clone gap fixed with GitHub release download path.
  - Browser Web Serial exact-port bypass fixed by mock-only default.
  - Stage-clear bypass fixed with dedicated IPC/API path.
  - Legacy alias mode mismatch fixed in shared command mapping; the app dispatch path remains canonical-only.
  - Stale legacy linear-stage response matching narrowed to the oversized-response fallback window.
  - Live artifacts, omitted-result failure state, and active-mode event numbering fixed.
- 2026-05-12: Current no-device validation passed:
  - `npm run typecheck`
  - `npm test` passed 37 tests.
  - `npm run build`
  - `npm run dist:portable` produced `release\SporeScout Testing Tools-0.1.0-x64-portable.exe`.
  - `.\scripts\launch-windows.ps1 -DryRun` resolved the portable EXE.
  - Simulated clean-clone dry-run with empty `portableCandidates` reported the GitHub latest-release download path.
- 2026-05-12: Packaged `file://` routing bug fixed by using hash history for packaged Electron renderer loads. The not-found recovery button now uses router navigation.
- 2026-05-12: Final live trace now exposes the exact executed linear-stage command in the Current context panel, and mock GUI events include the `command` field to match firmware summary envelopes.
- 2026-05-12: Release workflow now also runs on branch pushes so clean-clone launch can use the latest successful Actions portable artifact before a tagged GitHub release exists.
- 2026-05-12: All-mode packaged Electron mock smoke passed through the rebuilt `release\win-unpacked\SporeScout Testing Tools.exe` over CDP. It exercised Full, Mechanics, and Optics modes, verified live phase/result/next/artifact context, verified command visibility, and asserted that Mechanics excludes optics phases while Optics excludes mechanical qualification phases. Screenshots were written as `output\linear-stage-mock-live-feedback-full.png`, `-mechanics.png`, and `-optics.png`.
- 2026-05-12: Review-driven dashboard/launcher fixes applied:
  - Stage-clear is now a separate `armLinearStageTest` IPC/API token consumed by `runLinearStageTest`; the run call no longer accepts renderer-supplied context that can self-arm motion.
  - Full-mode mock responses now include all mechanical-only checks (`derated current margin` and `X front-limit diagnosis`) before optics.
  - The packaged CDP smoke asserts the exact ordered phase list for Full, Mechanics, and Optics.
  - The release workflow runs that packaged all-mode smoke after packaging and before uploading the portable artifact.
  - The launcher no longer treats non-portable `*-x64.exe` installers as portable candidates, downloads releases only for an exact checked-out tag, and downloads Actions artifacts only when the run `head_sha` matches the checked-out commit.
  - README private-repo auth guidance now documents token, `gh auth token`, and HTTPS Git Credential Manager behavior.
- 2026-05-12: Latest no-device validation passed:
  - `npm run typecheck`
  - `npm test` passed 37 tests.
  - `npm run dist:portable` rebuilt `release\SporeScout Testing Tools-0.1.0-x64-portable.exe`.
  - Packaged all-mode mock smoke passed with exact phase-list assertions.
  - `.\scripts\launch-windows.ps1 -DryRun` and `.\Launch-SporeScout-Testing-Tools.cmd -DryRun` resolved the local portable EXE.
  - Simulated clean-clone dry-run with no local portable candidate reported exact-tag GitHub release first, then a checked-out-commit Actions artifact fallback (`6575fd51f7eb` in this worktree). This dry-run did not prove remote artifact availability.
  - Fixed the launcher branch metadata path for untagged branches: `git describe --exact-match` failures are non-fatal, and the script avoids PowerShell null-conditional syntax for Windows compatibility.
- 2026-05-12: Follow-up no-device review found pre-device validation blockers. Fixes were addressed before device validation:
  - Regenerate and commit `package-lock.json` so GitHub Actions `npm ci` can package a portable artifact.
  - Launcher now has a `-VerifyDownloadAvailability` mode and exact-commit workflow-run lookup template instead of relying on a shallow latest-runs page.
  - Renderer and Electron IPC are being hardened so connection mode, COM port, reconnect, and run metadata cannot change during an active or review-stage linear-stage run.
  - Electron main process now tracks a single in-flight linear-stage command, rejects reconnect/disconnect/new arm/new run during motion, validates IPC argument shapes, and revalidates stage-clear freshness immediately before serial write.
  - Browser preview Web Serial is fully disabled; it remains mock-only.
  - Real COM8 validation script now requires `getRuntimeConfig()` to report Electron exact-port `COM8` before any serial port listing.
  - Final response artifacts are merged into the live trace instead of being dropped when previous live artifacts exist as an empty array.
- GitHub Actions release artifact availability for commit `49aa1c461c3b47efccfe0c0b0484ae5cf6456fcc` has been verified. Newer local commits still need their own workflow artifact verification after they are pushed.
- 2026-05-12: Firmware preflight/OTA/runtime activation was completed on approved device SS-A-001-101A-0013 only before GUI motion validation. The correct Particle product id is `33608` (not platform id `35`), preflight showed OTA enabled, the branch binary was flashed, and `system GetFirmwareVersion` returned `9003001`.
- 2026-05-12: GitHub Actions Release workflow run `25683466062` for commit `49aa1c461c3b47efccfe0c0b0484ae5cf6456fcc` completed successfully. `.\scripts\launch-windows.ps1 -VerifyDownloadAvailability` verified the checked-out-commit workflow artifact `sporescout-testing-tools-portable`; HEAD is intentionally not an exact tag, so the exact-tag release check was skipped.
- CM4 dev-session deployment is currently blocked by local RMS/VPN routing: approved CM4 reports hostname `SS-A-001-101A-0013`, IP `192.168.1.179`, SSH service active, and `golden-eye.service` active through M-SoM/COM8, but the Windows host has no active OpenVPN/RMS route and `Test-NetConnection 192.168.1.179:22` routes via local WiFi and fails.
- 2026-05-12: Real COM8 GUI mechanics-mode validation on approved target SS-A-001-101A-0013 reached the live run screen and verified the exact mechanics command plus the 17-step mechanics phase list, but the CDP validation script falsely treated the left-nav "Review result" label as final completion while the test was still running. The script now waits for review-step data attributes, final review controls, terminal status, inactive live trace, and preserved command text before closing the app. Before any further motion, re-check the approved device is idle/ready because the previous app process was closed early.
- 2026-05-12: Post-fix local validation passed:
  - `npm run typecheck`
  - `npm test` passed 37/37 tests.
  - `node --check verification\electron-linear-stage-real-com8-cdp.mjs`
  - `node --check verification\serial-linear-stage-prepare-only-com8.mjs`
  - `npm run package:dir` rebuilt `release\win-unpacked\SporeScout Testing Tools.exe`.
  - Packaged all-mode mock smoke passed after the rebuild with exact phase-list assertions for Full, Mechanics, and Optics.
- 2026-05-12: Added a COM8-pinned prepare-only verifier that refuses any port other than COM8 and sends only non-motion `system GetFirmwareVersion`, `test linear_stage status`, and `test linear_stage prepare/status` commands before allowing any GUI motion rerun.
- 2026-05-12: Exact-target post-abort readiness was initially blocked: Particle product-scoped `system GetFirmwareVersion` and `test linear_stage prepare` calls to device id `0a10aced202194944a051970` returned only the weak function return `0` with no `CommandResponse`, and local COM8 opened but timed out waiting for `system GetFirmwareVersion`. This was later recovered before the mechanics GUI rerun; do not start any further motion unless a fresh non-motion command produces an authoritative response.
- 2026-05-12: CM4 software branch `codex/ss-a-0013-linear-stage-validation` is clean and pushed with two commits:
  - `e68de9a` CM4 linear-stage validation support baseline.
  - `8953e7c` optics-only homing, optical exception, park, and progress-state hardening.
  - CM4 software-only validation passed 44/44 pytest cases plus py_compile for the touched route/model/routine/task-runner files.
- 2026-05-12: Exact-target command path recovered before the real GUI rerun: product-scoped `system GetFirmwareVersion` returned `9003001`, and `test linear_stage prepare` returned READY for SS-A-001-101A-0013 only.
- 2026-05-12: Real packaged COM8 GUI mechanics-mode run on approved target SS-A-001-101A-0013 only completed to final review. Live feedback showed the exact `test linear_stage mechanics` command, current/next/latest cards, and the full 17-step mechanics planned phase list while running. Final firmware result was FAIL because M-SoM rejected the deployed CM4 response as stale/mismatched: requested `mechanics_only`/`service`, returned `full_function`/`service`.
- 2026-05-12: Post-run exact-target `test linear_stage prepare` returned READY again, so the approved device command path and idle/readiness checks recovered after the failed mechanics run.
- 2026-05-12: Review-driven dashboard fix applied after the real mechanics failure: final live traces now merge partial firmware summaries back into the planned mode step list by step name, keep unreported phases visible, and label inactive pending phases as `Not reported`. The real validator now rejects timeout/omitted-payload review states instead of accepting them as authoritative final firmware responses.
- 2026-05-12: Post-fix validation passed:
  - `npm run typecheck`
  - `npm test` passed 37/37 tests.
  - `node --check verification\electron-linear-stage-real-com8-cdp.mjs`
  - `node --check verification\serial-linear-stage-prepare-only-com8.mjs`
  - `npm run package:dir`
  - Packaged all-mode mock smoke passed for Full, Mechanics, and Optics after the rebuild.
- 2026-05-12: GitHub Actions Release workflow succeeded for commit `837d46fe4241e939b1cc31bbb30558622de65e90`. `.\scripts\launch-windows.ps1 -VerifyDownloadAvailability` verified checked-out-commit workflow run `25688588017` and artifact `sporescout-testing-tools-portable`. HEAD is not an exact tag, so exact-tag release download was correctly skipped.
- Full/optics real split-mode validation and a post-fix COM8 GUI rerun remain pending. Current blocker is CM4 target deployment: the deployed CM4 still returns `full_function` for a requested mechanics-only task, while the CM4 split-mode branch is pushed but not deployed because SSH/RMS access remains unavailable from this Windows host.
- 2026-05-12: Local-only RMS VPN triage narrowed the CM4 deployment blocker:
  - The existing user profile `RMS_VPN_CONFIG_1777894641937.ovpn` connects to the Teltonika endpoint and assigns `192.168.255.6` to the TAP adapter.
  - Running OpenVPN directly from this non-elevated session cannot add Windows routes (`Access is denied`), so `192.168.1.0/24` still routes through local WiFi.
  - `C:\Program Files\OpenVPN\config-auto` is not writable from this session, and this OpenVPN install does not include `openvpn-gui.exe` for interactive-service launch. This confirms the remaining blocker is host RMS/VPN route setup, not a Testing Tools packaging or dashboard blocker.
- 2026-05-12: GitHub Actions Release workflow run `25689895495` for commit `b09eddcdc9e33a53b7722863c0502233d4568b8c` completed successfully after the latest plan-note push. `.\scripts\launch-windows.ps1 -VerifyDownloadAvailability` verified the checked-out-commit workflow artifact `sporescout-testing-tools-portable`; HEAD is not an exact tag, so exact-tag release download was correctly skipped.
- 2026-05-12: GitHub Actions Release workflow run `25690379439` for current commit `eccc9a819bacd263889cc993286dc66abbc502b2` completed successfully. `.\scripts\launch-windows.ps1 -VerifyDownloadAvailability` verified the checked-out-commit workflow artifact `sporescout-testing-tools-portable`; this plan-only record is committed with `[skip ci]` to avoid another verification loop.
- 2026-05-12: RMS/VPN route was restored from this host and CM4 source commit `88696aee3a6b15087c3f43a6b251dfc3c508c79f` was transferred to approved device SS-A-001-101A-0013 only. The CM4 dev process is running from `/home/bioscout/dev/device.golden-eye-codex-linear-stage-ss0013-src`, production `golden-eye.service` is intentionally stopped during the bounded dev session, and the device must be restored to production service before final handoff.
- 2026-05-12: Post-CM4-deploy exact-target COM8 readiness passed with firmware `9003001` and `test linear_stage prepare` READY.
- 2026-05-12: Real packaged COM8 GUI mechanics validation against approved target SS-A-001-101A-0013 only exposed a dashboard merge bug in final review: firmware step numbering omitted the synthetic `CM4 task running` phase, causing final trace step 2 to be overwritten by `Initialise Steppers`. The UI now resolves known planned step names by active mode and preserves synthetic phases in final traces.
- 2026-05-12: Post-fix validation passed:
  - `npm test -- --run src/features/linearStage/linearStageWorkflow.test.ts`
  - `npm run typecheck`
  - `npm run package:dir`
  - Packaged all-mode mock smoke passed for Full, Mechanics, and Optics with exact phase-list assertions.
- 2026-05-12: Patched packaged COM8 GUI mechanics validation against approved target SS-A-001-101A-0013 only passed the validator. The UI showed the exact `test linear_stage mechanics` command, current/latest/next cards, full 17-step mechanics phase list, authoritative final FAIL, historical records, histograms, and preserved final live trace. The remaining device-level failure is now firmware/transport: M-SoM reports `Initialise Steppers` fail `-40 | kErrInvalidResponse` even though the approved CM4 dev log shows split-mode `mechanics_only` progress and completion. Firmware/CM4 compact task polling is being implemented before full/optics real validation.
- 2026-05-12: Updated the COM8-pinned prepare-only verifier so the expected firmware version can be supplied by CLI arg or `SPORESCOUT_EXPECTED_FIRMWARE_VERSION`. It remains COM8-only and non-motion. Validation passed:
  - `node --check verification\serial-linear-stage-prepare-only-com8.mjs`
  - `npm test -- --run src/features/linearStage/linearStageWorkflow.test.ts`
  - `npm run typecheck`
- Next exact-target prepare checks after OTA must call the verifier with expected firmware `9003002`.
- 2026-05-12: User paused the SS-A-001-101A-0013 validation path and reauthorized SS-A-001-101A-0112 as the only real-device target. New request is to make the cartridge tester GUI clone-ready on a fresh Windows machine, flash SS-A-001-101A-0112 with the latest M-SoM firmware, and avoid CM4/manual development sessions. Before real-device interaction, use only Particle/SSH commands scoped to SS-A-001-101A-0112 and do not touch SS-A-001-101A-0013.
- 2026-05-12: Cartridge GUI changes are present locally but not yet committed on this branch; fresh-clone readiness requires validating, committing, pushing, and verifying a Release workflow artifact for the resulting commit.
- 2026-05-12: Cartridge GUI clone-readiness validation passed locally before push:
  - `npm run typecheck`
  - `npm test` passed 38/38 tests.
  - `npm run dist:portable` produced `release\SporeScout Testing Tools-0.1.0-x64-portable.exe`.
  - `.\scripts\launch-windows.ps1 -DryRun` resolved the packaged portable EXE.
  - Render-only packaged Electron smoke passed via `verification\electron-cartridge-mock-cdp.mjs` with `SPORESCOUT_TESTING_TOOLS_EXACT_PORT=NO_REAL_PORT_FOR_RENDER_SMOKE`; this smoke intentionally does not click Connect or open serial.
