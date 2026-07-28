const express = require('express');
const EventEmitter = require('events');
const app = express();
const PORT = 3000;

// === Эмиттер BAC событий ===
class BACEmitter extends EventEmitter {}
const bac = new BACEmitter();

// === Эмуляция ивентов BAC раз в 2 секунды ===
setInterval(() => {
  const event = { timestamp: new Date(), value: Math.random().toFixed(4) };
  bac.emit('data', event);
}, 2000);

// === SSE endpoint для фронта ===
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Подписываем клиента на BAC
  bac.on('data', sendEvent);

  // Удаляем подписку при отключении
  req.on('close', () => {
    bac.off('data', sendEvent);
    res.end();
  });
});

// === Встроенная HTML страница ===
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head><title>BAC Stream</title></head>
<body>
  <h1>BAC Events Stream</h1>
  <pre id="log"></pre>
  <script>
    const log = document.getElementById('log');
    const source = new EventSource('/stream');
    source.onmessage = function(event) {
      const data = JSON.parse(event.data);
      console.log("BAC Event:", data);
      log.textContent += "\\n" + JSON.stringify(data);
    };
  </script>
</body>
</html>
  `);
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
