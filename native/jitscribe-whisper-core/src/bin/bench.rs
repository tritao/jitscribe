use jitscribe_whisper_core::{pcm_i16_to_f32, WhisperTranscriber};
use serde::Serialize;
use std::{env, fs, path::Path, time::Instant};

#[derive(Serialize)]
struct Report {
    backend: &'static str,
    model: String,
    audio: String,
    sample_rate: u32,
    channels: u16,
    samples: usize,
    elapsed_ms: u128,
    transcription: jitscribe_whisper_core::Transcription,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 || args.len() > 4 {
        eprintln!("usage: jitscribe-whisper-bench MODEL.bin AUDIO.wav [LANGUAGE]");
        std::process::exit(2);
    }
    let model = &args[1];
    let audio = &args[2];
    let language = args.get(3).map(String::as_str).unwrap_or("en");
    let (sample_rate, channels, samples) = read_pcm_wav(Path::new(audio))?;
    if sample_rate != 16_000 || channels != 1 {
        return Err(
            format!("expected 16 kHz mono WAV, got {sample_rate} Hz/{channels} channels").into(),
        );
    }
    let transcriber = WhisperTranscriber::new(model)?.with_language(language);
    let started = Instant::now();
    let transcription = transcriber.transcribe(&pcm_i16_to_f32(&samples))?;
    let report = Report {
        backend: "whisper-cpp-plus",
        model: model.clone(),
        audio: audio.clone(),
        sample_rate,
        channels,
        samples: samples.len(),
        elapsed_ms: started.elapsed().as_millis(),
        transcription,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn read_pcm_wav(path: &Path) -> Result<(u32, u16, Vec<i16>), Box<dyn std::error::Error>> {
    let bytes = fs::read(path)?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into()?) as usize;
        offset += 8;
        if offset + size > bytes.len() {
            return Err("truncated WAV chunk".into());
        }
        match id {
            b"fmt " if size >= 16 => {
                let audio_format = u16::from_le_bytes(bytes[offset..offset + 2].try_into()?);
                let channels = u16::from_le_bytes(bytes[offset + 2..offset + 4].try_into()?);
                let sample_rate = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into()?);
                let bits = u16::from_le_bytes(bytes[offset + 14..offset + 16].try_into()?);
                if audio_format != 1 || bits != 16 {
                    return Err("WAV must contain PCM16 audio".into());
                }
                format = Some((sample_rate, channels));
            }
            b"data" => data = Some(&bytes[offset..offset + size]),
            _ => {}
        }
        offset += size + (size % 2);
    }
    let (sample_rate, channels) = format.ok_or("WAV fmt chunk missing")?;
    let raw = data.ok_or("WAV data chunk missing")?;
    if raw.len() % 2 != 0 {
        return Err("odd PCM data length".into());
    }
    let samples = raw
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    Ok((sample_rate, channels, samples))
}
