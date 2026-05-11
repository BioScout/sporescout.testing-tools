# SporeScout Cartridge Subassembly Tester

Local Windows dashboard prototype for cartridge subassembly manufacturing.

The app intentionally mirrors the `web.dashboard` Manufacturing shell while keeping device communication, local persistence, update checks, and replayable event storage on the station PC.

## Stack

- Electron
- Vite
- React 18
- MUI 5
- TanStack Router
- SQLite local database
- JSONL event mirror
- GitHub Releases / electron-updater

## Development

```powershell
npm ci
npm run dev:renderer
```

The renderer preview runs in browser mock mode and does not enumerate or open serial ports.

For the desktop shell:

```powershell
npm run dev
```

## Windows Launch

For an operator laptop, use the one-click launcher at the repo root:

```powershell
.\Launch-SporeScout-Testing-Tools.cmd
```

The launcher first looks for a packaged portable app in `release\` using `launch.windows.json`. If a clean clone does not contain that ignored artifact, it downloads only an artifact pinned to the checked-out code: an exact-tag GitHub release first, then a successful GitHub Actions portable artifact whose workflow run `head_sha` matches the clone's `HEAD`. A GitHub release or workflow build produces `SporeScout Testing Tools-<version>-<arch>-portable.exe`, which includes Electron and the app runtime, so the station PC does not need Node.js, npm, or native build tools installed.

For private GitHub release or artifact downloads, the launcher uses `SPORESCOUT_TESTING_TOOLS_RELEASE_TOKEN` or `GITHUB_TOKEN` when either is set, then tries `gh auth token`, then tries HTTPS Git Credential Manager credentials for `github.com`. SSH-only clones usually do not provide an HTTPS API credential, so set a token with repo read access or authenticate `gh` on operator laptops that need to download private artifacts. If packaged download is not available, the launcher only falls back to source mode when a bundled Node runtime is available at `tools\node\node.exe`, `.node\node.exe`, `node\node.exe`, or the explicit `SPORESCOUT_NODE_EXE` path. In source mode it runs `npm ci` when `node_modules` is missing, then runs `npm run dev`; source mode is for development and can require native build tooling.

Useful launcher checks:

```powershell
.\scripts\launch-windows.ps1 -DryRun
.\scripts\launch-windows.ps1 -VerifyDownloadAvailability
.\scripts\launch-windows.ps1 -Dev -DryRun
.\scripts\launch-windows.ps1 -NoDownload -DryRun
```

## Validation

```powershell
npm test
npm run build
npm run package:dir
npm run dist:portable
```

Packaging rebuilds native Electron modules for `serialport` and SQLite. On Windows this requires Visual Studio Build Tools with the Desktop development with C++ workload. The GitHub Actions release workflow runs on a Windows runner for that reason. `npm run dist:portable` is the operator artifact path consumed by the launcher; `npm run dist:installer` remains available for an installer build.

The release workflow uploads the portable EXE as a GitHub Actions artifact on every successful run and publishes a GitHub release on `v*` tags. Local packaging does not attempt to publish.

## Serial Protocol

The GUI sends the same serial commands an engineer can type manually.

Firmware can additionally emit:

- `@SSGUI:RSP {json}` for command responses
- `@SSGUI:EVT {json}` for mirrored cloud-equivalent events

The app stores mirrored events in SQLite and JSONL so payloads can be replayed to a future backend.
