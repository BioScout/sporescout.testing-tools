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

## Validation

```powershell
npm test
npm run build
```

Packaging rebuilds native Electron modules for `serialport` and SQLite. On Windows this requires Visual Studio Build Tools with the Desktop development with C++ workload. The GitHub Actions release workflow runs on a Windows runner for that reason.

## Serial Protocol

The GUI sends the same serial commands an engineer can type manually.

Firmware can additionally emit:

- `@SSGUI:RSP {json}` for command responses
- `@SSGUI:EVT {json}` for mirrored cloud-equivalent events

The app stores mirrored events in SQLite and JSONL so payloads can be replayed to a future backend.
