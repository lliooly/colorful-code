export type VoiceAudioChunk = {
  audio: string;
  sampleRate: number;
  numChannels: number;
};

export type VoiceRecorder = {
  stop: () => Promise<void>;
};

export type StartVoiceRecorderOptions = {
  targetSampleRate?: number;
  onChunk: (chunk: VoiceAudioChunk) => void | Promise<void>;
};

const DEFAULT_SAMPLE_RATE = 24_000;
const MONO_CHANNELS = 1;
const PROCESSOR_BUFFER_SIZE = 4096;

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function appendTranscriptToDraft(draft: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) {
    return draft;
  }
  const current = draft.trimEnd();
  return current ? `${current} ${text}` : text;
}

export function floatToPcm16Base64(input: Float32Array): string {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, pcm, true);
  }
  return bytesToBase64(bytes);
}

export async function startVoiceRecorder(
  options: StartVoiceRecorderOptions,
): Promise<VoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: MONO_CHANNELS,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const AudioContextCtor =
    window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!AudioContextCtor) {
    stopTracks(stream);
    throw new Error('Audio capture is not available in this browser.');
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(
    PROCESSOR_BUFFER_SIZE,
    MONO_CHANNELS,
    MONO_CHANNELS,
  );
  const targetSampleRate = options.targetSampleRate ?? DEFAULT_SAMPLE_RATE;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resampleFloat32(
      input,
      audioContext.sampleRate,
      targetSampleRate,
    );
    const audio = floatToPcm16Base64(resampled);
    if (audio.length > 0) {
      void options.onChunk({
        audio,
        sampleRate: targetSampleRate,
        numChannels: MONO_CHANNELS,
      });
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    stop: async () => {
      processor.disconnect();
      source.disconnect();
      stopTracks(stream);
      await audioContext.close().catch(() => undefined);
    },
  };
}

function resampleFloat32(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return input.slice();
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
    output[index] = input[sourceIndex] ?? 0;
  }
  return output;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const maybeBuffer = (
    globalThis as {
      Buffer?: { from: (input: Uint8Array) => { toString: (encoding: 'base64') => string } };
    }
  ).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
