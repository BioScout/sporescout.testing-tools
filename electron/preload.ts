import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConnectRequest,
  GuiEventEnvelope,
  OverrideRecord,
  StationSettings,
  TestingToolsApi,
} from '../src/shared/contracts'

const api: TestingToolsApi = {
  listSerialPorts: () => ipcRenderer.invoke('serial:listPorts'),
  connect: (request: ConnectRequest) => ipcRenderer.invoke('serial:connect', request),
  disconnect: () => ipcRenderer.invoke('serial:disconnect'),
  sendCommand: (command: string) => ipcRenderer.invoke('serial:sendCommand', command),
  getSettings: () => ipcRenderer.invoke('storage:getSettings'),
  saveSettings: (settings: StationSettings) => ipcRenderer.invoke('storage:saveSettings', settings),
  saveOverride: (override: OverrideRecord) => ipcRenderer.invoke('storage:saveOverride', override),
  getStorageSummary: () => ipcRenderer.invoke('storage:getSummary'),
  getHistoricalRecords: () => ipcRenderer.invoke('storage:getHistoricalRecords'),
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
}

contextBridge.exposeInMainWorld('testingTools', api)
