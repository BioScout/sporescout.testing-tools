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
- Approved target device in this thread: SS-A-001-101A-0013 only.
- Approved target details: Particle id 0a10aced202194944a051970, COM8 when plugged in, SSH alias SS-A-001-101A-0013.
- Device rule: before any real-device action, restate that the action is only for SS-A-001-101A-0013. Never interact with any other real device.
- Current validation state: no-device desktop validation passed, including packaged all-mode mock smoke through the rebuilt Electron app with exact ordered phase-list assertions; no current-thread device validation has run yet.

## Implementation Notes

- Operator UI must emit only canonical split-mode commands:
  - test linear_stage full
  - test linear_stage mechanics
  - test linear_stage optics
- All modes require stage-clear arming because all modes can move hardware.
- Exact-port real validation must use the Electron serial path with SPORESCOUT_TESTING_TOOLS_EXACT_PORT=COM8.
- Browser Web Serial and mock mode are useful for development smoke tests but are not accepted as exact-port real-device evidence.
- Portable operator launch prefers a prebuilt packaged artifact, downloads the latest portable GitHub release when a clean clone has no artifact, and treats source bootstrap as a developer fallback.
- The release workflow also runs on branch pushes so a pushed branch can provide the Actions portable artifact fallback before a tagged release exists.
- Linear-stage motion must use a two-step arm/run path: `armLinearStageTest(context)` creates the main-process stage-clear token, and `runLinearStageTest(armId, command)` consumes it. Do not reintroduce renderer-set stage-clear arming through generic storage context or a one-call run path that self-arms.
- Clean-clone launcher downloads must stay pinned to the checked-out code: exact-tag release first, then a successful Actions artifact whose `head_sha` matches `HEAD`.

## Required Validation

- Completed no-device: unit tests, typecheck, build, portable packaging, launcher dry-run, simulated clean-clone launcher dry-run, packaged Electron smoke for Full/Mechanics/Optics.
- Remaining: real GUI serial validation on SS-A-001-101A-0013 only after firmware/CM4 deployment readiness.

## Handoff Notes

- Preserve unrelated dirty work. Inspect `git status` before each commit and stage only intended files.
- Keep this file and `PLAN.md` updated when decisions, validation results, blockers, or device state change.
