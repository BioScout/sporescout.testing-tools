import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectRequest, GuiEventEnvelope, GuiResponseEnvelope, UpdateCheckResult } from '../src/shared/contracts'
import { mirroredEventRecordFromEnvelope, parseSerialLine } from '../src/shared/serialParser'
import { MockSerialDevice } from './mockDevice'
import { LocalStorageStore } from './storage'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let serialPort: SerialPort | null = null
let connectionMode: 'mock' | 'serial' | undefined
let mockDevice: MockSerialDevice | null = null
let store: LocalStorageStore

interface PendingResponse {
  command: string
  resolve: (response: GuiResponseEnvelope) => void
  timeout: NodeJS.Timeout
}

const pendingResponses: PendingResponse[] = []

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 720,
    title: 'SporeScout Cartridge Subassembly Tester',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  log.initialize()
  autoUpdater.logger = log
  store = new LocalStorageStore(app.getPath('userData'))
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  disconnectSerial()
  store?.close()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandlers(): void {
  ipcMain.handle('serial:listPorts', async () => {
    const ports = await SerialPort.list()
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      friendlyName: [port.manufacturer, port.serialNumber].filter(Boolean).join(' ') || port.path,
    }))
  })

  ipcMain.handle('serial:connect', async (_event, request: ConnectRequest) => {
    disconnectSerial()

    if (request.mode === 'mock') {
      connectionMode = 'mock'
      mockDevice = new MockSerialDevice(emitSerialLine)
      return { ok: true, mode: 'mock' as const }
    }

    if (!request.path) {
      return { ok: false, mode: 'serial' as const, error: 'No serial port selected.' }
    }

    try {
      serialPort = new SerialPort({
        path: request.path,
        baudRate: request.baudRate ?? 115200,
        autoOpen: false,
      })

      await new Promise<void>((resolve, reject) => {
        serialPort?.open((error) => (error ? reject(error) : resolve()))
      })

      const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }))
      parser.on('data', (line: string) => emitSerialLine(line))
      serialPort.on('error', (error) => emitSerialLine(`Serial error: ${error.message}`))
      serialPort.on('close', () => emitSerialLine('Serial connection closed'))
      connectionMode = 'serial'

      return { ok: true, mode: 'serial' as const, path: request.path }
    } catch (error) {
      disconnectSerial()
      return {
        ok: false,
        mode: 'serial' as const,
        path: request.path,
        error: error instanceof Error ? error.message : 'Serial connection failed.',
      }
    }
  })

  ipcMain.handle('serial:disconnect', async () => {
    disconnectSerial()
    return { ok: true }
  })

  ipcMain.handle('serial:sendCommand', async (_event, command: string) => {
    store.saveCommand(command, connectionMode ?? 'none')

    if (connectionMode === 'mock' && mockDevice) {
      const response = await mockDevice.send(command)
      return { accepted: true, command, response }
    }

    if (connectionMode !== 'serial' || !serialPort?.isOpen) {
      return { accepted: false, command, error: 'Serial device is not connected.' }
    }

    return await sendSerialCommand(command)
  })

  ipcMain.handle('storage:getSettings', async () => store.getSettings())
  ipcMain.handle('storage:saveSettings', async (_event, settings) => store.saveSettings(settings))
  ipcMain.handle('storage:saveOverride', async (_event, override) => store.saveOverride(override))
  ipcMain.handle('storage:getSummary', async () => store.getStorageSummary())
  ipcMain.handle('updates:check', async () => checkForUpdates())
}

function sendSerialCommand(command: string): Promise<{ accepted: boolean; command: string; response?: GuiResponseEnvelope; timedOut?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      removePending(command)
      resolve({ accepted: true, command, timedOut: true })
    }, 20000)

    pendingResponses.push({
      command,
      timeout,
      resolve: (response) => resolve({ accepted: true, command, response }),
    })

    serialPort?.write(`${command}\n`, (error) => {
      if (error) {
        removePending(command)
        clearTimeout(timeout)
        resolve({ accepted: false, command, error: error.message })
      }
    })
  })
}

function emitSerialLine(line: string): void {
  const trimmed = line.trim()
  mainWindow?.webContents.send('serial:line', trimmed)

  const parsed = parseSerialLine(trimmed)
  if (parsed.kind === 'gui-event' && parsed.envelope?.type === 'event') {
    const event = parsed.envelope as GuiEventEnvelope
    store.saveMirroredEvent(mirroredEventRecordFromEnvelope(event, trimmed))
    mainWindow?.webContents.send('serial:event', event)
    return
  }

  if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
    const response = parsed.envelope as GuiResponseEnvelope
    store.saveResponse(response, trimmed)
    resolvePendingResponse(response)
    return
  }

  if (parsed.kind === 'legacy-response' && parsed.legacy) {
    store.saveResponse(parsed.legacy, trimmed)
    resolvePendingResponse(parsed.legacy)
  }
}

function resolvePendingResponse(response: GuiResponseEnvelope): void {
  const index = pendingResponses.findIndex(
    (pending) => pending.command === response.command || response.command.length > 0,
  )
  if (index === -1) {
    return
  }

  const pending = pendingResponses.splice(index, 1)[0]
  clearTimeout(pending.timeout)
  pending.resolve(response)
}

function removePending(command: string): void {
  const index = pendingResponses.findIndex((pending) => pending.command === command)
  if (index !== -1) {
    pendingResponses.splice(index, 1)
  }
}

function disconnectSerial(): void {
  for (const pending of pendingResponses.splice(0)) {
    clearTimeout(pending.timeout)
  }

  mockDevice = null
  connectionMode = undefined

  if (serialPort?.isOpen) {
    serialPort.close()
  }
  serialPort = null
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const checked_at = new Date().toISOString()

  try {
    const update = await autoUpdater.checkForUpdates()
    const result: UpdateCheckResult = update?.updateInfo
      ? {
          checked_at,
          status: 'available',
          version: update.updateInfo.version,
          message: 'Update metadata was found. Install remains non-blocking.',
        }
      : {
          checked_at,
          status: 'current',
          version: app.getVersion(),
          message: 'No update metadata was returned.',
        }

    store.saveUpdateCheck(result)
    return result
  } catch (error) {
    const result: UpdateCheckResult = {
      checked_at,
      status: 'failed',
      version: app.getVersion(),
      message: error instanceof Error ? error.message : 'Update check failed.',
    }
    store.saveUpdateCheck(result)
    return result
  }
}
