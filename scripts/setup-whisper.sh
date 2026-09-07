#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$project_dir/.deps/whisper.cpp"
whisper_revision="eacbd8234c6654cdbf2c377f72b2106875479bdc"
model_sha256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
vad_model_sha256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$project_dir/.deps"
  git init "$source_dir"
  git -C "$source_dir" remote add origin https://github.com/ggml-org/whisper.cpp.git
fi
git -C "$source_dir" fetch --depth 1 origin "$whisper_revision"
git -C "$source_dir" checkout --detach "$whisper_revision"

cmake --fresh -S "$source_dir" -B "$source_dir/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CCACHE=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$source_dir/build" --config Release -j"$(nproc)"

model="$source_dir/models/ggml-small.bin"
vad_model="$source_dir/models/ggml-silero-v6.2.0.bin"
if [[ ! -f "$model" ]]; then
  bash "$source_dir/models/download-ggml-model.sh" small
fi
printf '%s  %s\n' "$model_sha256" "$model" | sha256sum --check --status || {
  printf 'Downloaded model failed SHA-256 verification: %s\n' "$model" >&2
  exit 1
}
if [[ ! -f "$vad_model" ]]; then
  bash "$source_dir/models/download-vad-model.sh" silero-v6.2.0
fi
printf '%s  %s\n' "$vad_model_sha256" "$vad_model" | sha256sum --check --status || {
  printf 'Downloaded VAD model failed SHA-256 verification: %s\n' "$vad_model" >&2
  exit 1
}

"$source_dir/build/bin/whisper-cli" --help >/dev/null 2>&1
"$source_dir/build/bin/whisper-server" --help >/dev/null 2>&1
printf 'whisper-server: %s\nmodel: %s\nvad model: %s\n' "$source_dir/build/bin/whisper-server" "$model" "$vad_model"
