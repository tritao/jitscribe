use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub input_channels: u16,
    pub output_channels: u16,
}

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub host: Option<String>,
    pub device_id: Option<String>,
    pub sample_rate: u32,
    pub channels: u16,
    pub chunk_ms: u32,
    pub queue_capacity: usize,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            host: None,
            device_id: None,
            sample_rate: 16_000,
            channels: 1,
            chunk_ms: 250,
            queue_capacity: 32,
        }
    }
}

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    Ready {
        sample_rate: u32,
        channels: u16,
        started_at_ms: u64,
    },
    Pcm {
        sequence: u64,
        started_at_ms: u64,
        sample_rate: u32,
        channels: u16,
        samples: Vec<i16>,
    },
    Discontinuity {
        dropped_samples: u64,
        timestamp_ms: u64,
    },
    Error {
        message: String,
        recoverable: bool,
    },
    Stopped,
}

pub struct CaptureSession {
    events: Receiver<CaptureEvent>,
    stop: Arc<Mutex<bool>>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureSession {
    pub fn try_next(&self) -> Result<Option<CaptureEvent>, String> {
        match self.events.try_recv() {
            Ok(event) => Ok(Some(event)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Ok(Some(CaptureEvent::Stopped)),
        }
    }

    pub fn stop(mut self) {
        if let Ok(mut stopping) = self.stop.lock() {
            *stopping = true;
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        if let Ok(mut stopping) = self.stop.lock() {
            *stopping = true;
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[allow(deprecated)]
pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let mut devices = Vec::new();
    for host_id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(host_id) else {
            continue;
        };
        let all = host
            .devices()
            .map_err(|error| format!("cannot enumerate {host_id} devices: {error}"))?;
        for device in all {
            let name = device
                .description()
                .map(|description| description.to_string())
                .unwrap_or_else(|_| "unknown".to_owned());
            let id = device
                .id()
                .map(|value| value.to_string())
                .unwrap_or_else(|_| name.clone());
            let input_channels = device
                .default_input_config()
                .map(|config| config.channels())
                .unwrap_or(0);
            let output_channels = device
                .default_output_config()
                .map(|config| config.channels())
                .unwrap_or(0);
            devices.push(DeviceInfo {
                id,
                name,
                input_channels,
                output_channels,
            });
        }
    }
    Ok(devices)
}

pub fn start_capture(options: CaptureOptions) -> Result<CaptureSession, String> {
    if options.sample_rate == 0 || options.channels == 0 || options.chunk_ms == 0 {
        return Err("sample rate, channels, and chunk duration must be positive".to_owned());
    }
    if options.queue_capacity == 0 {
        return Err("queue capacity must be positive".to_owned());
    }

    let host = select_host(options.host.as_deref())?;
    let device = select_device(&host, options.device_id.as_deref())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("cannot read audio configuration: {error}"))?;
    let native_rate = supported.sample_rate();
    let native_channels = supported.channels();
    let config: cpal::StreamConfig = supported.clone().into();
    let (event_sender, events) = mpsc::sync_channel(options.queue_capacity);
    let stop = Arc::new(Mutex::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("jitscribe-audio".to_owned())
        .spawn(move || {
            capture_thread(
                device,
                supported.sample_format(),
                config,
                native_rate,
                native_channels,
                options,
                event_sender,
                stop_for_thread,
            );
        })
        .map_err(|error| format!("cannot start audio thread: {error}"))?;
    Ok(CaptureSession {
        events,
        stop,
        thread: Some(thread),
    })
}

fn select_host(requested: Option<&str>) -> Result<cpal::Host, String> {
    let Some(requested) = requested else {
        return Ok(cpal::default_host());
    };
    let host_id: cpal::HostId = requested
        .parse()
        .map_err(|_| format!("unknown audio host: {requested}"))?;
    cpal::host_from_id(host_id)
        .map_err(|error| format!("cannot open audio host {requested}: {error}"))
}

#[allow(deprecated)]
fn select_device(host: &cpal::Host, requested_id: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(requested_id) = requested_id {
        let device = host
            .devices()
            .map_err(|error| format!("cannot enumerate audio devices: {error}"))?
            .find(|device| {
                let id = device
                    .id()
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                let name = device
                    .description()
                    .map(|description| description.to_string())
                    .unwrap_or_default();
                id == requested_id || name == requested_id
            });
        return device.ok_or_else(|| format!("audio device not found: {requested_id}"));
    }

    #[cfg(target_os = "windows")]
    let device = host.default_output_device();
    #[cfg(not(target_os = "windows"))]
    let device = host.default_input_device();
    device.ok_or_else(|| "no suitable default audio device is available".to_owned())
}

fn capture_thread(
    device: cpal::Device,
    sample_format: cpal::SampleFormat,
    config: cpal::StreamConfig,
    native_rate: u32,
    native_channels: u16,
    options: CaptureOptions,
    sender: SyncSender<CaptureEvent>,
    stop: Arc<Mutex<bool>>,
) {
    let started_at_ms = now_ms();
    let _ = sender.send(CaptureEvent::Ready {
        sample_rate: options.sample_rate,
        channels: options.channels,
        started_at_ms,
    });

    let target_frames =
        ((options.sample_rate as u64 * options.chunk_ms as u64) / 1000).max(1) as usize;
    let mut processor = Processor::new(
        options.sample_rate,
        options.channels,
        target_frames,
        started_at_ms,
    );
    let stop_for_callback = Arc::clone(&stop);
    let sender_for_callback = sender.clone();
    let error_sender = sender.clone();
    let error_callback = move |error: cpal::Error| {
        let _ = error_sender.try_send(CaptureEvent::Error {
            message: error.to_string(),
            recoverable: true,
        });
    };

    let stream_result = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config.clone(),
            move |data: &[f32], _| {
                push_samples(
                    data,
                    native_channels,
                    native_rate,
                    &mut processor,
                    &sender_for_callback,
                    &stop_for_callback,
                );
            },
            error_callback,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config.clone(),
            move |data: &[i16], _| {
                let converted: Vec<f32> = data
                    .iter()
                    .map(|sample| *sample as f32 / i16::MAX as f32)
                    .collect();
                push_samples(
                    &converted,
                    native_channels,
                    native_rate,
                    &mut processor,
                    &sender_for_callback,
                    &stop_for_callback,
                );
            },
            error_callback,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                let converted: Vec<f32> = data
                    .iter()
                    .map(|sample| (*sample as f32 - 32768.0) / 32768.0)
                    .collect();
                push_samples(
                    &converted,
                    native_channels,
                    native_rate,
                    &mut processor,
                    &sender_for_callback,
                    &stop_for_callback,
                );
            },
            error_callback,
            None,
        ),
        format => {
            let _ = sender.send(CaptureEvent::Error {
                message: format!("unsupported audio sample format: {format:?}"),
                recoverable: false,
            });
            return;
        }
    };

    let stream = match stream_result {
        Ok(stream) => stream,
        Err(error) => {
            let _ = sender.send(CaptureEvent::Error {
                message: format!("cannot open audio stream: {error}"),
                recoverable: false,
            });
            return;
        }
    };
    if let Err(error) = stream.play() {
        let _ = sender.send(CaptureEvent::Error {
            message: format!("cannot start audio stream: {error}"),
            recoverable: false,
        });
        return;
    }
    while !is_stopping(&stop) {
        thread::sleep(Duration::from_millis(25));
    }
    drop(stream);
    let _ = sender.send(CaptureEvent::Stopped);
}

fn push_samples(
    interleaved: &[f32],
    native_channels: u16,
    native_rate: u32,
    processor: &mut Processor,
    sender: &SyncSender<CaptureEvent>,
    stop: &Arc<Mutex<bool>>,
) {
    if is_stopping(stop) {
        return;
    }
    let channels = native_channels.max(1) as usize;
    for frame in interleaved.chunks(channels) {
        let average = frame.iter().copied().sum::<f32>() / frame.len() as f32;
        processor.push(average, native_rate, sender);
    }
}

struct Processor {
    output_rate: u32,
    output_channels: u16,
    target_frames: usize,
    sequence: u64,
    samples: Vec<i16>,
    next_timestamp_ms: u64,
    resample_phase: u64,
}

impl Processor {
    fn new(
        output_rate: u32,
        output_channels: u16,
        target_frames: usize,
        started_at_ms: u64,
    ) -> Self {
        Self {
            output_rate,
            output_channels,
            target_frames,
            sequence: 0,
            samples: Vec::with_capacity(target_frames * output_channels as usize),
            next_timestamp_ms: started_at_ms,
            resample_phase: 0,
        }
    }

