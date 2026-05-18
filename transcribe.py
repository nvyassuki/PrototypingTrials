#!/usr/bin/env python3
# transcribe.py — Python owns the full voice pipeline:
#   mic capture → voice activity detection → Whisper → print transcript
# This bypasses Electron's microphone permission issue entirely.
# Electron reads transcripts from stdout, one line per utterance.

import sys
import threading
import warnings
import numpy as np
warnings.filterwarnings("ignore")

import sounddevice as sd
import whisper

SAMPLE_RATE     = 16000
CHUNK_SIZE      = 800          # 50 ms per chunk
VAD_THRESHOLD   = 0.01         # RMS level considered "speaking"
SILENCE_CHUNKS  = 18           # ~900 ms of silence ends an utterance
MAX_CHUNKS      = 200          # ~10 s max utterance length

model = whisper.load_model("tiny")
print("READY", flush=True)

# Shared state between the audio callback and transcription thread.
audio_buffer  = []
silence_count = 0
is_speaking   = False
lock          = threading.Lock()


def transcribe(chunks):
    audio = np.concatenate(chunks).astype(np.float32)
    # Whisper expects float32 PCM at 16 kHz, values in [-1, 1].
    result = model.transcribe(audio, language="en", fp16=False)
    text   = result["text"].strip()
    print(text if text else "EMPTY", flush=True)


def audio_callback(indata, frames, time_info, status):
    global audio_buffer, silence_count, is_speaking

    chunk = indata[:, 0].copy()
    rms   = float(np.sqrt(np.mean(chunk ** 2)))

    with lock:
        if rms > VAD_THRESHOLD:
            is_speaking    = True
            silence_count  = 0
            audio_buffer.append(chunk)
        elif is_speaking:
            silence_count += 1
            audio_buffer.append(chunk)

            if silence_count >= SILENCE_CHUNKS or len(audio_buffer) >= MAX_CHUNKS:
                segment      = list(audio_buffer)
                audio_buffer  = []
                is_speaking   = False
                silence_count = 0
                threading.Thread(target=transcribe, args=(segment,), daemon=True).start()


# Open the mic stream and keep it running until the process is killed.
with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                    blocksize=CHUNK_SIZE, callback=audio_callback):
    sys.stdin.read()   # block until Electron closes stdin (app quit)
