use std::sync::Mutex;

use jitscribe_audio_core::{self as core, CaptureEvent, CaptureOptions};
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
