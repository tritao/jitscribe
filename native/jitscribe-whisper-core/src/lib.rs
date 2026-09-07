//! Experimental in-process Whisper inference.
//!
//! This crate deliberately has no audio-device or Node-API concerns. Callers
//! provide normalized 16 kHz mono PCM and receive timestamped segments. That
//! makes it possible to compare this backend with the existing
//! process-backed `whisper-server` implementation before changing the CLI.

use serde::Serialize;
use whisper_cpp_plus::{TranscriptionParams, WhisperContext, WhisperError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
        let mut builder = TranscriptionParams::builder().enable_timestamps();
        if let Some(language) = self.language.as_deref() {
            builder = builder.language(language);
        }
        let result = self
            .context
            .transcribe_with_params(samples, builder.build())?;
        Ok(Transcription {
            text: result.text,
            segments: result
                .segments
                .into_iter()
                .map(|segment| Segment {
                    // whisper.cpp timestamps are in 10 ms ticks. The
                    // upstream crate names these fields `*_ms` but returns
                    // the raw tick values.
                    start_ms: whisper_timestamp_to_ms(segment.start_ms),
                    end_ms: whisper_timestamp_to_ms(segment.end_ms),
                    text: segment.text,
                })
                .collect(),
        })
    }
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
