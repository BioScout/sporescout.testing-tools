const [, , cdpUrl = 'http://127.0.0.1:9234', exactPort = '', targetSerial = '', mode = 'timed'] = process.argv

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getPageWebSocketUrl() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`${cdpUrl}/json`).then((response) => response.json())
      const target = targets.find((item) => item.type === 'page' && String(item.url).includes('/admin/cartridge-subassembly')) ??
        targets.find((item) => item.type === 'page')
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
    } catch {
      // Keep waiting for Electron to expose the debug endpoint.
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for Electron CDP page target.')
}

async function waitFor(client, description, expression, timeoutMs = 60000, intervalMs = 250) {
  const start = Date.now()
  let lastValue
  while (Date.now() - start < timeoutMs) {
    lastValue = await client.evaluate(expression, Math.min(timeoutMs, 30000))
    if (lastValue === true || (lastValue && typeof lastValue === 'object' && lastValue.ok === true)) return lastValue
    await sleep(intervalMs)
  }
  const bodyExcerpt = await client.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 2000)`).catch(() => '<unavailable>')
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(lastValue)}; body=${JSON.stringify(bodyExcerpt)}`)
}

class CdpClient {
  nextId = 1
  pending = new Map()

  constructor(url) {
    this.url = url
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => this.onMessage(event.data))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening CDP websocket.')), 15000)
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('CDP websocket error.'))
      }, { once: true })
    })
  }

  onMessage(data) {
    const message = JSON.parse(String(data))
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    message.error ? pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`)) : pending.resolve(message.result)
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
    })
  }

  async evaluate(expression, timeoutMs = 60000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    }, timeoutMs + 5000)
    if (result.exceptionDetails) throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result?.value
  }

  async close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('CDP client closing.'))
      this.pending.delete(id)
    }
    this.socket?.close()
  }
}

async function runRecoveredNozzleUiValidation(client, exactPortValue, targetSerialValue) {
  const runUid = `validation-recovered-${Date.now()}`
  await waitFor(client, 'cartridge page shell', `Boolean(document.body?.innerText.includes('SporeScout Cartridge Subassembly Tester'))`)
  await client.evaluate(`(${async (targetSerial, recoveredRunUid) => {
    const api = window.testingTools
    const settings = await api.getSettings()
    await api.saveSettings({
      ...settings,
      latestBatch: 'P1-VALIDATION',
      operators: Array.from(new Set([...(settings.operators ?? []), 'Validation Operator'])),
      batches: Array.from(new Set([...(settings.batches ?? []), 'P1-VALIDATION'])),
      defaultTesterDeviceSerial: targetSerial,
      testerDeviceSerials: Array.from(new Set([...(settings.testerDeviceSerials ?? []), targetSerial])),
      defaultEnclosureBaseId: settings.defaultEnclosureBaseId || 'SS-P-001-101-0001',
      enclosureBaseIds: Array.from(new Set([...(settings.enclosureBaseIds ?? []), settings.defaultEnclosureBaseId || 'SS-P-001-101-0001'])),
      defaultNozzleId: settings.defaultNozzleId || 'NOZL-0001',
      nozzleIds: Array.from(new Set([...(settings.nozzleIds ?? []), settings.defaultNozzleId || 'NOZL-0001'])),
      defaultSealFixtureId: settings.defaultSealFixtureId || 'SEAL-0001',
      sealFixtureIds: Array.from(new Set([...(settings.sealFixtureIds ?? []), settings.defaultSealFixtureId || 'SEAL-0001'])),
    })
    await api.setActiveRunContext({
      operator: 'Validation Operator',
      batch: 'P1-VALIDATION',
      station_id: settings.stationId || 'VALIDATION-STATION',
      tester_device_serial: targetSerial,
      enclosure_base_id: settings.defaultEnclosureBaseId || 'SS-P-001-101-0001',
      nozzle_id: settings.defaultNozzleId || 'NOZL-0001',
      seal_fixture_id: settings.defaultSealFixtureId || 'SEAL-0001',
      cartridge_serial: 'SS-SA-007-030-9999',
      run_uid: recoveredRunUid,
      workflow: 'cartridge_subassembly',
      cartridge_phase: 'nozzle',
    })
    window.location.reload()
    return true
  }})(${JSON.stringify(targetSerialValue)}, ${JSON.stringify(runUid)})`, 30000)

  await waitFor(client, 'recovered nozzle context after reload', `(() => {
    const text = document.body?.innerText ?? '';
    return text.includes('run_uid ${runUid}') && text.includes('Previous cartridge run was recovered after app restart.');
  })()`)
  await waitFor(client, 'exact COM port selected', `document.body?.innerText.includes(${JSON.stringify(exactPortValue)})`)
  await client.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === 'Connect');
    if (!button) throw new Error('Connect button not found.');
    button.click();
    return true;
  })()`)
  await waitFor(client, 'readiness restored recovered nozzle phase', `(() => {
    const text = document.body?.innerText ?? '';
    return text.includes('Recovered active run_uid ${runUid}. Fit the nozzle, then continue.') &&
      text.includes('Reconnect the tester before continuing this recovered run.') === false &&
      text.includes('Tester ready. Insert cartridge and scan serial.') === false;
  })()`, 60000)
  const result = await client.evaluate(`(async () => {
    await window.testingTools.setActiveRunContext(undefined);
    return {
      ok: true,
      mode: 'recovered-nozzle-ui',
      exactPort: ${JSON.stringify(exactPortValue)},
      targetSerial: ${JSON.stringify(targetSerialValue)},
      runUid: ${JSON.stringify(runUid)},
      body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1400),
    };
  })()`)
  return result
}

