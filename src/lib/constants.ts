/** Sample rate of the processing graph (AudioContext, PCM store, both models' I/O). */
export const SAMPLE_RATE = 48000;

/** Web Audio render quantum. */
export const QUANTUM = 128;

/** DeepFilterNet3 hop size in samples at 48 kHz (10 ms). */
export const RT_HOP = 480;

/** DeepFilterNet3 algorithmic delay in samples (measured: 30 ms). */
export const DFN_DELAY = 1440;

/** Default jitter allowance for the worklet ↔ real-time worker round trip (30 ms). */
export const DEFAULT_JITTER = 1440;

/** Maximum jitter allowance after adaptive growth (60 ms). */
export const MAX_JITTER = 2880;

/** Default output latency of the worklet, shared by both modes. */
export const DEFAULT_LATENCY = DFN_DELAY + DEFAULT_JITTER;

/** Number of mono input samples in an alignment probe (~85 ms). */
export const PROBE_LENGTH = 4096;

/** MDX-Net model sample rate. */
export const MDX_SAMPLE_RATE = 44100;

/** reductionDb at or above this value means full removal (g = 0). */
export const REMOVE_DB = 60;
