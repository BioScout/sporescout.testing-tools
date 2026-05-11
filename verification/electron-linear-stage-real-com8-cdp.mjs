import fs from 'node:fs'

const [,, cdpUrl = 'http://127.0.0.1:9224', logPath = 'electron-linear-stage-real-com8-cdp.log'] = process.argv

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
      return label?.innerText.includes('Stage area is clear');
    });
    if (!checkbox) return false;
    checkbox.scrollIntoView({ block: 'center', inline: 'center' });
    if (!checkbox.checked) checkbox.click();
    return checkbox.checked;
  })()`)
  if (!checked) throw new Error('Stage-clear checkbox not found or not checked.')
  log('CHECK Stage area is clear')
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
  await waitFor(client, 'COM8 port listed', `(async () => (await window.testingTools.listSerialPorts()).some((port) => port.path === 'COM8'))()`, 60000)
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

  await clickButton(client, 'Connect')
  await waitFor(client, 'readiness completed', `document.body.innerText.includes('Stage area is clear') || document.body.innerText.includes('Ready to start') || document.body.innerText.includes('Ready to run linear-stage test.')`, 180000, 2000)
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
    return text.includes('Linear-stage test in progress') &&
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
      excerpt: text.replace(/\\s+/g, ' ').slice(0, 1800),
    };
  })()`)
  log(`LIVE_FEEDBACK ${JSON.stringify({ ...liveFeedback, liveStateExcerpt: liveState.bodyExcerpt })}`)
  if (!liveFeedback.hasCurrentPhase) throw new Error('Live phase feedback did not show the current running phase.')
  if (!liveFeedback.hasNextPhase) throw new Error('Live phase feedback did not show the next phase.')
  if (!liveFeedback.hasCompletedList) throw new Error('Live phase feedback did not show the full phase list.')
  if (!liveFeedback.hasLatestResult) throw new Error('Live phase feedback did not show the latest result card.')
  await waitFor(client, 'test finished', `(() => {
    const text = document.body.innerText;
    return text.includes('Review result') && (text.includes('FAIL') || text.includes('PASS') || text.includes('REVIEW'));
  })()`, 1800000, 5000)
  const finalState = await captureState(client, 'final')
  const resultSummary = await client.evaluate(`(() => {
    const text = document.body.innerText;
    const records = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 25).map((row) => row.innerText.replace(/\\s+/g, ' | '));
    return {
      hasFail: text.includes('FAIL'),
      hasPayloadOmittedWarning: text.includes('result payload was not captured') || text.includes('payload was omitted'),
      hasHistogram: text.includes('Measurement histograms') || text.includes('Metric histogram') || text.includes('histogram'),
      hasHistoricalRecords: text.includes('Historical records') || text.includes('Full local retention'),
      hasLiveTrace: text.includes('Linear-stage live trace') && text.includes('Latest completed phase'),
      records,
      finalExcerpt: text.replace(/\\s+/g, ' ').slice(0, 1600),
    };
  })()`)
  log(`RESULT_SUMMARY ${JSON.stringify(resultSummary)}`)
  if (!resultSummary.hasFail) throw new Error('Expected real fixture run to finish with FAIL status.')
  if (resultSummary.hasPayloadOmittedWarning) throw new Error('GUI stopped at omitted payload instead of using the legacy full result.')
  if (!resultSummary.hasHistogram) throw new Error('Expected measurement histogram panel to be visible in the review screen.')
  if (!resultSummary.hasHistoricalRecords) throw new Error('Historical records panel was not visible.')
  if (!resultSummary.hasLiveTrace) throw new Error('Expected final review to preserve the live phase trace.')
  log('Electron linear-stage real COM8 GUI validation complete.')
} finally {
  await client.close().catch(() => undefined)
  logStream.end()
}
