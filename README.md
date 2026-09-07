# Jitscribe

[![CI](https://github.com/tritao/jitscribe/actions/workflows/ci.yml/badge.svg)](https://github.com/tritao/jitscribe/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Jitscribe is a local-first Jitsi meeting bot. Start it with a meeting URL and it
joins as a visible participant, captures the room audio, and writes a live JSONL
transcript using a local Whisper worker.

```bash
jitscribe join https://meet.jit.si/YourRoom
```

Audio and transcripts stay on the machine running Jitscribe. The only network
connections are to the Jitsi deployment you provide and the one-time model
downloads during setup.

> **Alpha software:** the end-to-end path works against controlled
> `meet.jit.si` rooms, but long-running meetings, self-hosted deployments, and
> difficult overlapping speech still need broader validation.

## Highlights

- **One command to run:** join by complete URL or by room name.
- **Local transcription:** pinned [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
  with the multilingual `small` model and Silero VAD.
- **Receive-only bot:** the browser joins muted and does not publish a camera or
  microphone stream.
- **Resilient joining:** lobby admission, room passwords, disconnect detection,
  and exponential reconnect retries.
- **Clean audio path:** Chromium is routed through a dedicated PulseAudio sink;
  FFmpeg captures 16 kHz mono chunks.
- **Speaker hints:** Jitsi dominant-speaker events are aligned with Whisper word
  timestamps through a lag-aware binder, with confidence and ambiguity status.
- **Stable records:** session-scoped segment IDs, overlap watermarks, and
  append-only JSONL output make downstream ingestion straightforward.
- **Headless by default:** use `--headed` when diagnosing a room or browser
  compatibility issue.

## Requirements

Jitscribe currently supports Linux only:

- Node.js 22 or newer
- Chromium or Google Chrome
- CMake and a C/C++ compiler
- FFmpeg with PulseAudio input support
- PulseAudio, or PipeWire's PulseAudio compatibility layer
- `pactl`, Git, curl, and a working user audio session

On Ubuntu 24.04, the system packages are:

```bash
sudo apt install build-essential ca-certificates cmake curl ffmpeg git \
  libpulse0 pulseaudio-utils
```

Install Node.js 22+ and Chromium/Chrome separately if they are not already
available. The bootstrap script checks for both and never replaces an existing
installation.

## Quick start

Clone the repository, then let the bootstrap script install dependencies, build
Whisper, download and verify the models, compile Jitscribe, and create the
`jitscribe` command:

```bash
git clone https://github.com/tritao/jitscribe.git
cd jitscribe
bash scripts/bootstrap.sh
```

The initial Whisper setup downloads approximately 465 MB for the main model and
the VAD model. Both files are verified with SHA-256. The bootstrap script is safe
to rerun; it refreshes JavaScript dependencies from the lockfile and reuses an
existing Whisper build/model:

```bash
bash scripts/bootstrap.sh --dry-run       # show commands only
bash scripts/bootstrap.sh --skip-system   # dependencies are already installed
bash scripts/bootstrap.sh --skip-whisper  # defer the model build/download
bash scripts/bootstrap.sh --no-link       # do not create a global npm link
```

The equivalent manual setup is:

```bash
npm ci
npm run setup:whisper
npm run build
npm link
```

The first setup builds a pinned whisper.cpp revision and downloads the
multilingual `small` model plus Silero VAD. The main download is approximately
465 MB; both files are verified with SHA-256.

Verify the installation:

```bash
jitscribe --help
```

## Join a meeting

Pass a complete URL:

```bash
jitscribe join https://meet.jit.si/YourRoom
```

Or pass a room name, which defaults to `https://meet.jit.si`:

```bash
jitscribe join YourRoom
```

For a self-hosted deployment:

```bash
jitscribe join YourRoom --host https://jitsi.example.org
```

The bot appears as `Transcription Bot` and may need to be admitted by a
moderator. Set a different visible name with `--name`:

```bash
jitscribe join YourRoom --name "Meeting Notes"
```

Use `Ctrl-C` to leave the room and flush the final transcript window.

For browser or admission diagnostics, show Chromium:

```bash
jitscribe join YourRoom --headed --verbose
```

## Command-line options

```text
--host URL                 Host for a bare room id (default: meet.jit.si)
--name NAME                Visible participant name
--password PASSWORD        Password for a protected room
--output FILE.jsonl        Transcript destination
--audio FILE.wav           Audio output base name
--language CODE            auto, en, pt, ...
--chunk-seconds N          Transcription interval (default: 15)
--overlap-seconds N        Boundary overlap (default: 2)
--max-retries N            Rejoin attempts (default: 10)
--admission-timeout N      Lobby timeout in seconds (default: 300)
--browser PATH             Chromium/Chrome executable override
--whisper PATH             whisper-server executable override
--transcriber server|native Transcription backend (default: server)
--model PATH               GGML model override
--vad-model PATH           Silero VAD model override
--keep-audio               Retain temporary WAV chunks
--verbose                  Show browser/audio/Whisper diagnostics
--log-format text|json     Lifecycle log format (default: text)
--headed                   Show the browser window
```

By default, `YourRoom` produces `YourRoom.jsonl`. Temporary WAV chunks are
deleted after a clean shutdown; use `--keep-audio` while debugging capture.

## Transcript format

Each line is an independently durable JSON object:

```json
{"sessionId":"6c9e7a9f-8f3d-4c0c-a3a4-8e5c9e98fabc","segmentId":"6c9e7a9f-8f3d-4c0c-a3a4-8e5c9e98fabc:chunk-000000:turn-0000-0000","revision":0,"timestamp":"2026-09-02T11:39:36.105Z","start":"2026-09-02T11:39:34.105Z","end":"2026-09-02T11:39:36.000Z","speaker":"Alice","speakerId":"participant-id","speakerConfidence":0.8,"speakerStatus":"attributed","text":"Hello. How are you?","chunk":0}
```

- `sessionId` identifies one process run.
- `segmentId` is stable within that session and encodes the source chunk,
  Whisper item, and speaker-turn position.
- `revision` is currently always `0`; it is reserved for future correction or
  upsert records.
- `speakerStatus` can be `attributed`, `ambiguous`, or `unknown`.
- `speakerConfidence` is best-effort evidence from Jitsi's dominant-speaker
  signal, not diarization certainty.

Adjacent audio windows overlap by two seconds. Watermarks delay boundary speech
until the next window and prevent duplicate segment output.

## Architecture

```text
Jitsi room
    ↓
Chromium controlled through Playwright
    ↓
Dedicated PulseAudio null sink
    ↓
FFmpeg 16 kHz mono chunks
    ↓
Overlapping windows + Silero VAD
    ↓
Persistent local whisper.cpp worker
    ↓
Speaker hint binder + Whisper word timestamps
    ↓
Append-only JSONL transcript
```

The join and admission flow is adapted from Vexa's isolated Jitsi join module.
The speaker tracker emits start, heartbeat, and end events; the local binder
lag-corrects those events, rejects short flickers, and marks competing evidence
ambiguous. See [NOTICE](NOTICE) for the exact upstream attribution and license.

## Privacy and consent

Jitscribe is designed for local processing: it does not upload recordings or
transcripts and has no telemetry. It does connect to the supplied Jitsi host and
downloads the Whisper models during initial setup.

The bot is deliberately visible in the participant list. Notify participants and
obtain any consent required by local law or organizational policy before
recording or transcribing a meeting. Avoid putting reusable meeting passwords in
shell history; this alpha accepts `--password` on the command line only.

## Current limitations

- Linux only; one meeting per process.
- Speaker attribution is based on Jitsi's dominant-speaker hints. It is useful
  for clear turn-taking but can be ambiguous during overlap or rapid turns.
- There are no diarizer cluster IDs or mutable late-repaint updates yet; an
  unresolved turn remains `unknown`.
- Authenticated Jitsi deployments and per-participant audio lanes are not yet
  supported.
- The persistent Whisper worker processes one chunk at a time, so output arrives
  after each configured interval rather than word-by-word.
- Jitsi UI changes may require selector updates.

## Development

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

The tests cover argument parsing, URL construction, speaker lifecycle and
binding, overlap/watermark behavior, and a mocked headless join-to-transcript
flow. GitHub Actions runs these checks on every push and pull request. Live
browser tests require a controlled Jitsi room and are not run against public
rooms automatically.

Changes to joining, admission, audio routing, or reconnect behavior should be
validated against a controlled room before release. Do not commit models, audio,
recordings, transcripts, credentials, or meeting URLs; see
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Experimental native audio addon

The repository contains an experimental Rust/CPAL audio engine exposed through
Node-API. It is not enabled by the main CLI yet; the existing FFmpeg path remains
the validated default. Build and test the addon locally with Rust installed:

```bash
npm run test:native
npm run build:native
node -e "const a = require('./native/jitscribe-audio-napi/index.cjs'); console.log(a.listAudioDevices())"
```

The addon currently emits normalized 16 kHz PCM events and device metadata. It
does not yet provide platform-specific application isolation or ship prebuilt
artifacts for every operating system. Those are the next steps before enabling
`--audio-backend native`.

### Experimental in-process Whisper backend

`native/jitscribe-whisper-core` is a separate Rust crate that uses
[`whisper-cpp-plus`](https://github.com/operator-kit/whisper-cpp-plus-rs) to
consume the same normalized PCM and return timestamped segments. It builds as
part of `npm run test:native` and is available through the opt-in native CLI
backend. The default server path remains unchanged, so we can benchmark it
against the current persistent `whisper-server` worker without changing the
production path. The crate currently expects a GGML model and
does not load or download models itself. Its segments now include Whisper token
timestamps grouped into word records (`from_ms`, `to_ms`, `text`, and
`probability`), matching the data needed by Jitscribe's speaker binder.

The backend can be selected for a live run after building the addon:

```bash
npm run build:native
jitscribe join ROOM --transcriber native --language en
```

This keeps the same FFmpeg recorder, overlap handling, transcript schema, and
speaker binder. Native mode currently does not use the Silero VAD model, so
`--vad-model` is only used by the default server backend. The default remains
`server` until longer live-room comparisons are complete.

Run the headless native benchmark against a 16 kHz mono PCM16 WAV:

```bash
npm run bench:whisper-native -- \
  .deps/whisper.cpp/models/ggml-small.bin \
  path/to/chunk-000000.wav en > native-result.json
```

The command emits JSON containing elapsed time, full text, timestamped segments,
and word records, making it suitable for comparing the native result with the
existing Whisper worker on the same fixture.

## License and attribution

Jitscribe is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). It includes portions adapted from
[Vexa](https://github.com/Vexa-ai/vexa), also under Apache-2.0.
