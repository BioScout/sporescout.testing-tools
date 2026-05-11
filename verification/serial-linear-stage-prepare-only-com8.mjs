import fs from 'node:fs'
import pathModule from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const requireFromTestingTools = createRequire(import.meta.url)
const { SerialPort } = requireFromTestingTools('serialport')
const { ReadlineParser } = requireFromTestingTools('@serialport/parser-readline')

const [
  ,,
  portPath = 'COM8',
  logPath = 'output/linear-stage-prepare-only-com8.log',
] = process.argv

if (portPath !== 'COM8') {
  throw new Error(`This verifier is pinned to approved local serial COM8. Refusing ${portPath}.`)
}

fs.mkdirSync(pathModule.dirname(logPath), { recursive: true })
const logStream = fs.createWriteStream(logPath, { flags: 'a' })
let pending

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  logStream.write(`${line}\n`)
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function parseResponse(line) {
  if (line.startsWith('@SSGUI:RSP ')) {
    try {
      const response = JSON.parse(line.slice('@SSGUI:RSP '.length))
      return { source: 'ssgui', ...response, result: parseMaybeJson(response.result) }
    } catch {
      return null
    }
  }

  let match = line.match(/^\[Command: (.*?) \| Value: (.*)\]$/)
  if (match) return { source: 'legacy', ok: true, command: match[1], result: parseMaybeJson(match[2]) }

  match = line.match(/^\[Command: (.*?) \| Error: (.*)\]$/)
  if (match) return { source: 'legacy', ok: false, command: match[1], error: match[2], result: parseMaybeJson(match[2]) }

  match = line.match(/^\[ERROR: (.*?) \| EC: (.*)\]$/)
  if (match) return { source: 'legacy', ok: false, command: match[1], error: match[2] }

  return null
}

function onResponse(response) {
  if (!pending || response?.command !== pending.command) return
  clearTimeout(pending.timeout)
  const active = pending
  pending = undefined
  log(`RESULT ${active.command} ok=${response.ok} source=${response.source || 'unknown'} result=${JSON.stringify(response.result)} error=${JSON.stringify(response.error || '')}`)
  active.resolve(response)
}

async function run(port, command, timeoutMs) {
  if (pending) throw new Error(`internal error: pending command ${pending.command}`)
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending = undefined
      reject(new Error(`Timed out waiting for ${command}`))
    }, timeoutMs)
    pending = { command, resolve, reject, timeout }
  })
  log(`>>> ${command}`)
  port.write(`${command}\n`)
  return promise
}

function isReady(response) {
  const result = response?.result
  return Boolean(response?.ok && result && typeof result === 'object' && !Array.isArray(result) && (result.ready === 1 || result.ready === true))
}

const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false })
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
parser.on('data', (raw) => {
  const line = String(raw).trimEnd()
  if (line) log(`<<< ${line}`)
  const response = parseResponse(line)
  if (response) onResponse(response)
})

await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()))

try {
  log(`Opened approved exact port ${portPath}`)
  await delay(2500)

  const version = await run(port, 'system GetFirmwareVersion', 30000)
  if (!(version.ok === true && Number(version.result) === 9003001)) {
    throw new Error(`Unexpected firmware version response: ${JSON.stringify(version)}`)
  }

  const initialStatus = await run(port, 'test linear_stage status', 90000)
  if (initialStatus.ok !== true) {
    throw new Error(`Linear-stage status failed before prepare: ${JSON.stringify(initialStatus)}`)
  }

  let prepare = await run(port, 'test linear_stage prepare', 240000)
  for (let attempt = 1; !isReady(prepare) && attempt <= 8; attempt += 1) {
    log(`PREPARE_READY false; waiting before retry ${attempt}.`)
    await delay(15000)
    prepare = await run(port, 'test linear_stage prepare', 240000)
  }

  const finalStatus = await run(port, 'test linear_stage status', 90000)
  if (finalStatus.ok !== true) {
    throw new Error(`Linear-stage status failed after prepare: ${JSON.stringify(finalStatus)}`)
  }

  if (!isReady(prepare)) {
    throw new Error(`Linear-stage prepare did not reach ready: ${JSON.stringify(prepare)}`)
  }

  log('PREPARE_ONLY_READY true')
} finally {
  if (pending) {
    clearTimeout(pending.timeout)
    pending = undefined
  }
  await new Promise((resolve) => port.close(() => resolve()))
  log('Port closed')
  logStream.end()
}
