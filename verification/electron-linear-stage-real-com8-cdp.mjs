import fs from 'node:fs'
import pathModule from 'node:path'

const [
  ,,
  cdpUrl = 'http://127.0.0.1:9224',
  logPath = 'electron-linear-stage-real-com8-cdp.log',
  modeArg = 'Full',
  screenshotPath = 'output/linear-stage-real-com8.png',
] = process.argv

const mechanicalAxisSteps = [
  'X home switch qualification',
  'X positive boundary qualification',
  'X span qualification',
  'X derated current margin',
  'X front-limit diagnosis',
  'Y home switch qualification',
  'Y positive boundary qualification',
  'Y span qualification',
  'Y derated current margin',
  'Z home switch qualification',
  'Z positive boundary qualification',
  'Z span qualification',
  'Z derated current margin',
]

const opticalAxisSteps = [
  'X optical qualification',
  'Y optical qualification',
  'Z optical qualification',
]

const expectedModes = {
  full: {
    label: 'Full',
    heading: 'Full test',
    command: 'test linear_stage full',
    expectedStatus: undefined,
    phases: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      ...mechanicalAxisSteps,
      'Select optical region',
      '3x3 scan audit',
      ...opticalAxisSteps,
      'Park Steppers',
    ],
  },
  mechanics: {
    label: 'Mechanics',
    heading: 'Mechanics-only / no optics',
    command: 'test linear_stage mechanics',
    expectedStatus: undefined,
    phases: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      ...mechanicalAxisSteps,
      'Park Steppers',
    ],
  },
  optics: {
    label: 'Optics',
    heading: 'Optics-only',
    command: 'test linear_stage optics',
    expectedStatus: undefined,
    phases: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      'Select optical region',
      '3x3 scan audit',
      ...opticalAxisSteps,
      'Park Steppers',
    ],
  },
}

const selectedMode = normalizeMode(modeArg)

const logStream = fs.createWriteStream(logPath, { flags: 'a' })

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  logStream.write(`${line}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getPageWebSocketUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${cdpUrl}/json`).then((response) => response.json())
      const target = targets.find((item) => item.type === 'page' && String(item.url).includes('/admin/linear-stage')) ?? targets.find((item) => item.type === 'page')
      if (target?.webSocketDebuggerUrl) {
        log(`CDP target ${target.url}`)
        return target.webSocketDebuggerUrl
      }
    } catch (error) {
      log(`Waiting for CDP target: ${error instanceof Error ? error.message : String(error)}`)
    }
    await sleep(1000)
  }
  throw new Error('Timed out waiting for Electron CDP page target.')
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.socket = undefined
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
    if (!message.id) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error) {
      pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`))
    } else {
      pending.resolve(message.result)
    }
  }

  send(method, params = {}, timeoutMs = 60000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('CDP socket is not open.')
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(payload)
    })
  }

  async evaluate(expression, timeoutMs = 60000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    }, timeoutMs + 5000)
    if (result.exceptionDetails) {
      throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails)}`)
    }
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

