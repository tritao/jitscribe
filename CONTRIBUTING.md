# Contributing

Install Node.js 22 or newer, then run:

```bash
npm ci
npm test
npm run build
```

Browser behavior should have deterministic unit coverage where possible. Changes to
joining, admission, audio routing, or reconnection should also be validated against a
controlled Jitsi meeting before release. Do not commit models, build dependencies,
recordings, transcripts, or meeting credentials.
