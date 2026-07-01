import fs from 'node:fs'
import pathModule from 'node:path'

const [, , cdpUrl = 'http://127.0.0.1:9225', screenshotPath = 'output/linear-stage-mock-live-feedback.png'] = process.argv

const mechanicalAxisSteps = [
  'X home switch',
  'X hard limit',
  'X span',
  'X current margin',
  'Y home switch',
  'Y hard limit',
  'Y span',
  'Y current margin',
  'Z home switch',
  'Z hard limit',
  'Z span',
  'Z current margin',
]

const powerAndSessionWithUpload = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Connect modem',
  'Wait for CM4 readiness',
  'Check camera connection',
  'Check camera image capture',
  'Check camera LED',
  'Wait for internet readiness',
  'Authenticate BioScout API',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
]

const powerAndSessionMechanics = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Wait for CM4 readiness',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
]

const powerAndSessionWithCamera = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Wait for CM4 readiness',
  'Check camera connection',
  'Check camera image capture',
  'Check camera LED',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
]

const scanUploadSteps = [
  'Scan capture',
  'Scan audit',
  'Artifact generation',
  'Upload',
]

const cleanupSteps = [
  'Park/cleanup',
  'Close CM4 session',
  'Restore power state',
  'Linear-stage verdict',
]

const expectedPhaseNames = {
  Production: [
    ...powerAndSessionWithUpload,
    ...mechanicalAxisSteps,
    'Optical region selection',
    'Home tile capture',
    'Production workspace stress',
    'X focus',
    'Y displacement',
    'Z displacement',
    ...scanUploadSteps,
    'Post-stress recovery',
    ...cleanupSteps,
  ],
  Mechanics: [
    ...powerAndSessionMechanics,
    ...mechanicalAxisSteps,
    ...cleanupSteps,
  ],
  Optics: [
    ...powerAndSessionWithCamera,
    'Optical region selection',
    'Home tile capture',
    'Production workspace stress',
    'X focus',
    'Y displacement',
    'Z displacement',
    'Post-stress recovery',
    ...cleanupSteps,
  ],
}

