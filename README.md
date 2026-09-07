# jitsi-transcriber

A small Linux CLI that joins a Jitsi room as a visible participant, retries transient
join failures, captures the browser's PulseAudio output, and continuously transcribes
it with whisper.cpp. The Jitsi join logic is adapted from Vexa; see `NOTICE`.

> **Alpha software:** validated in one live `meet.jit.si` meeting. Jitsi UI changes,
> custom deployments, and long-running reconnections still require broader testing.

## Requirements

- Node.js 22+
- Chromium or Google Chrome
- FFmpeg with PulseAudio input support
- PulseAudio or PipeWire's PulseAudio compatibility server (`pactl` must be available)
- `whisper-cli` from whisper.cpp and a GGML model (the local setup below provides both)

## Build and run

```bash
npm install
npm run setup:whisper
npm run build
npm link
jitsi-transcriber join MyRoom
```

For a self-hosted deployment:

```bash
jitsi-transcriber join MyRoom --host https://jitsi.example.org --language en
```

The CLI normally creates a dedicated null sink, routes Chromium into it, and records
its monitor. Override the capture source when needed:

```bash
JITSI_PULSE_SINK=my_sink.monitor jitsi-transcriber join MyRoom --model model.bin
```

Use `--headed` while diagnosing admission or browser compatibility. The transcript is
appended as JSON Lines so a crash or reconnect does not destroy completed segments.
Temporary audio chunks are removed on clean shutdown; pass `--keep-audio` to retain them.

## Current limitations

- Linux and one meeting per process
- Chrome/Chromium plus PulseAudio or PipeWire compatibility required
- Mixed meeting audio; no reliable speaker attribution yet
- Headless mode is implemented but has not completed a live validation run
- The Whisper model is loaded for each chunk; a persistent inference worker is planned

## Verification

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

The setup script pins whisper.cpp and verifies the multilingual model using SHA-256.