    fn push(&mut self, sample: f32, native_rate: u32, sender: &SyncSender<CaptureEvent>) {
        // A bounded nearest-neighbour resampler keeps this first vertical slice
        // dependency-free. Replace it with a quality resampler before release.
        self.resample_phase += self.output_rate as u64;
        while self.resample_phase >= native_rate as u64 {
            self.resample_phase -= native_rate as u64;
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            for _ in 0..self.output_channels {
                self.samples.push(value);
            }
            if self.samples.len() >= self.target_frames * self.output_channels as usize {
                let samples = std::mem::replace(
                    &mut self.samples,
                    Vec::with_capacity(self.target_frames * self.output_channels as usize),
                );
                let duration_ms = self.target_frames as u64 * 1000 / self.output_rate as u64;
                let event = CaptureEvent::Pcm {
                    sequence: self.sequence,
                    started_at_ms: self.next_timestamp_ms,
                    sample_rate: self.output_rate,
                    channels: self.output_channels,
                    samples,
                };
                self.sequence += 1;
                self.next_timestamp_ms += duration_ms;
                if sender.try_send(event).is_err() {
                    let _ = sender.try_send(CaptureEvent::Discontinuity {
                        dropped_samples: self.target_frames as u64,
                        timestamp_ms: self.next_timestamp_ms,
                    });
                }
            }
        }
    }
}

fn is_stopping(stop: &Arc<Mutex<bool>>) -> bool {
    stop.lock().map(|value| *value).unwrap_or(true)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_whisper_friendly() {
        let options = CaptureOptions::default();
        assert_eq!(options.sample_rate, 16_000);
        assert_eq!(options.channels, 1);
        assert_eq!(options.chunk_ms, 250);
    }

    #[test]
    fn processor_emits_fixed_size_chunks() {
        let (sender, receiver) = mpsc::sync_channel(4);
        let mut processor = Processor::new(16_000, 1, 4, 100);
        for _ in 0..4 {
            processor.push(0.25, 16_000, &sender);
        }
        match receiver.try_recv().expect("chunk") {
            CaptureEvent::Pcm {
                sequence,
                started_at_ms,
                samples,
                ..
            } => {
                assert_eq!(sequence, 0);
                assert_eq!(started_at_ms, 100);
                assert_eq!(samples.len(), 4);
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }
}
