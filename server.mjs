import http from 'http';
import { URL } from 'url';
import { buildReleaseNotes, updateGoogleDoc } from './release-notes.mjs';


const HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Release Notes Generator</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 800px;
      margin: 48px auto;
      padding: 0 24px;
      background: #f5f5f5;
      color: #222;
    }
    h1 { font-size: 1.4rem; margin-bottom: 24px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; color: #555; }
    input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 1rem;
      font-family: monospace;
      border: 1px solid #ccc;
      border-radius: 6px;
      outline: none;
    }
    input[type="text"]:focus { border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.15); }
    button {
      margin-top: 10px;
      padding: 10px 24px;
      font-size: 0.95rem;
      font-weight: 600;
      background: #0066cc;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: #0055aa; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    #output {
      margin-top: 20px;
      padding: 14px 16px;
      background: #1e1e1e;
      color: #d4d4d4;
      border-radius: 6px;
      min-height: 220px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 0.83rem;
      line-height: 1.6;
      overflow-y: auto;
      max-height: 520px;
      display: none;
    }
    .line-done  { color: #4ec9b0; font-weight: bold; }
    .line-error { color: #f44747; font-weight: bold; }
    .line-warn  { color: #dcdcaa; }
    #docLink {
      margin-top: 14px;
      padding: 12px 16px;
      background: #e6f4ea;
      border: 1px solid #a8d5b0;
      border-radius: 6px;
      font-size: 0.95rem;
      display: none;
    }
    #docLink a { color: #0a6640; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Release Notes Generator</h1>

  <label for="tagInput">Tag wersji</label>
  <input id="tagInput" type="text" placeholder="uat-version-20260316185950" autocomplete="off" spellcheck="false" />
  <br>
  <button id="runBtn" onclick="runGeneration()">Generuj</button>

  <div id="output"></div>
  <div id="docLink"></div>

  <script>
    function runGeneration() {
      const tag = document.getElementById('tagInput').value.trim();
      if (!tag) { alert('Wklej tag wersji.'); return; }

      const output  = document.getElementById('output');
      const btn     = document.getElementById('runBtn');
      const docLink = document.getElementById('docLink');

      output.innerHTML = '';
      output.style.display = 'block';
      docLink.style.display = 'none';
      btn.disabled = true;

      const evtSource = new EventSource('/run?tag=' + encodeURIComponent(tag));

      evtSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg === '[END]') {
          evtSource.close();
          btn.disabled = false;
          return;
        }

        const line = document.createElement('div');
        line.textContent = msg;

        if (msg.startsWith('[DONE]')) {
          line.className = 'line-done';
          const url = msg.slice('[DONE] '.length).trim();
          docLink.innerHTML = 'Dokument gotowy: <a href="' + url + '" target="_blank">' + url + '</a>';
          docLink.style.display = 'block';
        } else if (msg.startsWith('[ERROR]')) {
          line.className = 'line-error';
        } else if (msg.startsWith('[WARN]')) {
          line.className = 'line-warn';
        }

        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
      };

      evtSource.onerror = () => {
        const line = document.createElement('div');
        line.className = 'line-error';
        line.textContent = '[BŁĄD POŁĄCZENIA] Strumień zerwany.';
        output.appendChild(line);
        evtSource.close();
        btn.disabled = false;
      };
    }

    document.getElementById('tagInput')
      .addEventListener('keydown', e => { if (e.key === 'Enter') runGeneration(); });
  </script>
</body>
</html>`;

let isRunning = false;

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/run') {
    const tag = reqUrl.searchParams.get('tag')?.trim();

    if (!tag) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Brak parametru tag');
      return;
    }

    if (isRunning) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('Generowanie już w toku');
      return;
    }

    isRunning = true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);

    const origLog  = console.log;
    const origWarn = console.warn;
    console.log  = (...args) => { origLog(...args);  send(args.join(' ')); };
    console.warn = (...args) => { origWarn(...args); send('[WARN] ' + args.join(' ')); };

    try {
      const data = await buildReleaseNotes(tag);
      await updateGoogleDoc(data);
      const docUrl = `https://docs.google.com/document/d/${process.env.GOOGLE_DOC_ID}/edit`;
      send(`[DONE] ${docUrl}`);
    } catch (err) {
      send(`[ERROR] ${err.message}`);
    } finally {
      console.log  = origLog;
      console.warn = origWarn;
      isRunning = false;
      res.write('data: "[END]"\n\n');
      res.end();
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

server.listen(PORT, () => {
  if (BASE_URL) {
    console.log(`\nRelease Notes UI: ${BASE_URL}\n`);
  } else {
    console.log(`\nRelease Notes UI: http://localhost:${PORT}\n`);
  }
});
