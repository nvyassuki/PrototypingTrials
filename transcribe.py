#!/usr/bin/env python3
# Voice pipeline: mic → livekit-wakeword (wake on "hey livekit") → faster-whisper for the command.
#
# Protocol on stdout (one line each):
#   READY            once at startup, after models load
#   WAKE <conf>      wake word detected; Electron shows the "Listening…" banner
#   PARTIAL <text>   incremental transcript while the user is still speaking
#   RESULT <text>    final transcript when the user stops (empty = nothing heard)

import sys
import threading
from collections import deque
from pathlib import Path

import numpy as np
import sounddevice as sd
import warnings
warnings.filterwarnings("ignore")

from faster_whisper import WhisperModel
from livekit.wakeword import WakeWordModel

# ── Audio / wake-word config ─────────────────────────────────────────────────

SAMPLE_RATE      = 16000
FRAME_SAMPLES    = 1280            # 80ms per audio callback frame (matches listener)
WAKE_WINDOW_SEC  = 2.0             # rolling window fed to the wake-word model
WAKE_FRAMES      = int(WAKE_WINDOW_SEC * SAMPLE_RATE / FRAME_SAMPLES)
WAKE_THRESHOLD   = 0.5             # raise if false positives; lower if it misses you
WAKE_INFER_EVERY = 2               # run wake inference every Nth frame (~160ms)
DEBOUNCE_FRAMES  = int(2.0 * SAMPLE_RATE / FRAME_SAMPLES)  # ignore wake for 2s after firing

# ── Command-capture VAD ──────────────────────────────────────────────────────

VAD_THRESHOLD    = 0.01            # RMS level considered "speaking"
SILENCE_FRAMES   = int(1.0 * SAMPLE_RATE / FRAME_SAMPLES)   # ~1s silence ends the command (after speech started)
MAX_CMD_FRAMES   = int(10.0 * SAMPLE_RATE / FRAME_SAMPLES)  # 10s hard cap once speech starts
NO_SPEECH_GIVEUP = int(5.0 * SAMPLE_RATE / FRAME_SAMPLES)   # 5s total wait if no speech ever happens
PRE_WAKE_FRAMES  = int(0.3 * SAMPLE_RATE / FRAME_SAMPLES)   # 300ms pre-roll before wake fires

# ── Models ───────────────────────────────────────────────────────────────────

HERE         = Path(__file__).parent
WAKE_MODEL   = HERE / "hey_livekit.onnx"

wake_model = WakeWordModel(models=[str(WAKE_MODEL)])
# small.en: English-only, ~244M params, much better accuracy than tiny.
# int8 keeps it fast on CPU (Apple Silicon CTranslate2 has no GPU path).
whisper_model = WhisperModel("small.en", device="cpu", compute_type="int8")
print("READY", flush=True)

# ── State ────────────────────────────────────────────────────────────────────

state          = "WAITING"   # or "CAPTURING"
frame_counter  = 0
debounce       = 0
wake_buffer    = deque(maxlen=WAKE_FRAMES)
preroll_buffer = deque(maxlen=PRE_WAKE_FRAMES)
command_chunks = []
silence_count  = 0
heard_speech   = False
state_lock     = threading.Lock()

# Partial-transcript machinery
PARTIAL_INTERVAL_FRAMES = int(0.6 * SAMPLE_RATE / FRAME_SAMPLES)  # ~600ms cadence
PARTIAL_MIN_FRAMES      = int(0.8 * SAMPLE_RATE / FRAME_SAMPLES)  # need ≥800ms before first partial
whisper_lock     = threading.Lock()   # only one whisper call at a time
_partial_running = False
_partial_last_at = 0   # length of command_chunks when last partial fired

WAKE_KEY = next(iter(wake_model._classifiers.keys()))  # "hey_livekit"


def _run_whisper(audio: np.ndarray) -> str:
    # faster-whisper returns a generator of segments; join their text.
    segments, _ = whisper_model.transcribe(
        audio, language="en", beam_size=1, vad_filter=False
    )
    return " ".join(seg.text for seg in segments).strip()


def transcribe(chunks, had_speech):
    global state, debounce
    text = ""
    if had_speech and chunks:
        audio = np.concatenate(chunks).astype(np.float32)
        with whisper_lock:
            text = _run_whisper(audio)
    print(f"RESULT {text}", flush=True)
    with state_lock:
        state = "WAITING"
        debounce = DEBOUNCE_FRAMES
        wake_buffer.clear()
        preroll_buffer.clear()


def partial_transcribe(snapshot):
    global _partial_running
    try:
        audio = np.concatenate(snapshot).astype(np.float32)
        with whisper_lock:
            text = _run_whisper(audio)
        if text:
            print(f"PARTIAL {text}", flush=True)
    except Exception as e:
        print(f"[partial err] {e}", file=sys.stderr, flush=True)
    finally:
        _partial_running = False


def audio_callback(indata, frames, time_info, status):
    global state, frame_counter, debounce, silence_count, command_chunks, heard_speech
    global _partial_running, _partial_last_at

    chunk = indata[:, 0].copy()
    frame_counter += 1

    with state_lock:
        if state == "TRANSCRIBING":
            # Final transcribe in flight; drop audio until it returns to WAITING.
            return

        if state == "WAITING":
            preroll_buffer.append(chunk)
            wake_buffer.append(chunk)

            if debounce > 0:
                debounce -= 1
                return

            if len(wake_buffer) < WAKE_FRAMES:
                return
            if frame_counter % WAKE_INFER_EVERY != 0:
                return

            window = np.concatenate(wake_buffer).astype(np.float32)
            scores = wake_model.predict(window)
            conf   = scores.get(WAKE_KEY, 0.0)
            if conf > WAKE_THRESHOLD:
                print(f"WAKE {conf:.2f}", flush=True)
                state            = "CAPTURING"
                command_chunks   = list(preroll_buffer)  # include pre-roll
                silence_count    = 0
                heard_speech     = False
                _partial_last_at = 0
                wake_buffer.clear()

        else:  # CAPTURING
            command_chunks.append(chunk)
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            if rms > VAD_THRESHOLD:
                silence_count = 0
                heard_speech  = True
            else:
                silence_count += 1

            # Kick off a partial transcript every ~600ms once speech has started.
            if (heard_speech and not _partial_running
                    and len(command_chunks) >= PARTIAL_MIN_FRAMES
                    and len(command_chunks) - _partial_last_at >= PARTIAL_INTERVAL_FRAMES):
                _partial_running = True
                _partial_last_at = len(command_chunks)
                snapshot = list(command_chunks)
                threading.Thread(target=partial_transcribe, args=(snapshot,), daemon=True).start()

            # End conditions:
            #   - heard speech + 1s of silence after it (natural endpoint), OR
            #   - heard speech + 10s hard cap, OR
            #   - no speech at all + 5s of total waiting (give up)
            ended_after_speech = heard_speech and silence_count >= SILENCE_FRAMES
            ended_by_length    = heard_speech and len(command_chunks) >= MAX_CMD_FRAMES
            gave_up            = not heard_speech and len(command_chunks) >= NO_SPEECH_GIVEUP
            if ended_after_speech or ended_by_length or gave_up:
                segment        = command_chunks
                had_speech     = heard_speech
                command_chunks = []
                state          = "TRANSCRIBING"
                threading.Thread(target=transcribe, args=(segment, had_speech), daemon=True).start()


with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                    blocksize=FRAME_SAMPLES, callback=audio_callback):
    sys.stdin.read()  # block until Electron closes stdin (app quit)
