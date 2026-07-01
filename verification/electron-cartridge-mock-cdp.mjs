import fs from 'node:fs'
import path from 'node:path'

const [, , cdpUrl = 'http://127.0.0.1:9231', screenshotPath = 'output/cartridge-mock-smoke.png'] = process.argv

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jsString(value) {
  return JSON.stringify(value)
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

async function saveScreenshot(client, targetPath) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64'))
}

const client = new CdpClient(await getPageWebSocketUrl())
await client.connect()

try {
  await client.send('Page.enable')
  await waitFor(client, 'cartridge page shell', `Boolean(document.body?.innerText.includes('SporeScout Cartridge Subassembly Tester'))`)

  await waitFor(client, 'cartridge controls', `(() => {
    const text = document.body?.innerText.toLowerCase() ?? '';
    return [
      'operator-guided cartridge leak characterization.',
      'operator',
      'batch',
      'tester serial',
      'enclosure base id',
      'nozzle id',
      'seal id',
      'connect tester',
      'insert cartridge',
      'current run',
      'cartridge history',
    ].every((label) => text.includes(label)) && /\bapp v\d+\.\d+\b/.test(text);
  })()`)

  const expectedHistoryText = (process.env.SPORESCOUT_EXPECT_HISTORY_TEXT ?? '')
    .split('|')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (expectedHistoryText.length) {
    await waitFor(client, 'seeded cartridge history rows', `(() => {
      const text = document.body?.innerText.toLowerCase() ?? '';
      return ${jsString(expectedHistoryText)}.every((label) => text.includes(label));
    })()`)
    await client.evaluate(`(() => {
      const expected = ${jsString(expectedHistoryText[0] ?? '')};
      const elements = Array.from(document.querySelectorAll('*'));
      const target = elements.find((element) =>
        element.children.length === 0 &&
        element.textContent?.toLowerCase().includes(expected)
      ) ?? elements.find((element) => element.textContent?.toLowerCase().includes('cartridge history'));
      target?.scrollIntoView({ block: 'center' });
      return Boolean(target);
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  await saveScreenshot(client, screenshotPath)
  const body = await client.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1200)`)
  console.log(JSON.stringify({ ok: true, screenshotPath, body }))
} finally {
  await client.close()
}
