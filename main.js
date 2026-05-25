const {
  app, BrowserWindow, Tray, Menu,
  globalShortcut, ipcMain, clipboard,
  nativeImage, screen, shell
} = require('electron');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');

let mainWindow        = null;
let pipWindow         = null;
let tray              = null;
let isCollapsed       = false;
let cursorInterval    = null;
let clipboardInterval = null;
let lastClipboardText = '';
let whisperProc = null;

// ── Windows ──────────────────────────────────────────────────────────────────

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 300, height: 500,
    x: sw - 320, y: 20,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    loadNotes();
    mainWindow.webContents.send('window:state', 'expanded');
  });
}

function createPipWindow() {
  pipWindow = new BrowserWindow({
    width: 44, height: 44,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    level: 'screen-saver',
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  pipWindow.loadFile(path.join(__dirname, 'pip.html'));
  pipWindow.hide();
  pipWindow.on('closed', () => { pipWindow = null; });
}

// ── Expand / Collapse ────────────────────────────────────────────────────────

function expand() {
  if (!isCollapsed) return;
  isCollapsed = false;

  stopCursorTracking();
  if (pipWindow) pipWindow.hide();

  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setSize(300, 500);
  mainWindow.setPosition(sw - 320, 20);
  mainWindow.setResizable(true);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('window:state', 'expanded');
}

function collapse() {
  if (isCollapsed) return;
  isCollapsed = true;

  mainWindow.hide();
  if (pipWindow) pipWindow.show();
  startCursorTracking();
}

function toggle() { isCollapsed ? expand() : collapse(); }

// ── Cursor tracking ──────────────────────────────────────────────────────────

function startCursorTracking() {
  stopCursorTracking();
  cursorInterval = setInterval(() => {
    if (!pipWindow || pipWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    pipWindow.setPosition(p.x + 16, p.y + 16);
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

// ── Whisper (local speech-to-text) ───────────────────────────────────────────

function startWhisper() {
  // When packaged, use the PyInstaller-built binary bundled in Resources/transcribe/.
  // In dev, fall back to venv python or system python3.
  let cmd, args;
  if (app.isPackaged) {
    cmd  = path.join(process.resourcesPath, 'transcribe', 'transcribe');
    args = [];
  } else {
    const venvPy = path.join(__dirname, 'venv', 'bin', 'python3');
    cmd  = fs.existsSync(venvPy) ? venvPy : 'python3';
    args = [path.join(__dirname, 'transcribe.py')];
  }

  whisperProc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
      if (t.startsWith('WAKE')) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const conf = parseFloat(t.split(' ')[1]) || 0;
          mainWindow.webContents.send('whisper:wake', conf);
        }
        continue;
      }
      if (t.startsWith('RESULT')) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const text = t.slice(6).trim();
          mainWindow.webContents.send('whisper:result', text);
        }
        continue;
      }
      if (t.startsWith('PARTIAL')) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const text = t.slice(7).trim();
          mainWindow.webContents.send('whisper:partial', text);
        }
        continue;
      }
    }
  });

  whisperProc.stderr.on('data', d => console.log('[whisper]', d.toString().trim()));
  whisperProc.on('exit', () => { whisperProc = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  createPipWindow();
  createTray();
  registerHotkey();
  startClipboardWatcher();
  startWhisper();

  app.on('activate', () => { if (mainWindow) { expand(); } });
});

app.on('before-quit', () => {
  if (clipboardInterval) clearInterval(clipboardInterval);
  if (cursorInterval)    clearInterval(cursorInterval);
  if (whisperProc)       whisperProc.kill();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