async function waitFor(client, description, predicateExpression, timeoutMs = 60000, intervalMs = 1000) {
  const start = Date.now()
  let lastValue
  while (Date.now() - start < timeoutMs) {
    lastValue = await client.evaluate(predicateExpression, Math.min(30000, timeoutMs))
    if (lastValue) {
      log(`WAIT ${description}: ok`)
      return lastValue
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(lastValue)}`)
}

function jsString(value) {
  return JSON.stringify(value)
}

function normalizeMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'full' || normalized === 'full test') return expectedModes.full
  if (normalized === 'mechanics' || normalized === 'mechanics-only' || normalized === 'mechanics only') return expectedModes.mechanics
  if (normalized === 'optics' || normalized === 'optics-only' || normalized === 'optics only') return expectedModes.optics
  throw new Error(`Unknown mode ${value}. Expected Full, Mechanics, or Optics.`)
}

async function clickButton(client, label) {
  const clicked = await client.evaluate(`(() => {
    const wanted = ${jsString(label)};
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === wanted);
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Button not found: ${label}`)
  log(`CLICK ${label}`)
}

async function ensureLinearStagePage(client) {
  if (await client.evaluate(`document.body.innerText.includes('Operator-guided motion, optical response, and scan audit validation.')`)) {
    return
  }
  const clicked = await client.evaluate(`(() => {
    const link = Array.from(document.querySelectorAll('a, [role="button"], button')).find((item) => item.innerText.trim() === 'Linear Stage');
    if (!link) return false;
    link.scrollIntoView({ block: 'center', inline: 'center' });
    link.click();
    return true;
  })()`)
  if (!clicked) throw new Error('Linear Stage navigation target not found.')
  await waitFor(client, 'linear-stage page', `document.body.innerText.includes('Operator-guided motion, optical response, and scan audit validation.')`, 60000)
}

async function selectMuiOption(client, label, optionText) {
  const opened = await client.evaluate(`(() => {
    const labelText = ${jsString(label)};
    const labelNode = Array.from(document.querySelectorAll('label')).find((item) => item.textContent.trim().replace(/\\s*\\*$/, '') === labelText);
    const root = labelNode?.closest('.MuiFormControl-root') ?? labelNode?.parentElement;
    const button = root?.querySelector('[role="combobox"]');
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    button.click();
    return true;
  })()`)
  if (!opened) throw new Error(`Select not found: ${label}`)
  const selected = await waitFor(client, `option ${optionText}`, `(() => {
    const optionText = ${jsString(optionText)};
    const option = Array.from(document.querySelectorAll('[role="option"], li')).find((item) => item.textContent.trim() === optionText);
    if (!option) return false;
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    option.click();
    return true;
  })()`, 10000, 250)
  if (!selected) throw new Error(`Option not found: ${optionText}`)
}

async function selectLinearStageMode(client, mode) {
  await clickButton(client, mode.label)
  await waitFor(client, `linear-stage mode ${mode.label}`, `(() => {
    const text = document.body.innerText;
    return text.includes(${jsString(mode.command)}) && text.includes(${jsString(mode.heading)});
  })()`, 10000)
}

async function setInputByLabel(client, label, value) {
  const focused = await client.evaluate(`(() => {
    const labelText = ${jsString(label)};
    const value = ${jsString(value)};
    const labels = Array.from(document.querySelectorAll('label'));
    const labelNode = labels.find((item) => item.textContent.trim().replace(/\\s*\\*$/, '') === labelText);
    const root = labelNode?.closest('.MuiFormControl-root') ?? labelNode?.parentElement;
    const input = root?.querySelector('input');
    if (!input) return false;
    input.scrollIntoView({ block: 'center', inline: 'center' });
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.blur();
    return true;
  })()`)
  if (!focused) throw new Error(`Input not found: ${label}`)
  log(`SET ${label}=${value}`)
}

async function setStageClear(client) {
  const checked = await client.evaluate(`(() => {
    const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((item) => {
      const label = item.closest('label');
      return label?.innerText.includes('Stage area is clear and ready for motion');
    });
    if (!checkbox) return false;
    checkbox.scrollIntoView({ block: 'center', inline: 'center' });
    if (!checkbox.checked) checkbox.click();
    return checkbox.checked;
  })()`)
  if (!checked) throw new Error('Stage-clear checkbox not found or not checked.')
  log('CHECK Stage area is clear')
}

async function saveScreenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000)
  fs.mkdirSync(pathModule.dirname(path), { recursive: true })
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'))
  log(`SCREENSHOT ${path}`)
}

async function captureState(client, label) {
  const state = await client.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    statusText: document.body.innerText.match(/Connected|Ready|Busy|Fault|Warning|Disconnected/g)?.slice(-5) ?? [],
    bodyExcerpt: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 900),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })).filter((button) => button.text),
  }))()`)
  log(`STATE ${label} ${JSON.stringify(state)}`)
  return state
}

const client = new CdpClient(await getPageWebSocketUrl())

try {
  await client.connect()
  await client.send('Runtime.enable')
  await client.send('Page.enable')

  await waitFor(client, 'renderer loaded', `document.readyState === 'complete' && Boolean(window.testingTools)`, 60000)
  await ensureLinearStagePage(client)

  const runtimeConfig = await client.evaluate(`window.testingTools.getRuntimeConfig()`, 10000)
  log(`RUNTIME_CONFIG ${JSON.stringify(runtimeConfig)}`)
  if (runtimeConfig?.serialBackend !== 'electron' || runtimeConfig?.exactSerialPort !== 'COM8') {
    throw new Error(`Real COM8 validation must be launched with Electron exact-port restriction COM8 before serial listing. Runtime config: ${JSON.stringify(runtimeConfig)}`)
  }

  await client.evaluate(`(async () => {
    const settings = await window.testingTools.getSettings();
    const operator = 'Codex Validation';
    await window.testingTools.saveSettings({
      ...settings,
      operators: Array.from(new Set([...(settings.operators ?? []), operator])),
      batches: Array.from(new Set([...(settings.batches ?? []), 'P1-DEV-2026-05'])),
      latestBatch: 'P1-DEV-2026-05',
      testerDeviceSerials: Array.from(new Set([...(settings.testerDeviceSerials ?? []), 'SS-A-001-101A-0013'])),
      defaultTesterDeviceSerial: 'SS-A-001-101A-0013',
    });
  })()`)
  log('Saved GUI validation operator/settings.')

  await client.evaluate(`location.reload()`)
  await waitFor(client, 'renderer reloaded', `document.readyState === 'complete' && Boolean(window.testingTools)`, 60000)
  await ensureLinearStagePage(client)
  await selectMuiOption(client, 'Mode', 'Serial')
  await waitFor(client, 'COM8 is the only exact-port option', `(async () => {
    const ports = await window.testingTools.listSerialPorts();
    return {
      ok: ports.length === 1 && ports[0]?.path === 'COM8',
      ports,
    };
  })()`, 60000)
  await waitFor(client, 'COM8 selected', `(() => {
    const labelNode = Array.from(document.querySelectorAll('label')).find((item) => item.textContent.trim().replace(/\\s*\\*$/, '') === 'COM port');
    const root = labelNode?.closest('.MuiFormControl-root') ?? labelNode?.parentElement;
    const input = root?.querySelector('input');
    return input?.value === 'COM8';
  })()`, 60000)
  await captureState(client, 'initial')

  await setInputByLabel(client, 'Operator', 'Codex Validation')
  await setInputByLabel(client, 'Batch', 'P1-DEV-2026-05')
  await setInputByLabel(client, 'Tester serial', 'SS-A-001-101A-0013')
  await sleep(1000)
  await selectLinearStageMode(client, selectedMode)

  await clickButton(client, 'Connect tester')
  await waitFor(client, 'serial connected', `document.body.innerText.includes('Connected')`, 60000, 1000)
  await waitFor(client, 're-run readiness enabled', `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === 'Re-run readiness');
    return Boolean(button && !button.disabled);
  })()`, 60000, 1000)
  await clickButton(client, 'Re-run readiness')
  try {
    await waitFor(client, 'readiness completed', `(() => {
      const text = document.body.innerText;
      const confirmButton = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === 'Confirm readiness');
      return text.includes('Clear stage area') && Boolean(confirmButton);
    })()`, 180000, 2000)
  } catch (error) {
    await captureState(client, 'readiness-timeout')
    throw error
  }
  await captureState(client, 'after-connect')

  await setStageClear(client)
  await clickButton(client, 'Confirm readiness')
  await waitFor(client, 'start enabled', `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === 'Start test');
    return Boolean(button && !button.disabled);
  })()`, 180000, 2000)
  await captureState(client, 'before-start')

  await clickButton(client, 'Start test')
  await waitFor(client, 'live phase feedback shell visible', `(() => {
    const text = document.body.innerText;
    return text.includes(${jsString(`${selectedMode.heading} in progress`)}) &&
      text.includes(${jsString(selectedMode.command)}) &&
      text.includes('Now') &&
      text.includes('Latest result') &&
      text.includes('Next up') &&
      text.includes('Completed, current, and upcoming firmware phases');
  })()`, 180000, 1000)
  await waitFor(client, 'first live phase update visible', `(() => {
    const text = document.body.innerText;
    return /Progress\\s+[1-9]\\d*\\/\\d+/.test(text) || text.includes('Running now') || /Latest result\\s+\\d+\\./.test(text);
  })()`, 180000, 1000)
  const liveState = await captureState(client, 'live-running')
  const liveFeedback = await client.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      hasCurrentPhase: /Now\\s+\\d+\\./.test(text) || text.includes('Running now') || /Latest result\\s+\\d+\\./.test(text),
      hasNextPhase: text.includes('Next up'),
      hasCompletedList: text.includes('Completed, current, and upcoming firmware phases'),
      hasLatestResult: text.includes('Latest result'),
      hasCommand: text.includes(${jsString(selectedMode.command)}),
      phaseNames: Array.from(document.querySelectorAll('[data-linear-stage-phase]')).map((node) => node.getAttribute('data-linear-stage-phase')),
      excerpt: text.replace(/\\s+/g, ' ').slice(0, 1800),
    };
  })()`)
  log(`LIVE_FEEDBACK ${JSON.stringify({ ...liveFeedback, liveStateExcerpt: liveState.bodyExcerpt })}`)
  if (!liveFeedback.hasCurrentPhase) throw new Error('Live phase feedback did not show the current running phase.')
  if (!liveFeedback.hasNextPhase) throw new Error('Live phase feedback did not show the next phase.')
  if (!liveFeedback.hasCompletedList) throw new Error('Live phase feedback did not show the full phase list.')
  if (!liveFeedback.hasLatestResult) throw new Error('Live phase feedback did not show the latest result card.')
  if (!liveFeedback.hasCommand) throw new Error('Live phase feedback did not show the exact executed command.')
  if (JSON.stringify(liveFeedback.phaseNames) !== JSON.stringify(selectedMode.phases)) {
    throw new Error(`${selectedMode.label} live phase list mismatch.\nExpected: ${selectedMode.phases.join(' | ')}\nActual:   ${(liveFeedback.phaseNames ?? []).join(' | ')}`)
  }
  await saveScreenshot(client, screenshotPath.replace(/(\.[^.]+)?$/, `-${selectedMode.label.toLowerCase()}$1`))
  await waitFor(client, 'test finished', `(() => {
    const text = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button')).map((button) => button.innerText.trim());
    const resultStatus = document.querySelector('[data-linear-stage-result-summary]')?.getAttribute('data-linear-stage-result-status');
    const liveActive = document.querySelector('[data-linear-stage-live-active]')?.getAttribute('data-linear-stage-live-active');
    const timeoutReview = /timed out before|No response before timeout|result payload was not captured|payload was omitted/i.test(text);
    return document.querySelector('[data-linear-stage-workflow-step="review"]') &&
      buttons.includes('Next run') &&
      buttons.includes('Repeat test') &&
      buttons.includes('Exit') &&
      ['pass', 'fail', 'warn'].includes(resultStatus ?? '') &&
      liveActive === 'false' &&
      !timeoutReview &&
      text.includes(${jsString(`${selectedMode.label} live trace`)}) &&
      text.includes(${jsString(selectedMode.command)}) &&
      !text.includes(${jsString(`${selectedMode.heading} in progress`)}) &&
      !text.includes('Test is running. Keep the stage clear');
  })()`, 1800000, 5000)
  const finalState = await captureState(client, 'final')
  const resultSummary = await client.evaluate(`(() => {
    const text = document.body.innerText;
    const records = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 25).map((row) => row.innerText.replace(/\\s+/g, ' | '));
    const finalStatus = document.querySelector('[data-linear-stage-result-summary]')?.getAttribute('data-linear-stage-result-status') ?? null;
    const liveActive = document.querySelector('[data-linear-stage-live-active]')?.getAttribute('data-linear-stage-live-active') ?? null;
    const hasTimeoutReview = /timed out before|No response before timeout|result payload was not captured|payload was omitted/i.test(text);
    return {
      finalStatus,
      liveActive,
      hasTimeoutReview,
      hasPayloadOmittedWarning: text.includes('result payload was not captured') || text.includes('payload was omitted'),
      hasHistogram: text.includes('Measurement histograms') || text.includes('Metric histogram') || text.includes('histogram'),
      hasHistoricalRecords: text.includes('Historical records') || text.includes('Full local retention'),
      hasLiveTrace: liveActive === 'false' && text.includes(${jsString(`${selectedMode.label} live trace`)}) && text.includes('Latest completed phase'),
      hasCommand: text.includes(${jsString(selectedMode.command)}),
      phaseNames: Array.from(document.querySelectorAll('[data-linear-stage-phase]')).map((node) => node.getAttribute('data-linear-stage-phase')),
      records,
      finalExcerpt: text.replace(/\\s+/g, ' ').slice(0, 1600),
    };
  })()`)
  log(`RESULT_SUMMARY ${JSON.stringify(resultSummary)}`)
  if (resultSummary.hasTimeoutReview) throw new Error('GUI reached a timeout or omitted-payload review state instead of an authoritative final firmware response.')
  if (resultSummary.hasPayloadOmittedWarning) throw new Error('GUI stopped at omitted payload instead of using the legacy full result.')
  if (!resultSummary.hasHistoricalRecords) throw new Error('Historical records panel was not visible.')
  if (!resultSummary.hasLiveTrace) throw new Error('Expected final review to preserve the live phase trace.')
  if (!resultSummary.hasCommand) throw new Error('Final review did not preserve the exact executed command.')
  if (!['pass', 'fail', 'warn'].includes(resultSummary.finalStatus)) throw new Error(`Final review did not expose a terminal status. Status: ${resultSummary.finalStatus}`)
  if (JSON.stringify(resultSummary.phaseNames) !== JSON.stringify(selectedMode.phases)) {
    throw new Error(`${selectedMode.label} final phase list mismatch.\nExpected: ${selectedMode.phases.join(' | ')}\nActual:   ${(resultSummary.phaseNames ?? []).join(' | ')}`)
  }
  log(`Electron linear-stage real COM8 GUI validation complete for ${selectedMode.label}.`)
} finally {
  await client.close().catch(() => undefined)
  logStream.end()
}
