const {
  app, BrowserWindow, Tray, Menu,
  globalShortcut, ipcMain, clipboard,
  nativeImage, screen, shell, session
} = require('electron');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const os        = require('os');
const { spawn } = require('child_process');

let mainWindow        = null;
let tray              = null;
let serverPort        = null;
let isCollapsed       = false;
let cursorInterval    = null;
let clipboardInterval = null;
let lastClipboardText = '';
let whisperProc = null;

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 300, height: 500,
    x: sw - 320, y: 20,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    level: 'floating',
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  mainWindow.webContents.on('did-finish-load', () => {
    loadNotes();
    mainWindow.webContents.send('window:state', 'expanded');
  });
}

// ── Expand / Collapse ────────────────────────────────────────────────────────

function expand() {
  if (!isCollapsed) return;
  isCollapsed = false;

  stopCursorTracking();
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setAlwaysOnTop(true, 'floating');

  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setSize(300, 500);
  mainWindow.setPosition(sw - 320, 20);
  mainWindow.setResizable(true);
  mainWindow.focus();
  mainWindow.webContents.send('window:state', 'expanded');
}

function collapse() {
  if (isCollapsed) return;
  isCollapsed = true;

  mainWindow.setResizable(false);
  mainWindow.setSize(44, 44);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  startCursorTracking();
  mainWindow.webContents.send('window:state', 'collapsed');
}

function toggle() { isCollapsed ? expand() : collapse(); }

// ── Cursor tracking ──────────────────────────────────────────────────────────

function startCursorTracking() {
  stopCursorTracking();
  cursorInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    mainWindow.setPosition(p.x + 16, p.y + 16);
  }, 50);
}

function stopCursorTracking() {
  if (cursorInterval) { clearInterval(cursorInterval); cursorInterval = null; }
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const size = 16;
  const buf  = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    buf[o] = 245; buf[o+1] = 230; buf[o+2] = 66; buf[o+3] = 255;
  }
  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip('FloatNote');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Panel',     click: expand   },
    { label: 'Collapse',       click: collapse  },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggle);
}

// ── Hotkey ───────────────────────────────────────────────────────────────────

function registerHotkey() {
  const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const ok  = globalShortcut.register(`${mod}+Shift+Space`, toggle);
  if (!ok) console.warn('FloatNote: could not register hotkey — it may be taken by another app');
}

// ── Clipboard watcher ────────────────────────────────────────────────────────

function startClipboardWatcher() {
  try { lastClipboardText = clipboard.readText(); } catch (e) {}

  clipboardInterval = setInterval(() => {
    try {
      const current = clipboard.readText();
      if (current !== lastClipboardText && current.trim()) {
        lastClipboardText = current;
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('clipboard:new', current);
      }
    } catch (e) {}
  }, 1000);
}

// ── Notes persistence ────────────────────────────────────────────────────────

function getNotesPath() {
  return path.join(app.getPath('userData'), 'notes.json');
}

function loadNotes() {
  try {
    const notes = JSON.parse(fs.readFileSync(getNotesPath(), 'utf8'));
    mainWindow.webContents.send('notes:loaded', notes);
  } catch (e) {
    mainWindow.webContents.send('notes:loaded', []);
  }
}

ipcMain.on('notes:save',      (_, notes) => { try { fs.writeFileSync(getNotesPath(), JSON.stringify(notes, null, 2)); } catch(e){} });
ipcMain.on('clipboard:skip',  (_, text)  => { lastClipboardText = text; });
ipcMain.on('shell:open',      (_, url)   => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('window:expand',   ()         => expand());
ipcMain.on('window:collapse', ()         => collapse());
ipcMain.on('window:hide',     ()         => { if (mainWindow) mainWindow.hide(); });

// ── Local HTTP server (needed for microphone API) ────────────────────────────

function createLocalServer() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

  const server = http.createServer((req, res) => {
    const urlPath  = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(__dirname, urlPath);
    try {
      res.setHeader('Content-Type', mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      res.end(fs.readFileSync(filePath));
    } catch (e) { res.writeHead(404); res.end('Not found'); }
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); }));
}

// ── Whisper (local speech-to-text) ───────────────────────────────────────────

function startWhisper() {
  const scriptPath = path.join(__dirname, 'transcribe.py');
  const venvPy     = path.join(__dirname, 'venv', 'bin', 'python3');
  const py         = fs.existsSync(venvPy) ? venvPy : 'python3';

  whisperProc = spawn(py, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

  let lineBuf = '';
  whisperProc.stdout.on('data', chunk => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t === 'READY') {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('whisper:ready');
        continue;
      }
      // Forward every transcript to the renderer.
      if (t !== 'EMPTY' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whisper:transcript', t);
      }
    }
  });

  whisperProc.stderr.on('data', d => console.log('[whisper]', d.toString().trim()));
  whisperProc.on('exit', () => { whisperProc = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await createLocalServer();

  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' ? true : null);

  createWindow();
  createTray();
  registerHotkey();
  startClipboardWatcher();
  startWhisper();

  app.on('activate', () => { if (mainWindow) { mainWindow.show(); expand(); } });
});

app.on('before-quit', () => {
  if (clipboardInterval) clearInterval(clipboardInterval);
  if (cursorInterval)    clearInterval(cursorInterval);
  if (whisperProc)       whisperProc.kill();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
