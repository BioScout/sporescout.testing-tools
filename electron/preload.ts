import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConnectionStatusEvent,
  ConnectRequest,
  GuiEventEnvelope,
  LocalRunContext,
  OverrideRecord,
  StationSettings,
  TestingToolsApi,
} from '../src/shared/contracts'

const api: TestingToolsApi = {
  listSerialPorts: () => ipcRenderer.invoke('serial:listPorts'),
  connect: (request: ConnectRequest) => ipcRenderer.invoke('serial:connect', request),
  disconnect: () => ipcRenderer.invoke('serial:disconnect'),
  sendCommand: (command: string) => ipcRenderer.invoke('serial:sendCommand', command),
  armLinearStageTest: (context: LocalRunContext) => ipcRenderer.invoke('linearStage:arm', context),
  runLinearStageTest: (armId: string, command: string) => ipcRenderer.invoke('linearStage:run', armId, command),
  unlockSolenoidForRemoval: (lockAfterMs?: number) => ipcRenderer.invoke('serial:unlockSolenoidForRemoval', lockAfterMs),
  getSettings: () => ipcRenderer.invoke('storage:getSettings'),
  saveSettings: (settings: StationSettings) => ipcRenderer.invoke('storage:saveSettings', settings),
  unlockEngineering: (password: string) => ipcRenderer.invoke('engineering:unlock', password),
  saveOverride: (override: OverrideRecord) => ipcRenderer.invoke('storage:saveOverride', override),
  setActiveRunContext: (context?: LocalRunContext) => ipcRenderer.invoke('storage:setActiveRunContext', context),
  getActiveRunContext: () => ipcRenderer.invoke('storage:getActiveRunContext'),
  getStorageSummary: () => ipcRenderer.invoke('storage:getSummary'),
  getHistoricalRecords: (query) => ipcRenderer.invoke('storage:getHistoricalRecords', query),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  onSerialLine: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line)
    ipcRenderer.on('serial:line', listener)
    return () => ipcRenderer.removeListener('serial:line', listener)
  },
  onDeviceEvent: (callback: (event: GuiEventEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: GuiEventEnvelope) => callback(event)
    ipcRenderer.on('serial:event', listener)
    return () => ipcRenderer.removeListener('serial:event', listener)
  },
  onConnectionStatus: (callback: (status: ConnectionStatusEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ConnectionStatusEvent) => callback(status)
    ipcRenderer.on('serial:connectionStatus', listener)
    return () => ipcRenderer.removeListener('serial:connectionStatus', listener)
  },
}

contextBridge.exposeInMainWorld('testingTools', api)