const inProgressText = {
  Production: 'Production full in progress',
  Mechanics: 'Mechanics only in progress',
  Optics: 'Optics only in progress',
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getPageWebSocketUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${cdpUrl}/json`).then((response) => response.json())
      const target = targets.find((item) => item.type === 'page' && String(item.url).includes('/admin/linear-stage')) ?? targets.find((item) => item.type === 'page')
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
    } catch {
      // Keep waiting for Electron to expose the debug endpoint.
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for Electron CDP page target.')
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

async function waitFor(client, description, expression, timeoutMs = 60000, intervalMs = 250) {
  const start = Date.now()
  let lastValue
  while (Date.now() - start < timeoutMs) {
    lastValue = await client.evaluate(expression, Math.min(timeoutMs, 30000))
    if (lastValue === true || (lastValue && typeof lastValue === 'object' && lastValue.ok === true)) return lastValue
    await sleep(intervalMs)
  }
  const bodyExcerpt = await client.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 2400)`).catch(() => '<unavailable>')
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(lastValue)}; body=${JSON.stringify(bodyExcerpt)}`)
}

function jsString(value) {
  return JSON.stringify(value)
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
  await waitFor(client, 'linear-stage app version', `/\\bapp v\\d+\\.\\d+\\b/i.test(document.body.innerText)`, 60000)
}

async function setInputByLabel(client, label, value) {
  const ok = await client.evaluate(`(() => {
    const labelText = ${jsString(label)};
    const value = ${jsString(value)};
    const labelNode = Array.from(document.querySelectorAll('label')).find((item) => item.textContent.trim().replace(/\\s*\\*$/, '') === labelText);
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
  if (!ok) throw new Error(`Input not found: ${label}`)
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

async function setStageClear(client) {
  const checked = await client.evaluate(`(() => {
    const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((item) => item.closest('label')?.innerText.includes('Stage area is clear'));
    if (!checkbox) return false;
    checkbox.scrollIntoView({ block: 'center', inline: 'center' });
    if (!checkbox.checked) checkbox.click();
    return checkbox.checked;
  })()`)
  if (!checked) throw new Error('Stage-clear checkbox not found or not checked.')
}

async function selectLinearStageMode(client, shortLabel) {
  await clickButton(client, shortLabel)
  await waitFor(client, `linear-stage mode ${shortLabel}`, `(() => {
    const text = document.body.innerText;
    return text.includes(${jsString(shortLabel)});
  })()`, 10000)
}

async function resetReviewIfNeeded(client) {
  const clicked = await client.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === 'Next run');
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  })()`)
  if (!clicked) return
  await waitFor(client, 'review reset', `document.body.innerText.includes('Stage area is clear') || document.body.innerText.includes('Confirm stage area')`, 10000)
}

async function saveScreenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000)
  fs.mkdirSync(pathModule.dirname(path), { recursive: true })
  fs.writeFileSync(path, Buffer.from(result.data, 'base64'))
}

function screenshotPathForMode(basePath, modeLabel) {
  const extension = pathModule.extname(basePath) || '.png'
  const withoutExtension = basePath.slice(0, basePath.length - extension.length)
  return `${withoutExtension}-${modeLabel.toLowerCase()}${extension}`
}

async function runMockLinearStageMode(client, modeLabel, expectedSessionType, screenshotPath) {
  await resetReviewIfNeeded(client)
  await selectLinearStageMode(client, modeLabel)
  await setStageClear(client)
  await clickButton(client, 'Confirm readiness')
  await waitFor(client, `start enabled for ${modeLabel}`, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === 'Start test');
    return Boolean(button && !button.disabled);
  })()`, 60000)
  await clickButton(client, 'Start test')
  await waitFor(client, `live feedback visible for ${modeLabel}`, `(() => {
    const text = document.body.innerText;
    return text.includes(${jsString(inProgressText[modeLabel])}) &&
      text.includes('Now') &&
      text.includes('Latest result') &&
      text.includes('Next up') &&
      text.includes('Completed, current, and upcoming firmware phases');
  })()`, 20000)
  await saveScreenshot(client, screenshotPathForMode(screenshotPath, modeLabel))
  await waitFor(client, `final review visible for ${modeLabel}`, `(() => {
    const text = document.body.innerText;
    const flags = {
      hasReview: text.includes('Review result'),
      hasTrace: text.includes('live trace'),
      hasLatestCompleted: text.includes('Latest completed phase'),
      hasCommand: text.includes(${jsString(expectedSessionType)}),
      hasEvidence: text.includes('Evidence review'),
      hasCleanEvidence: text.includes('Clean evidence'),
    };
    return { ok: Object.values(flags).every(Boolean), flags };
  })()`, 60000)
  return await client.evaluate(`(() => {
    const text = document.body.innerText;
    const phaseListStart = text.indexOf('Completed, current, and upcoming firmware phases');
    const phaseListEnd = text.indexOf('Current context', phaseListStart);
    const phaseText = phaseListStart === -1 ? text : text.slice(phaseListStart, phaseListEnd === -1 ? undefined : phaseListEnd);
    const orderedMarkers = [
      'Enable 5V AUX rail',
      'Initialize steppers',
      'X home switch',
      'Optical region selection',
      'Scan audit',
      'Upload',
      'Linear-stage verdict',
    ];
    const markerPositions = Object.fromEntries(orderedMarkers.map((marker) => [marker, phaseText.indexOf(marker)]));
    return {
      mode: ${jsString(modeLabel)},
      sessionType: ${jsString(expectedSessionType)},
      hasCurrentPhase: text.includes('Now'),
      hasLatestResult: text.includes('Latest result'),
      hasNextUp: text.includes('Next up'),
      hasFullPhaseList: text.includes('Completed, current, and upcoming firmware phases'),
      hasFinalTrace: text.includes('live trace'),
      hasCommand: text.includes(${jsString(expectedSessionType)}),
      hasEvidence: text.includes('Evidence review'),
      hasCleanEvidence: text.includes('Clean evidence'),
      phaseNames: Array.from(document.querySelectorAll('[data-linear-stage-phase]')).map((node) => node.getAttribute('data-linear-stage-phase')),
      markerPositions,
      hasMechanicalPhase: phaseText.includes('X home switch'),
      hasOpticalPhase: phaseText.includes('Optical region selection') && phaseText.includes('X focus') && phaseText.includes('Y displacement') && phaseText.includes('Z displacement'),
      hasScanUploadPhase: phaseText.includes('Scan capture') && phaseText.includes('Scan audit') && phaseText.includes('Artifact generation') && phaseText.includes('Upload'),
      hasProductionStress: phaseText.includes('Production workspace stress'),
      excerpt: text.replace(/\\s+/g, ' ').slice(0, 1600),
    };
  })()`)
}

