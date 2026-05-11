const [,, cdpUrl = 'http://127.0.0.1:9224'] = process.argv

const targets = await fetch(`${cdpUrl}/json`).then((response) => response.json())
const target = targets.find((item) => item.type === 'page' && String(item.url).includes('/admin/linear-stage')) ?? targets.find((item) => item.type === 'page')
if (!target?.webSocketDebuggerUrl) throw new Error('No page target.')

let nextId = 1
const pending = new Map()
const socket = new WebSocket(target.webSocketDebuggerUrl)
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

const result = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1800),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })).filter((button) => button.text),
    inputs: Array.from(document.querySelectorAll('input')).map((input) => ({ type: input.type, value: input.value, checked: input.checked })).slice(0, 20),
  }))()`,
})

console.log(JSON.stringify(result.result.value, null, 2))
socket.close()
