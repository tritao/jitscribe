//! Experimental in-process Whisper inference.
//!
//! This crate deliberately has no audio-device or Node-API concerns. Callers
//! provide normalized 16 kHz mono PCM and receive timestamped segments. That
//! makes it possible to compare this backend with the existing
//! process-backed `whisper-server` implementation before changing the CLI.

use serde::Serialize;
use whisper_cpp_plus::{FullParams, SamplingStrategy, WhisperContext, WhisperError};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Word {
    pub from_ms: i64,
    pub to_ms: i64,
    pub text: String,
    pub probability: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcription {
    pub text: String,
    pub segments: Vec<Segment>,
}

pub struct WhisperTranscriber {
    context: WhisperContext,
    language: Option<String>,
}

impl WhisperTranscriber {
    pub fn new(model_path: impl AsRef<std::path::Path>) -> Result<Self, WhisperError> {
        Ok(Self {
            context: WhisperContext::new(model_path.as_ref())?,
            language: None,
        })
    }

    pub fn with_language(mut self, language: impl Into<String>) -> Self {
        self.language = Some(language.into());
        self
    }

    /// Transcribe normalized mono PCM samples at 16 kHz.
    pub fn transcribe(&self, samples: &[f32]) -> Result<Transcription, WhisperError> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 })
            .no_timestamps(false)
            .token_timestamps(true)
            .split_on_word(true);
        if let Some(language) = self.language.as_deref() {
            params = params.language(language);
        }
        let mut state = self.context.create_state()?;
        state.full(params, samples)?;
        let n_segments = state.full_n_segments();
        let mut segments = Vec::with_capacity(n_segments as usize);
        let mut full_text = String::new();
        for segment_index in 0..n_segments {
            let text = state.full_get_segment_text(segment_index)?;
            let (start_ticks, end_ticks) = state.full_get_segment_timestamps(segment_index);
            let words = extract_words(&state, segment_index)?;
            if segment_index > 0 {
                full_text.push(' ');
            }
            full_text.push_str(&text);
            segments.push(Segment {
                start_ms: whisper_timestamp_to_ms(start_ticks),
                end_ms: whisper_timestamp_to_ms(end_ticks),
                text,
                words,
            });
        }
        Ok(Transcription {
            text: full_text,
            segments,
        })
    }
}

fn extract_words(
    state: &whisper_cpp_plus::WhisperState,
    segment_index: i32,
) -> Result<Vec<Word>, WhisperError> {
    let mut words = Vec::new();
    let mut current: Option<Word> = None;
    for token_index in 0..state.full_n_tokens(segment_index) {
        let token_text = state.full_get_token_text(segment_index, token_index)?;
        let Some(data) = state.full_get_token_data(segment_index, token_index) else {
            continue;
        };
        if token_text.starts_with("[_") && token_text.ends_with("]") {
            continue;
        }
        let from_ms = whisper_timestamp_to_ms(data.t0);
        let to_ms = whisper_timestamp_to_ms(data.t1.max(data.t0));
        let has_boundary = token_text.chars().next().is_some_and(char::is_whitespace);
        for (piece_index, text) in token_text.split_whitespace().enumerate() {
            if has_boundary || piece_index > 0 {
                if let Some(word) = current.take() {
                    words.push(word);
                }
            }
            match current.as_mut() {
                Some(word) => {
                    word.text.push_str(text);
                    word.to_ms = to_ms;
                    word.probability = data.p;
                }
                None => {
                    current = Some(Word {
                        from_ms,
                        to_ms,
                        text: text.to_owned(),
                        probability: data.p,
                    });
                }
            }
        }
    }
    if let Some(word) = current {
        words.push(word);
    }
    Ok(words)
}

/// Convert signed 16-bit PCM to the f32 representation expected by Whisper.
pub fn pcm_i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| f32::from(*sample) / 32768.0)
        .collect()
}

fn whisper_timestamp_to_ms(ticks: i64) -> i64 {
    ticks * 10
}

#[cfg(test)]
mod tests {
    use super::{pcm_i16_to_f32, whisper_timestamp_to_ms};

    #[test]
    fn converts_pcm_without_clipping() {
        let converted = pcm_i16_to_f32(&[-32768, -16384, 0, 16384, 32767]);
        assert_eq!(converted[0], -1.0);
        assert_eq!(converted[2], 0.0);
        assert!((converted[4] - 0.9999695).abs() < 0.000001);
    }

    #[test]
    fn converts_whisper_ten_millisecond_ticks() {
        assert_eq!(whisper_timestamp_to_ms(110), 1_100);
    }
}
