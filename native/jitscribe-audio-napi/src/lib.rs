use std::sync::Mutex;

use jitscribe_audio_core::{self as core, CaptureEvent, CaptureOptions};
use jitscribe_whisper_core::{self as whisper, WhisperTranscriber as CoreWhisperTranscriber};
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[derive(Clone)]
#[napi(object)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub input_channels: u16,
    pub output_channels: u16,
}

#[derive(Clone)]
#[napi(object)]
pub struct AudioCaptureOptions {
    pub host: Option<String>,
    pub device_id: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub chunk_ms: Option<u32>,
    pub queue_capacity: Option<u32>,
}

#[napi(object)]
pub struct AudioEvent {
    pub kind: String,
    pub sequence: Option<u32>,
    pub started_at_ms: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub samples: Option<Buffer>,
    pub dropped_samples: Option<String>,
    pub timestamp_ms: Option<String>,
    pub message: Option<String>,
    pub recoverable: Option<bool>,
}

#[derive(Clone)]
#[napi(object)]
pub struct WhisperWord {
    pub from_ms: f64,
    pub to_ms: f64,
    pub text: String,
    pub probability: f64,
}

#[derive(Clone)]
#[napi(object)]
pub struct WhisperSegment {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    pub words: Vec<WhisperWord>,
}

#[napi(object)]
pub struct WhisperResult {
    pub text: String,
    pub segments: Vec<WhisperSegment>,
}

#[napi]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>> {
    core::list_devices()
        .map(|devices| {
            devices
                .into_iter()
                .map(|device| AudioDevice {
                    id: device.id,
                    name: device.name,
                    input_channels: device.input_channels,
                    output_channels: device.output_channels,
                })
                .collect()
        })
        .map_err(Error::from_reason)
}

#[napi]
pub struct AudioCapture {
    session: Mutex<Option<core::CaptureSession>>,
}

#[napi]
impl AudioCapture {
    #[napi(factory)]
    pub fn start(options: Option<AudioCaptureOptions>) -> Result<Self> {
        let options = options.unwrap_or(AudioCaptureOptions {
            host: None,
            device_id: None,
            sample_rate: None,
            channels: None,
            chunk_ms: None,
            queue_capacity: None,
        });
        let defaults = CaptureOptions::default();
        let session = core::start_capture(CaptureOptions {
            host: options.host,
            device_id: options.device_id,
            sample_rate: options.sample_rate.unwrap_or(defaults.sample_rate),
            channels: options.channels.unwrap_or(defaults.channels),
            chunk_ms: options.chunk_ms.unwrap_or(defaults.chunk_ms),
            queue_capacity: options
                .queue_capacity
                .unwrap_or(defaults.queue_capacity as u32) as usize,
        })
        .map_err(Error::from_reason)?;
        Ok(Self {
            session: Mutex::new(Some(session)),
        })
    }

    #[napi]
    pub fn poll(&self) -> Result<Option<AudioEvent>> {
        let guard = self
            .session
            .lock()
            .map_err(|_| Error::from_reason("audio session lock poisoned"))?;
        let Some(session) = guard.as_ref() else {
            return Ok(Some(stopped_event()));
        };
        session
            .try_next()
            .map(|event| event.map(to_event))
            .map_err(Error::from_reason)
    }

    #[napi]
    pub fn stop(&self) -> Result<()> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| Error::from_reason("audio session lock poisoned"))?;
        if let Some(session) = guard.take() {
            session.stop();
        }
        Ok(())
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.session.lock() {
            if let Some(session) = guard.take() {
                session.stop();
            }
        }
    }
}

/// Persistent in-process Whisper model. This is intentionally separate from
/// AudioCapture so callers can feed recorder chunks or another PCM source.
#[napi]
pub struct WhisperTranscriber {
    inner: Mutex<CoreWhisperTranscriber>,
}

#[napi]
impl WhisperTranscriber {
    #[napi(constructor)]
    pub fn new(model_path: String, language: Option<String>) -> Result<Self> {
        let transcriber = CoreWhisperTranscriber::new(model_path)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let transcriber = match language {
            Some(value) => transcriber.with_language(value),
            None => transcriber,
        };
        Ok(Self {
            inner: Mutex::new(transcriber),
        })
    }

    #[napi]
    pub fn transcribe(&self, pcm_i16_le: Buffer) -> Result<WhisperResult> {
        if pcm_i16_le.len() % 2 != 0 {
            return Err(Error::from_reason("PCM buffer must contain 16-bit samples"));
        }
        let samples: Vec<i16> = pcm_i16_le
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        let samples = whisper::pcm_i16_to_f32(&samples);
        let transcriber = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("Whisper model lock poisoned"))?;
        let result = transcriber
            .transcribe(&samples)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(WhisperResult {
            text: result.text,
            segments: result
                .segments
                .into_iter()
                .map(|segment| WhisperSegment {
                    start_ms: segment.start_ms as f64,
                    end_ms: segment.end_ms as f64,
                    text: segment.text,
                    words: segment
                        .words
                        .into_iter()
                        .map(|word| WhisperWord {
                            from_ms: word.from_ms as f64,
                            to_ms: word.to_ms as f64,
                            text: word.text,
                            probability: f64::from(word.probability),
                        })
                        .collect(),
                })
                .collect(),
        })
    }
}

fn to_event(event: CaptureEvent) -> AudioEvent {
    match event {
        CaptureEvent::Ready {
            sample_rate,
            channels,
            started_at_ms,
        } => AudioEvent {
            kind: "ready".to_owned(),
            sequence: None,
            started_at_ms: Some(started_at_ms.to_string()),
            sample_rate: Some(sample_rate),
            channels: Some(channels),
            samples: None,
            dropped_samples: None,
            timestamp_ms: None,
            message: None,
            recoverable: None,
        },
        CaptureEvent::Pcm {
            sequence,
            started_at_ms,
            sample_rate,
            channels,
            samples,
        } => {
            let mut bytes = Vec::with_capacity(samples.len() * 2);
            for sample in samples {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            AudioEvent {
                kind: "pcm".to_owned(),
                sequence: Some(sequence as u32),
                started_at_ms: Some(started_at_ms.to_string()),
                sample_rate: Some(sample_rate),
                channels: Some(channels),
                samples: Some(bytes.into()),
                dropped_samples: None,
                timestamp_ms: None,
                message: None,
                recoverable: None,
            }
        }
        CaptureEvent::Discontinuity {
            dropped_samples,
            timestamp_ms,
        } => AudioEvent {
            kind: "discontinuity".to_owned(),
            sequence: None,
            started_at_ms: None,
            sample_rate: None,
            channels: None,
            samples: None,
            dropped_samples: Some(dropped_samples.to_string()),
            timestamp_ms: Some(timestamp_ms.to_string()),
            message: None,
            recoverable: None,
        },
        CaptureEvent::Error {
            message,
            recoverable,
        } => AudioEvent {
            kind: "error".to_owned(),
            sequence: None,
            started_at_ms: None,
            sample_rate: None,
            channels: None,
            samples: None,
            dropped_samples: None,
            timestamp_ms: None,
            message: Some(message),
            recoverable: Some(recoverable),
        },
        CaptureEvent::Stopped => stopped_event(),
    }
}

fn stopped_event() -> AudioEvent {
    AudioEvent {
        kind: "stopped".to_owned(),
        sequence: None,
        started_at_ms: None,
        sample_rate: None,
        channels: None,
        samples: None,
        dropped_samples: None,
        timestamp_ms: None,
        message: None,
        recoverable: None,
    }
}