const client = new CdpClient(await getPageWebSocketUrl())

try {
  await client.connect()
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await waitFor(client, 'renderer loaded', `document.readyState === 'complete' && Boolean(window.testingTools)`, 60000)
  await ensureLinearStagePage(client)

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
  await client.evaluate('location.reload()')
  await waitFor(client, 'renderer reloaded', `document.readyState === 'complete' && Boolean(window.testingTools)`, 60000)
  await ensureLinearStagePage(client)

  await selectMuiOption(client, 'Mode', 'Mock')
  await waitFor(client, 'mock mode selected', `(() => {
    const labelNode = Array.from(document.querySelectorAll('label')).find((item) => item.textContent.trim().replace(/\\s*\\*$/, '') === 'Mode');
    const root = labelNode?.closest('.MuiFormControl-root') ?? labelNode?.parentElement;
    return root?.innerText.includes('Mock');
  })()`, 10000)

  await setInputByLabel(client, 'Operator', 'Codex Validation')
  await setInputByLabel(client, 'Batch', 'P1-DEV-2026-05')
  await setInputByLabel(client, 'Tester serial', 'SS-A-001-101A-0013')
  await clickButton(client, 'Connect')
  await waitFor(client, 'clear-stage step visible', `document.body.innerText.includes('Clear stage area') || document.body.innerText.includes('Stage area is clear')`, 60000)
  const modeRuns = [
    ['Production', 'LINEAR_STAGE_COMPREHENSIVE'],
    ['Mechanics', 'LINEAR_STAGE_MECHANICS'],
    ['Optics', 'LINEAR_STAGE_OPTICS'],
  ]
  const results = []
  for (const [modeLabel, expectedCommand] of modeRuns) {
    results.push(await runMockLinearStageMode(client, modeLabel, expectedCommand, screenshotPath))
  }
  const result = { runs: results }
  console.log(JSON.stringify(result, null, 2))
  for (const run of results) {
    if (!run.hasCurrentPhase || !run.hasLatestResult || !run.hasNextUp || !run.hasFullPhaseList || !run.hasFinalTrace || !run.hasCommand || !run.hasEvidence || !run.hasCleanEvidence) {
      throw new Error(`${run.mode} live feedback UI did not expose the expected phase/result context.`)
    }
    if (run.mode === 'Production' && (!run.hasMechanicalPhase || !run.hasOpticalPhase || !run.hasScanUploadPhase || !run.hasProductionStress)) {
      throw new Error('Production mode did not show mechanics, optics, scan/upload, and production stress phases.')
    }
    if (run.mode === 'Mechanics' && (!run.hasMechanicalPhase || run.hasOpticalPhase || run.hasScanUploadPhase)) {
      throw new Error('Mechanics mode did not restrict the phase list to mechanics checks.')
    }
    if (run.mode === 'Optics' && (run.hasMechanicalPhase || !run.hasOpticalPhase || run.hasScanUploadPhase)) {
      throw new Error('Optics mode did not restrict the phase list to optics checks.')
    }
    const expected = expectedPhaseNames[run.mode]
    if (!expected) {
      throw new Error(`Unexpected mode returned by smoke script: ${run.mode}`)
    }
    if (JSON.stringify(run.phaseNames) !== JSON.stringify(expected)) {
      throw new Error(`${run.mode} phase list mismatch.\nExpected: ${expected.join(' | ')}\nActual:   ${(run.phaseNames ?? []).join(' | ')}`)
    }
  }
} finally {
  await client.close().catch(() => undefined)
}