function pageValidationScript(exactPortValue, targetSerialValue, validationMode) {
  return `(${async (exactPort, targetSerial, mode) => {
    const api = window.testingTools
    if (!api) throw new Error('window.testingTools is not available.')
    const log = []
    const assert = (condition, message, detail) => {
      if (!condition) throw new Error(`${message}${detail ? `: ${JSON.stringify(detail)}` : ''}`)
    }
    const commandOk = (result, command) => {
      assert(result?.accepted === true && result?.timedOut !== true && result?.response?.ok === true, `${command} failed`, result)
      log.push({ step: command, ok: true, result: result.response.result })
      return result
    }
    const isUnlocked = async (label) => {
      const result = commandOk(await api.sendCommand('solenoid IsUnlocked'), `${label}: solenoid IsUnlocked`)
      return result.response.result === true
    }
    const waitForUnlocked = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await isUnlocked(`unlock poll ${attempt + 1}`)) return true
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return false
    }

    const config = await api.getRuntimeConfig()
    assert(config.serialBackend === 'electron', 'Validation must run through Electron serial backend', config)
    assert(config.exactSerialPort === exactPort, 'Validation must be restricted to the approved exact port', config)

    const settings = await api.getSettings()
    const nextSettings = {
      ...settings,
      defaultTesterDeviceSerial: targetSerial,
      testerDeviceSerials: Array.from(new Set([...(settings.testerDeviceSerials ?? []), targetSerial])),
    }
    await api.saveSettings(nextSettings)
    await api.setActiveRunContext(undefined)

    const connect = await api.connect({ mode: 'serial', path: exactPort })
    assert(connect.ok === true && connect.path === exactPort, 'Serial connect failed or used the wrong port', connect)
    log.push({ step: 'connect', ok: true, path: connect.path })

    commandOk(await api.sendCommand('test cartridge_leak prepare'), 'test cartridge_leak prepare')

    if (mode === 'check-locked') {
      assert(await isUnlocked('shutdown relock verification') === false, 'Solenoid did not report locked after app shutdown')
      return { ok: true, mode, exactPort, targetSerial, log }
    }

    if (mode === 'lock-only') {
      commandOk(await api.sendCommand('solenoid Lock'), 'solenoid Lock')
      assert(await isUnlocked('after explicit lock') === false, 'Solenoid did not report locked after explicit lock')
      return { ok: true, mode, exactPort, targetSerial, log }
    }

    commandOk(await api.sendCommand('solenoid Lock'), 'solenoid Lock')
    assert(await isUnlocked('after explicit lock') === false, 'Solenoid did not report locked after explicit lock')

    commandOk(await api.unlockSolenoidForRemoval(20000), 'unlockSolenoidForRemoval(20000)')
    assert(await waitForUnlocked(), 'Solenoid did not report unlocked after timed unlock')
    log.push({ step: 'timed unlock reported unlocked', ok: true })

    if (mode === 'unlock-close' || mode === 'unlock-window-close') {
      if (mode === 'unlock-window-close') {
        setTimeout(() => window.close(), 0)
      }
      return { ok: true, mode, exactPort, targetSerial, log }
    }

    const relockStartedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 23000))
    assert(await isUnlocked('after 23s relock wait') === false, 'Solenoid did not relock within the 20 second timer window')
    log.push({ step: '20 second relock', ok: true, elapsedMs: Date.now() - relockStartedAt })
    return { ok: true, mode, exactPort, targetSerial, log }
  }})(${JSON.stringify(exactPortValue)}, ${JSON.stringify(targetSerialValue)}, ${JSON.stringify(validationMode)})`
}

if (!exactPort || !targetSerial) {
  throw new Error('Usage: node electron-cartridge-solenoid-cdp.mjs <cdpUrl> <exactPort> <targetSerial> <timed|unlock-close|unlock-window-close|check-locked|lock-only>')
}

const client = new CdpClient(await getPageWebSocketUrl())
await client.connect()

try {
  await client.send('Page.enable')
  const result = mode === 'recovered-nozzle-ui'
    ? await runRecoveredNozzleUiValidation(client, exactPort, targetSerial)
    : await client.evaluate(pageValidationScript(exactPort, targetSerial, mode), mode === 'timed' ? 90000 : 60000)
  console.log(JSON.stringify(result, null, 2))
} finally {
  await client.close()
}
