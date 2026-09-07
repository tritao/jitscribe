# Jitscribe

Jitscribe sends a visible bot into a Jitsi meeting and writes a live, local
transcript. Meeting audio stays on your computer and is transcribed offline with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp).

```bash
jitscribe join https://meet.jit.si/YourRoom
```

Jitscribe is early alpha software. It has completed a real `meet.jit.si` join and
local transcription test, but needs broader testing across long meetings and
self-hosted Jitsi deployments.

## What it does

- Joins a Jitsi room as a named, receive-only participant
- Waits in the lobby for admission and supports room passwords
- Retries transient join and connection failures with exponential backoff
- Isolates Chromium audio from other desktop audio
- Transcribes locally with the multilingual Whisper `small` model
- Appends completed segments to a crash-resistant JSONL file
- Adds best-effort speaker names from Jitsi's dominant-speaker state
- Uses Whisper word timestamps to split a transcript when speakers change
- Runs with headless Chromium by default

## Requirements

Jitscribe currently targets Linux and requires:

- Node.js 22 or newer
- Chromium or Google Chrome
- CMake and a C/C++ compiler
- FFmpeg with PulseAudio input support
- PulseAudio, or PipeWire's PulseAudio compatibility layer
- `pactl`, Git and curl

On Ubuntu 24.04, most system dependencies can be installed with:

```bash
sudo apt install build-essential cmake curl ffmpeg git libpulse0 pulseaudio-utils
```

Install Chrome or Chromium separately if neither is already available.

## Install from source

```bash
git clone <repository-url> jitscribe
cd jitscribe
npm ci
npm run setup:whisper
npm run build
npm link
```

`setup:whisper` builds a pinned whisper.cpp revision and downloads the multilingual
`small` model plus the Silero VAD model. The main download is approximately 465 MB;
both files are verified with SHA-256.

Verify the installation:

```bash
jitscribe --help
```

## Join a meeting

Pass a complete Jitsi URL:

```bash
jitscribe join https://meet.jit.si/YourRoom
```

Or pass a room name, which defaults to `meet.jit.si`:

```bash
jitscribe join YourRoom
```

For a self-hosted deployment:

```bash
jitscribe join YourRoom --host https://jitsi.example.org
```

Jitscribe appears in the participant list as `Transcription Bot`. A moderator may
need to admit it. To use a different visible name:

```bash
jitscribe join YourRoom --name "Meeting Notes"
```

Use `Ctrl+C` to leave the room and stop transcription.

## Common options

```text
--name NAME                Visible participant name
--password PASSWORD        Password for a protected room
--language CODE            Whisper language: auto, en, pt, ...
--output FILE.jsonl        Transcript destination
--chunk-seconds N          Transcription interval; default 15
--overlap-seconds N        Boundary overlap; default 2
--max-retries N            Maximum rejoin attempts; default 10
--admission-timeout N      Lobby timeout in seconds; default 300
--headed                   Display Chromium for diagnosis
--keep-audio               Retain temporary WAV chunks
--verbose                  Show diagnostic subprocess logs
--log-format text|json     Lifecycle log format
--browser PATH             Override Chrome/Chromium executable
--whisper PATH             Override whisper-server
--model PATH               Override the GGML model
--vad-model PATH           Override the Silero VAD model
```

Use a visible browser when diagnosing admission or Jitsi compatibility:

```bash
jitscribe join YourRoom --headed
```

## Output

By default, a room called `YourRoom` produces `YourRoom.jsonl`. Each line is an
independently durable JSON object:

```json
{"timestamp":"2026-09-02T11:39:36.105Z","start":"2026-09-02T11:39:34.105Z","end":"2026-09-02T11:39:36.000Z","speaker":"Alice","speakerId":"participant-id","speakerConfidence":0.8,"speakerStatus":"attributed","text":"Hello. How are you?","chunk":0}
```

Temporary WAV chunks are deleted after a clean shutdown. Add `--keep-audio` when
debugging capture or transcription.

Adjacent windows overlap by two seconds. Segments near a boundary are delayed until
the next window, then absolute timestamp watermarks prevent duplicate output.

## How it works

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
JSONL transcript
```

The Jitsi navigation and admission behavior is adapted from Vexa's isolated join
module. See [NOTICE](NOTICE) for the pinned upstream revision and attribution.

## Privacy and consent

Audio is processed locally; Jitscribe does not upload recordings or transcripts.
It does connect to the supplied Jitsi deployment and downloads the Whisper model
during initial setup.

The bot is deliberately visible in the meeting. You are responsible for notifying
participants and obtaining any consent required by local law or organizational policy.

Never place meeting passwords directly in shell history on a shared system. Prefer
rooms without reusable passwords while this alpha only accepts `--password` on the
command line.

## Limitations

- Linux only
- One meeting per process
- Speaker attribution is best-effort: it aligns Whisper words with Jitsi's
  dominant-speaker signal and can be ambiguous during overlap or rapid turns
- Headless mode is implemented but has not completed a live validation run
- The persistent Whisper worker handles one audio chunk at a time, so output arrives
  after each configured chunk interval rather than word-by-word
- Jitsi interface changes may require selector updates
- Authenticated Jitsi deployments are not yet supported

## Development

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

CI runs the same checks on Ubuntu 24.04. Live browser tests require a controlled
Jitsi room and are not run against public rooms automatically.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
