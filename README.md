# FloatNote 🐰

A lightweight floating sticky-note panel for macOS that lives on top of all your windows. Type notes, capture clipboard snippets, and add notes hands-free with your voice — all without leaving your workflow.

---

## Features

- **Always-on-top panel** — floats over every app, pinned to the top-right of your screen
- **Clipboard watcher** — automatically captures anything you copy into a note
- **Voice commands** — say *"Hey Bunny"* to activate, then dictate a note hands-free
- **Inline editing** — click any note to edit it in place
- **Pin notes** — keep important notes at the top of the list
- **Search** — filter notes instantly
- **Undo deletes** — 3-second window to undo an accidental deletion
- **Collapse to pip** — shrinks to a pixel bunny that follows your cursor; expand with `Cmd+Shift+Space`
- **Persistent storage** — notes survive restarts

---

## Installation (from source)

### Prerequisites

- Node.js 18+
- Python 3.13 (via Homebrew: `brew install python@3.13`)
- PortAudio (`brew install portaudio`)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/nvyassuki/PrototypingTrials.git
cd PrototypingTrials

# 2. Install Node dependencies
npm install

# 3. Create Python venv and install voice dependencies
python3.13 -m venv venv
source venv/bin/activate
pip install faster-whisper livekit-wakeword sounddevice

# 4. Run
npm start
```

---

## Usage

| Action | How |
|---|---|
| Add a note | Type in the input box → press **Enter** |
| New line in note | **Shift+Enter** |
| Edit a note | Click the note text |
| Delete a note | Click **×** on the card |
| Undo delete | Click **Undo** in the toast (3s window) |
| Pin a note | Click the bookmark icon on the card |
| Copy a note | Click the copy icon on the card |
| Search | Click the 🔍 icon or type in the search bar |
| Collapse to bunny | **Cmd+Shift+Space** |
| Expand from bunny | **Cmd+Shift+Space** (anywhere) |
| Hide panel | Click **−** in the title bar |
| Voice note | Say **"Hey Bunny"** → *"note [your note]"* |

### Voice commands

Once the voice dot turns idle (solid grey), the wake word is active:

| Say | Effect |
|---|---|
| *"Hey Bunny… note buy milk"* | Adds "buy milk" as a voice note |
| *"Hey Bunny… remember call dentist"* | Adds "call dentist" |
| *"Hey Bunny… hide"* | Collapses the panel |

> **First launch note:** The Whisper `small.en` model (~500 MB) downloads from HuggingFace on the first run. The voice dot will pulse until it's ready — this is normal and only happens once.

---

## Building a macOS DMG

To distribute FloatNote as a standalone `.app` / `.dmg` (no Python required for end users):

```bash
# 1. Bundle the Python voice pipeline with PyInstaller
source venv/bin/activate
pip install pyinstaller

pyinstaller --onedir transcribe.py \
  --add-data "bunny.onnx:." \
  --add-data "hey_livekit.onnx:." \
  --hidden-import sounddevice \
  --name transcribe \
  --distpath dist/transcribe_bundle

# 2. Build the DMG
npm run build:mac
```

The DMG will be at `dist/FloatNote-1.0.0-arm64.dmg`.

> **Distributing without a paid Apple Developer certificate:**  
> The app is unsigned. Users need to right-click → **Open** on first launch to bypass Gatekeeper. Include this note when sharing.

---

## Project structure

```
floatnote/
├── main.js          # Electron main process (window, tray, IPC, clipboard, Whisper)
├── preload.js       # Context bridge (exposes safe IPC to renderer)
├── renderer.js      # UI logic (notes, search, voice reactions)
├── index.html       # Main panel markup
├── pip.html         # Minimal pip window (just the bunny, transparent)
├── style.css        # All styles
├── transcribe.py    # Python voice pipeline (wake word + Whisper transcription)
├── bunny.onnx       # Custom "Hey Bunny" wake-word model
├── hey_livekit.onnx # LiveKit base wake-word model
└── bunny-pip.png    # Pixel bunny icon (transparent background)
```

---

## Voice pipeline

```
Microphone (sounddevice)
    ↓
Wake-word detection (livekit-wakeword + bunny.onnx)
    ↓  "Hey Bunny" detected
Command capture (VAD — silence detection)
    ↓
Transcription (faster-whisper small.en, CPU/int8)
    ↓
IPC → Electron renderer → createNote()
```

The Python process runs as a child of Electron and communicates over stdout (line-based protocol: `READY`, `WAKE`, `PARTIAL`, `RESULT`).

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 30 |
| Voice pipeline | Python 3.13, faster-whisper, livekit-wakeword, sounddevice |
| Wake-word model | Custom ONNX model trained on "Hey Bunny" |
| Transcription | OpenAI Whisper `small.en` (via faster-whisper, CPU int8) |
| Packaging | electron-builder, PyInstaller |
