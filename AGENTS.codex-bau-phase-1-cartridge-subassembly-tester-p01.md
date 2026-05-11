# Branch Agent

## Branch Identity

- Branch: codex/bau-phase-1-cartridge-subassembly-tester-p01
- Repo: sporescout.testing-tools
- Worktree path: C:\sporescout-worktrees\bau\phase-1-cartridge-subassembly-tester-p01\sporescout.testing-tools
- Paired firmware repo: C:\sporescout-worktrees\bau\phase-1-cartridge-subassembly-tester-p01\sporescout.msom
- Goal: Split-mode Linear Stage dashboard, safer command dispatch, and portable Windows launch.

## Current Execution State

- Phase: implementation active after approved plan.
- Latest meaningful update: created branch-local plan and agent state for the current task.
- Approved target device in this thread: SS-A-001-101A-0112 only.
- Approved target details: Particle id 0a10aced202194944a087ec4, Particle product id 33608, SSH alias SS-A-001-101A-0112. No local serial port is currently connected or approved for this device in this thread.
- Device rule: before any real-device action, restate that the action is only for SS-A-001-101A-0112. Never interact with any other real device, including SS-A-001-101A-0013.
- Current validation state: no-device desktop validation passed, including packaged all-mode mock smoke through the rebuilt Electron app with exact ordered phase-list assertions. Current-thread validation on approved device SS-A-001-101A-0013 only has flashed and activated M-SoM firmware version `9003001`, restored CM4 SSH access, deployed the CM4 split-mode source into a bounded dev session, exercised COM8 readiness, and passed patched packaged mechanics-mode GUI validation to authoritative final review. The real mechanics result is still FAIL because the completed CM4 task payload exceeds the M-SoM UART response budget and is rejected as `kErrInvalidResponse`; compact/delta CM4 task polling is the active fix before full/optics validation.

## Implementation Notes

- Operator UI must emit only canonical split-mode commands:
  - test linear_stage full
  - test linear_stage mechanics
  - test linear_stage optics
- All modes require stage-clear arming because all modes can move hardware.
- Exact-port real validation must use the Electron serial path with SPORESCOUT_TESTING_TOOLS_EXACT_PORT=COM8.
- Browser Web Serial and mock mode are useful for development smoke tests but are not accepted as exact-port real-device evidence.
- The COM8 prepare-only verifier remains pinned to COM8, runs only non-motion readiness commands, and now accepts expected firmware version `9003002` via CLI arg or `SPORESCOUT_EXPECTED_FIRMWARE_VERSION` for post-OTA activation checks.
- Portable operator launch prefers a prebuilt packaged artifact, downloads the latest portable GitHub release when a clean clone has no artifact, and treats source bootstrap as a developer fallback.
- The release workflow also runs on branch pushes so a pushed branch can provide the Actions portable artifact fallback before a tagged release exists.
- Linear-stage motion must use a two-step arm/run path: `armLinearStageTest(context)` creates the main-process stage-clear token, and `runLinearStageTest(armId, command)` consumes it. Do not reintroduce renderer-set stage-clear arming through generic storage context or a one-call run path that self-arms.
- Clean-clone launcher downloads must stay pinned to the checked-out code: exact-tag release first, then a successful Actions artifact whose `head_sha` matches `HEAD`.
- Current request adds a cartridge tester handoff: validate and commit the local cartridge GUI changes, push the branch, and verify a matching Release workflow artifact so a fresh Windows clone can run the GUI without installing developer dependencies.
- Latest local cartridge handoff validation passed: `npm run typecheck`, `npm test` 38/38, `npm run dist:portable`, launcher dry-run, and render-only packaged Electron smoke with a fake exact-port value. The smoke must remain render-only unless an exact approved serial port is supplied in the current thread.
- Commit `cc54169` is pushed and has verified Release workflow artifact `sporescout-testing-tools-portable` from run `25699897362`. SS-A-001-101A-0112 is flashed with M-SoM firmware `9003003`; cartridge readiness returned READY.

## Required Validation

- Completed no-device: unit tests, typecheck, build, portable packaging, launcher dry-run, simulated clean-clone launcher dry-run, packaged Electron smoke for Full/Mechanics/Optics.
- Remaining: after CM4 split-mode deployment to SS-A-001-101A-0013, rerun real GUI serial validation on the approved target only, covering the post-fix mechanics rerun plus full and optics split modes as hardware readiness allows.
- Active blocker to clear before full/optics validation: rebuild/reflash M-SoM compact polling and redeploy the CM4 compact task API, then rerun mechanics and proceed only if exact-target readiness recovers.

## Handoff Notes

- Preserve unrelated dirty work. Inspect `git status` before each commit and stage only intended files.
- Keep this file and `PLAN.md` updated when decisions, validation results, blockers, or device state change.
