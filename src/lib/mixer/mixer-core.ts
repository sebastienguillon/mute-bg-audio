// Pure, testable core of the mixer AudioWorklet: timeline, real-time and look-ahead remix,
// gap gating, look-ahead lock/verification, planned (speech-free) switches, crossfades, adaptive
// jitter, idle detection, real-time worker health, stats and debug capture. See
// docs/ARCHITECTURE.md ("Timelines and synchronisation"). The worklet entry forwards
// AudioWorkletProcessor.process() and the MessagePorts to one MixerCore.
import { DEFAULT_JITTER, DFN_DELAY, MAX_JITTER, PROBE_LENGTH, QUANTUM, RT_HOP, SAMPLE_RATE } from '../constants';
import type {
  FromMixer,
  LaFromWorker,
  LaToWorker,
  MixerConfig,
  MixerMode,
  MixerStats,
  RtFromWorker,
  RtToWorker,
  ToMixer,
} from '../protocol';
import { BlockCursor, BlockStore } from './block-store';

/**
 * Outgoing message sinks (normally `MessagePort.postMessage`). Message objects and buffers that
 * are not listed in `transfer` are reused by the core after the call returns, so implementations
 * must post (structured-clone) them synchronously.
 */
export interface MixerPorts {
  postRt(msg: RtToWorker, transfer?: Transferable[]): void;
  postLa(msg: LaToWorker, transfer?: Transferable[]): void;
  postMain(msg: FromMixer, transfer?: Transferable[]): void;
}

/** Options of {@link MixerCore}. */
export interface MixerCoreOptions {
  /** Graph sample rate; default SAMPLE_RATE (48 kHz). */
  sampleRate?: number;
  /**
   * Initial jitter allowance in frames (e.g. sized for the audio callback), clamped to
   * [DEFAULT_JITTER, MAX_INITIAL_JITTER]; default DEFAULT_JITTER. Underruns grow it up to
   * max(MAX_JITTER, jitter + JITTER_HEADROOM); a minute of clean real-time output lowers it
   * again by one step, never below this value.
   */
  jitter?: number;
  /**
   * Frame index of the first rendered frame (a non-negative integer); default 0. Lets tests run
   * the counters as they are after hours of AudioContext uptime (see #rebase).
   */
  firstFrame?: number;
}

/** Look-ahead lock state, see {@link MixerCore.lockState}. */
export type LockState = 'unlocked' | 'provisional' | 'locked';

type HopMessage = Extract<RtToWorker, { type: 'hop' }>;
type StatsMessage = Extract<FromMixer, { type: 'stats' }>;

/** Shared by every session start (posted messages are cloned). */
const RESET_MESSAGE: RtToWorker = { type: 'reset' };

// Output sources. HOLD outputs silence (see #select); REFLECT (fade-out only) replays the output
// history backwards from the switch.
const SRC_BYPASS = 0;
const SRC_PASS = 1;
const SRC_RT = 2;
const SRC_LA = 3;
const SRC_HOLD = 4;
const SRC_REFLECT = 5;

// Reported modes (MixerStats.mode), counted per output sample.
const MODE_BYPASS = 0;
const MODE_IDLE = 1;
const MODE_PASS = 2;
const MODE_RT = 3;
const MODE_LA = 4;
const MODE_NAMES: readonly MixerMode[] = ['bypass', 'idle', 'passthrough', 'realtime', 'lookahead'];
/**
 * Mode of each current source while enabled and not idle (bypass then means an unhealthy
 * worker), and while disabled until the output has reached bypass.
 */
const SOURCE_MODES: readonly number[] = [MODE_PASS, MODE_PASS, MODE_RT, MODE_LA, MODE_PASS];
/** #postStats: report the mode of most samples since the last report. */
const MODE_MAJORITY = -1;

// Look-ahead lock states.
const LOCK_NONE = 0;
const LOCK_PROVISIONAL = 1;
const LOCK_LOCKED = 2;
const LOCK_NAMES: readonly LockState[] = ['unlocked', 'provisional', 'locked'];

// Verification verdicts of one input quantum. Values >= V_GOOD allow look-ahead output.
const V_NONE = 0;
const V_BAD = 1;
const V_GOOD = 2;
const V_NEUTRAL = 3;

// Planned switches (see #updatePlan): into look-ahead output from a delayed source, out of it
// after look-ahead was turned off, and to a new outputLatency during look-ahead output.
const PLAN_NONE = 0;
const PLAN_ENTER = 1;
const PLAN_LEAVE = 2;
const PLAN_DELAY = 3;

/** Crossfade length of every source or latency switch (10 ms at 48 kHz). */
const FADE = 480;
/** Minimum input history (seconds). */
const INPUT_SECONDS = 3;
/** Real-time speech ring (frames); covers the maximum latency plus the replay after a jitter increase. */
const SPEECH_RING = 16384;
const SPEECH_MASK = SPEECH_RING - 1;
/** Output history used by REFLECT fades (needs > 2 · FADE). */
const HISTORY = 1024;
const HISTORY_MASK = HISTORY - 1;
/** Hop buffers kept for reuse. */
const HOP_POOL_SIZE = 32;
/** At most this many hop buffers are with the worker; further hops are dropped, not allocated. */
const MAX_HOPS_IN_FLIGHT = HOP_POOL_SIZE;
/** Sent-hop bookkeeping for round-trip measurement. */
const SENT_RING = 64;
const SENT_MASK = SENT_RING - 1;

const MAX_BLOCK_SECONDS = 60;
const KEEP_BEHIND_SECONDS = 1;
const PROBE_INTERVAL_SECONDS = 0.25;
const PROBE_TIMEOUT_SECONDS = 1;
const MIN_PROBE_SCORE = 0.6;
const MIN_PROBE_GAIN = 1e-4;
/** Consecutive good quanta that turn a candidate into a lock. */
const LOCK_QUANTA = 10;
/** Consecutive bad quanta that drop the lock (8 · 128 frames ≈ 21 ms). */
const UNLOCK_QUANTA = 8;
/** A lock whose media position has no blocks for this long is dropped. */
const UNCOVERED_SECONDS = 0.5;
/** Good quantum: Σ(x − v·mix)² < MATCH_RATIO · Σx². */
const MATCH_RATIO = 0.25;
/** Mean square per sample and channel below which the input counts as silent (−70 dBFS). */
const SILENCE_POWER = 1e-7;
/** Mean square above which v·mix counts as clearly not silent (−50 dBFS). */
const LOUD_POWER = 1e-5;
/** Exact digital silence against media above this (−80 dBFS) counts towards unlocking (a pause). */
const PAUSE_MEDIA_POWER = 1e-8;
/** Per-quantum forgetting factor of the least-squares gain refinement (≈ 50 quanta memory). */
const GAIN_FORGET = 0.98;
/** Largest accepted MixerConfig.outputLatency (seconds); larger values are clamped. */
const MAX_OUTPUT_LATENCY_SECONDS = 1;

/** A planned switch waits at most this long for speech-free content (seconds). */
const SWITCH_SEARCH_SECONDS = 1.5;
/** The speech level reference of a switch search also covers this much earlier content (seconds). */
const SWITCH_PREROLL_SECONDS = 0.5;
/**
 * A change of D during look-ahead output by at most this much (50 ms) is applied at once,
 * crossfaded (e.g. Chrome reporting the latency of a wired device once audio plays); larger ones
 * (a Bluetooth device) skip or hold too much content and are planned.
 */
const UNPLANNED_DELAY_STEP = 2400;
/** Content cell of the switch search (frames); switch candidates are this far apart. */
const CELL = 32;
/** Cells scanned per render quantum (4096 frames: 32 times real time). */
const CELLS_PER_QUANTUM = 128;
/**
 * A cell is speech-free below this fraction (−30 dB) of the loudest speech envelope scanned
 * (soft consonants and syllable troughs are not), or below PRESENCE_FLOOR. Model leakage in a
 * pause may exceed it: the pause is then still found as the quietest moment.
 */
const SPEECH_FREE_RATIO = 0.001;
/** Cell power that stands for non-finite or absurd model output (never speech-free). */
const MAX_CELL_POWER = 100;

const GAIN_RAMP_SECONDS = 0.02;
const ENVELOPE_SECONDS = 0.02;
const GATE_ATTACK_SECONDS = 0.005;
const GATE_RELEASE_SECONDS = 0.3;
/** Speech present when its power exceeds the input power · 10^(−20/10)… */
const PRESENCE_RATIO = 0.01;
/** …and −60 dBFS (also the absolute speech-free level of the switch search). */
const PRESENCE_FLOOR = 1e-6;
/** Gate gain while no speech is present (−12 dB). */
const GATE_FLOOR = Math.pow(10, -12 / 20);

const UNDERRUN_EVENTS = 3;
const UNDERRUN_WINDOW_SECONDS = 10;
/** While a gap lasts, late speech arrivals count as a further underrun at most this often. */
const LATE_EVENT_SECONDS = 0.2;
const JITTER_STEP = RT_HOP;
/** Largest initial jitter allowance accepted from the options (200 ms). */
const MAX_INITIAL_JITTER = 9600;
/** Growth allowed above a large initial jitter (three steps). */
const JITTER_HEADROOM = 3 * JITTER_STEP;
/** Real-time output without underruns after which the jitter allowance shrinks by one step. */
const JITTER_DECAY_SECONDS = 60;
/** Digital silence after which processing pauses (idle). */
const IDLE_SECONDS = 0.5;
/**
 * Power per sample treated as digital silence (about −200 dBFS). Chrome's Opus decoder turns
 * digital silence into values around 1e-15 rather than exact zeros.
 */
const DIGITAL_SILENCE_POWER = 1e-20;
/**
 * After the element stops playing, its audio keeps arriving for a few render quanta. Look-ahead
 * already played that content (it leads the input), so the delayed paths must not replay it.
 */
const STOP_TAIL = 2048;
/** Hops sent without any speech coming back for this long: the real-time worker is unhealthy. */
const RT_TIMEOUT_SECONDS = 1;
/** A connected worker that has not said 'ready' after this long is unhealthy (its model failed to load). */
const RT_READY_TIMEOUT_SECONDS = 10;
/** While the worker is unhealthy, one hop per this interval detects its recovery. */
const RT_HEARTBEAT_SECONDS = 0.25;

/**
 * Frame counters stay below 2 · REBASE_UNIT (2^29, 3.1 h at 48 kHz): small integers (Smis) even
 * where V8 compresses pointers (2^30). A power of two, so every ring size divides it.
 */
const REBASE_UNIT = 2 ** 28;

/**
 * A frame before every other. A constant: `-Infinity` evaluates a negation, whose result would be
 * boxed (allocated) on every store in optimised code that does not keep the field unboxed.
 */
const PAST = -Infinity;

const STATS_SECONDS = 0.5;
const MAX_DEBUG_SECONDS = 60;

/**
 * Mixer core, driven one render quantum at a time by the AudioWorklet wrapper.
 *
 * Real-time and delayed pass-through output at input frame f is the processed version of input
 * frame f − L, with L = DFN_DELAY + jitter. Look-ahead output at frame f is the processed media
 * index f + offset + D (lock offset; D = MixerConfig.outputLatency): what the element presents
 * now, plus the sink latency, so that it is heard in sync with the picture. Bypass outputs the
 * input without delay: when disabled, and while the real-time worker is unhealthy and look-ahead
 * is not usable. After IDLE_SECONDS of digital silence no hops are sent (idle) until sound
 * returns, which starts a new real-time session. Look-ahead output only continues while the
 * element plays ('playback' message): a pause, seek or speed change drops the lock at once, while
 * silence in the content keeps it.
 *
 * Every change of source or delay is crossfaded over 10 ms. A switch that moves the output back
 * in the content by more than that (look-ahead → real-time, bypass → delayed) holds silence until
 * the new source reaches content that has not been output yet, so nothing is heard twice. Planned
 * switches (into look-ahead output, which skips L + D of content; out of it after look-ahead was
 * turned off; to a new D) wait up to SWITCH_SEARCH_SECONDS for content where the skip or the
 * silence falls on no speech; urgent ones (the input stopped matching, no data, disabled) do not.
 * Calls to process() must always cover QUANTUM frames (verification works per quantum).
 */
export class MixerCore {
  readonly #ports: MixerPorts;
  readonly #sampleRate: number;

  // Configuration.
  #enabled = false;
  #configured = false;
  #gapReduction = false;
  #lookahead = false;
  #rtConnected = false;
  #laConnected = false;
  /** Configured sink latency D in frames that look-ahead output leads by. */
  #outputLatency = 0;
  readonly #maxOutputLatency: number;
  /** The controlled element plays (see ToMixer 'playback'); true until told otherwise. */
  #playing = true;
  /** A config disabled processing: report stats as soon as the output equals the input. */
  #bypassPending = false;

  // Timeline.
  #frame = 0;
  /** Amount the frame domain moved back at the last rebase (0: none yet). */
  #rebaseShift = 0;
  readonly #initialJitter: number;
  readonly #maxJitter: number;
  #jitter: number;
  #latency: number;
  /** Real-time output frames since the last underrun or jitter change (drives the decay). */
  #cleanFrames = 0;
  readonly #decayFrames: number;
  /** Consecutive frames of digital silence (exact zeros). */
  #silentFrames = 0;
  readonly #idleFrames: number;
  #idle = false;

  // Input history (stereo).
  readonly #inMask: number;
  readonly #inL: Float32Array;
  readonly #inR: Float32Array;
  /** Σ(l² + r²) of the latest input quantum. */
  #inputSq = 0;

  // Real-time path.
  readonly #speech = new Float32Array(SPEECH_RING);
  /** Frame index stored in each speech slot (NaN: empty). */
  readonly #speechFrame = new Float64Array(SPEECH_RING).fill(NaN);
  /** 1: the slot holds a pass-through answer (no model output), mixed like a missing one. */
  readonly #speechPass = new Uint8Array(SPEECH_RING);
  /** The worker of the current connection said 'ready' (its model is loaded). */
  #rtReady = false;
  /** Hops are being sent (enabled, connected, ready, not idle). */
  #rtActive = false;
  /** Hop being filled; always owned by the core (transferred only with a replacement at hand). */
  #hopBuf = new Float32Array(RT_HOP);
  #hopFill = 0;
  #hopIndex = 0;
  #hopSessionStart = 0;
  /** Speech for earlier frames is ignored (warm-up output of the worker after a reset). */
  #rtValidFrom = 0;
  readonly #pool: Float32Array<ArrayBuffer>[] = [];
  #poolCount = 0;
  #hopAllocations = 1;
  /** Hop buffers posted to the current worker and not answered yet. */
  #inFlight = 0;
  readonly #hopMsg: HopMessage = { type: 'hop', index: 0, data: new Float32Array(0) };
  readonly #hopTransfer: Transferable[] = [new ArrayBuffer(0)];
  readonly #sentIndex = new Float64Array(SENT_RING).fill(NaN);
  readonly #sentFrame = new Float64Array(SENT_RING);
  #rtRoundTrip = 0;
  /** Frame at which the last speech message arrived. */
  #lastSpeechAt = -Infinity;
  /**
   * Start of the current wait for the worker: the connection (until 'ready'), then the session
   * start, unless the worker is already unhealthy (only an answer clears that).
   */
  #rtWaitFrom = 0;
  readonly #rtTimeout: number;
  readonly #readyTimeout: number;
  /** False while the worker does not answer (see #checkHealth, #checkReady). */
  #rtHealthy = true;
  #lastBeatAt = -Infinity;
  readonly #beatInterval: number;
  /** The real-time source has fed the output in this session (gaps count from then on). */
  #rtUsed = false;
  /** The output is in pass-through while hops are being sent. */
  #inGap = false;
  #lastUnderrunAt = -Infinity;
  /** Latest input frame output as pass-through during a gap. */
  #lastGapT = -Infinity;
  readonly #lateInterval: number;
  #underruns = 0;
  readonly #underrunTimes = new Float64Array(UNDERRUN_EVENTS);
  #underrunPos = 0;
  #underrunCount = 0;
  readonly #underrunWindow: number;

  // Look-ahead path.
  readonly #blocks: BlockStore;
  readonly #verifyCursor = new BlockCursor();
  readonly #outCursor = new BlockCursor();
  readonly #prevCursor = new BlockCursor();
  readonly #scanCursor = new BlockCursor();
  #lock = LOCK_NONE;
  #lockTimeline = 0;
  #lockOffset = 0;
  #lockGain = 1;
  #goodRun = 0;
  #badRun = 0;
  #badStart = 0;
  #uncoveredRun = 0;
  readonly #uncoveredLimit: number;
  #sumXm = 0;
  #sumMm = 0;
  /** The newest input quantum confirmed the lock: look-ahead output is allowed. */
  #laVerified = false;
  /** Look-ahead was turned off while it played: its output continues until a planned switch. */
  #laDraining = false;
  /** D applied to look-ahead output (follows #outputLatency through planned switches). */
  #laD = 0;
  readonly #probeData = new Float32Array(PROBE_LENGTH);
  readonly #probeMsg: LaToWorker = { type: 'probe', id: 0, frameEnd: 0, data: this.#probeData };
  #probeSeq = 0;
  /** Id of the outstanding probe (0: none). */
  #probePending = 0;
  #probeSentAt = 0;
  #lastProbeAt = -Infinity;
  #probeNotBefore = 0;
  readonly #probeInterval: number;
  readonly #probeTimeout: number;
  readonly #keepBehind: number;

  // Planned switch. Gates read by #select: look-ahead output may start at #laFrom and ends at
  // #laUntil; #laD becomes #laDNext at #laDAt.
  #laFrom = PAST;
  #laUntil = Infinity;
  #laDAt = Infinity;
  #laDNext = 0;
  #plan = PLAN_NONE;
  /** Content span [f + a, f + b) (input frames) that a switch at output frame f must find speech-free. */
  #planA = 0;
  #planB = 0;
  #planTimeline = 0;
  #planOffset = 0;
  /** First candidate switch frame; candidates follow every CELL frames. */
  #planStart = 0;
  /** Chosen switch frame (Infinity: still searching). */
  #planAt = Infinity;
  readonly #searchFrames: number;
  readonly #candidates: number;
  readonly #prerollCells: number;
  #spanCells = 0;
  /** Input frame of cell 0; cell c covers input frames [grid + c · CELL, +CELL). */
  #scanGrid = 0;
  /** Next cell to scan, and the end (exclusive) of the cells the last candidate needs. */
  #scanCell = 0;
  #scanEnd = 0;
  /** Consecutive speech-free cells up to #scanCell. */
  #scanRun = 0;
  #scanEnv = 0;
  /** Loudest speech envelope scanned (the reference of "speech-free"). */
  #scanRef = 0;
  readonly #cellEnvCoef: number;
  /** Prefix sums of the cell speech powers: cells [a, b) have prefix[b] − prefix[a]. */
  readonly #cellPrefix: Float64Array;

  // Source selection (desired source of the current sample). The content of a source at output
  // frame f is input frame f − delay (look-ahead: delay = −D, media index = that + offset).
  #dKind = SRC_BYPASS;
  #dDelay = 0;
  #dOffset = 0;
  #dTimeline = 0;
  #dGain = 1;
  // Current source.
  #curKind = SRC_BYPASS;
  #curDelay = 0;
  #curOffset = 0;
  #curTimeline = 0;
  #curGain = 1;
  // Source being faded out.
  #prevKind = SRC_BYPASS;
  #prevDelay = 0;
  #prevOffset = 0;
  #prevTimeline = 0;
  #prevGain = 1;
  #prevAnchor = 0;
  #fadePos = FADE;
  readonly #fadeCurve = new Float32Array(FADE);
  readonly #histL = new Float32Array(HISTORY);
  readonly #histR = new Float32Array(HISTORY);
  /** End (exclusive) of the input frames whose content has been output. */
  #presented = -Infinity;

  // Source evaluation result: output = S + gEff · R; xMid = input mid of the content (for the gate).
  #eSL = 0;
  #eSR = 0;
  #eRL = 0;
  #eRR = 0;
  #eXMid = 0;

  // Residual gain and gap gate.
  #gain = 1;
  #gainTarget = 1;
  #gainStep = 0;
  #gainRampLeft = 0;
  readonly #gainRampFrames: number;
  #gate = 1;
  #gEff = 1;
  #envSpeech = 0;
  #envInput = 0;
  readonly #envCoef: number;
  readonly #attackCoef: number;
  readonly #releaseCoef: number;

  // Stats.
  readonly #statsPeriod: number;
  #statsFrom = 0;
  readonly #modeCounts = new Float64Array(MODE_NAMES.length);
  #inSq = 0;
  #outSq = 0;
  readonly #stats: MixerStats = {
    mode: 'bypass',
    locked: false,
    latency: 0,
    underruns: 0,
    inRms: 0,
    outRms: 0,
    laAhead: 0,
    rtRoundTripMs: 0,
    rtHealthy: true,
  };
  readonly #statsMsg: StatsMessage = { type: 'stats', stats: this.#stats };

  // Debug capture.
  #debug: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | null =
    null;
  #debugPos = 0;

  constructor(ports: MixerPorts, opts: MixerCoreOptions = {}) {
    this.#ports = ports;
    const sr = opts.sampleRate ?? SAMPLE_RATE;
    this.#sampleRate = sr;
    const jitter = opts.jitter ?? DEFAULT_JITTER;
    this.#initialJitter = Number.isFinite(jitter)
      ? Math.min(MAX_INITIAL_JITTER, Math.max(DEFAULT_JITTER, Math.round(jitter)))
      : DEFAULT_JITTER;
    this.#maxJitter = Math.max(MAX_JITTER, this.#initialJitter + JITTER_HEADROOM);
    this.#jitter = this.#initialJitter;
    this.#latency = DFN_DELAY + this.#jitter;
    this.#maxOutputLatency = Math.round(MAX_OUTPUT_LATENCY_SECONDS * sr);
    const first = opts.firstFrame ?? 0;
    this.#frame = Number.isSafeInteger(first) && first > 0 ? first : 0;
    this.#rtWaitFrom = this.#frame;
    this.#statsFrom = this.#frame;
    // The first probe window needs PROBE_LENGTH frames of input.
    this.#probeNotBefore = this.#frame + PROBE_LENGTH;

    let ring = 1;
    while (ring < INPUT_SECONDS * sr) ring *= 2;
    this.#inMask = ring - 1;
    this.#inL = new Float32Array(ring);
    this.#inR = new Float32Array(ring);

    this.#underrunWindow = UNDERRUN_WINDOW_SECONDS * sr;
    this.#lateInterval = Math.round(LATE_EVENT_SECONDS * sr);
    this.#decayFrames = Math.round(JITTER_DECAY_SECONDS * sr);
    this.#idleFrames = Math.round(IDLE_SECONDS * sr);
    this.#rtTimeout = Math.round(RT_TIMEOUT_SECONDS * sr);
    this.#readyTimeout = Math.round(RT_READY_TIMEOUT_SECONDS * sr);
    this.#beatInterval = Math.round(RT_HEARTBEAT_SECONDS * sr);
    this.#blocks = new BlockStore(Math.round(MAX_BLOCK_SECONDS * sr));
    this.#uncoveredLimit = Math.ceil((UNCOVERED_SECONDS * sr) / QUANTUM);
    this.#probeInterval = Math.round(PROBE_INTERVAL_SECONDS * sr);
    this.#probeTimeout = Math.round(PROBE_TIMEOUT_SECONDS * sr);
    this.#keepBehind = Math.round(KEEP_BEHIND_SECONDS * sr);

    this.#searchFrames = Math.round(SWITCH_SEARCH_SECONDS * sr);
    this.#candidates = Math.floor(this.#searchFrames / CELL) + 1;
    this.#prerollCells = Math.ceil((SWITCH_PREROLL_SECONDS * sr) / CELL);
    // The longest span: skipping L + D when entering look-ahead from real-time output.
    const maxSpanCells = Math.ceil((DFN_DELAY + this.#maxJitter + this.#maxOutputLatency) / CELL);
    this.#cellPrefix = new Float64Array(this.#prerollCells + this.#candidates + maxSpanCells + 1);
    this.#cellEnvCoef = 1 - Math.exp(-CELL / (ENVELOPE_SECONDS * sr));

    for (let k = 0; k < FADE; k++) this.#fadeCurve[k] = 0.5 - 0.5 * Math.cos((Math.PI * (k + 1)) / (FADE + 1));

    this.#gainRampFrames = Math.max(1, Math.round(GAIN_RAMP_SECONDS * sr));
    this.#envCoef = 1 - Math.exp(-1 / (ENVELOPE_SECONDS * sr));
    this.#attackCoef = 1 - Math.exp(-1 / (GATE_ATTACK_SECONDS * sr));
    this.#releaseCoef = 1 - Math.exp(-1 / (GATE_RELEASE_SECONDS * sr));
    this.#statsPeriod = Math.round(STATS_SECONDS * sr);
  }

  /** Current real-time output latency L in frames (DFN_DELAY + jitter). */
  get latency(): number {
    return this.#latency;
  }

  /** Look-ahead lock state. */
  get lockState(): LockState {
    return LOCK_NAMES[this.#lock]!;
  }

  /** Number of hop buffers created so far (constant in steady state thanks to the pool). */
  get hopBuffersAllocated(): number {
    return this.#hopAllocations;
  }

  /**
   * A real-time worker port was connected (true: a new worker, which must say 'ready' before
   * hops are sent to it) or lost (false).
   */
  setRtConnected(connected: boolean): void {
    this.#rtConnected = connected;
    this.#rtReady = false;
    // Buffers held by a previous worker are lost; its health says nothing about the new one.
    this.#inFlight = 0;
    this.#lastSpeechAt = -Infinity;
    this.#rtWaitFrom = this.#frame;
    if (!this.#rtHealthy) this.#setHealthy(true);
    this.#updateRealtime(this.#frame);
  }

  /** The look-ahead worker port was connected (true) or lost (false; drops all blocks). */
  setLaConnected(connected: boolean): void {
    this.#laConnected = connected;
    if (!connected) {
      this.#blocks.flush();
      this.#resetLookahead();
    }
  }

  /** Handles a controller message ('config', 'playback', 'debug-record'; connect-* belong to the wrapper). */
  onMain(msg: ToMixer): void {
    switch (msg.type) {
      case 'config':
        this.#applyConfig(msg.config);
        break;
      case 'playback':
        this.#setPlaying(msg.playing);
        break;
      case 'debug-record':
        this.#startDebug(msg.seconds);
        break;
      default:
        break;
    }
  }

  /** Handles a message from the real-time worker. */
  onRt(msg: RtFromWorker): void {
    if (msg.type === 'speech') {
      // Answers are for frames already input: a later index was computed before the last rebase.
      const index = msg.index > this.#frame ? msg.index - this.#rebaseShift : msg.index;
      this.#storeSpeech(index, msg.data, 'passthrough' in msg && msg.passthrough === true);
    } else if (msg.type === 'ready') {
      this.#onRtReady();
    }
  }

  /** Handles a message from the look-ahead worker. */
  onLa(msg: LaFromWorker): void {
    switch (msg.type) {
      case 'block': {
        // Blocks are used as received; non-finite samples are dropped where they are read.
        this.#blocks.insert(msg.timelineId, msg.start, msg.speechL, msg.speechR, msg.residualL, msg.residualR);
        const locked = this.#lock !== LOCK_NONE;
        this.#blocks.enforceBudget(
          locked ? this.#lockTimeline : null,
          this.#frame + this.#lockOffset,
          this.#keepBehind,
        );
        break;
      }
      case 'flush':
        this.#blocks.flush(msg.timelineId);
        this.#probePending = 0;
        if (this.#lock !== LOCK_NONE && (msg.timelineId === undefined || msg.timelineId === this.#lockTimeline)) {
          this.#unlock(this.#frame);
        }
        break;
      case 'probe-result':
        this.#onProbeResult(msg);
        break;
    }
  }

  /**
   * Renders one quantum. `input` has 0, 1 (mono, used for both sides) or 2 channels; a missing
   * input is silence. Writes channel 0 and, when present, channel 1 of `output`.
   */
  process(input: Float32Array[] | undefined, output: Float32Array[]): void {
    const outL = output[0];
    if (outL === undefined) return;
    if (this.#frame >= 2 * REBASE_UNIT) this.#rebase();
    const n = outL.length;
    const f0 = this.#frame;
    this.#writeInput(input, f0, n);
    const sq = this.#inputSq;
    this.#frame = f0 + n;
    this.#inSq += sq;
    // Probe windows must lie entirely after silence (start of playback, resume after a pause).
    if (sq <= SILENCE_POWER * 2 * n) this.#probeNotBefore = Math.max(this.#probeNotBefore, this.#frame + PROBE_LENGTH);
    this.#trackSilence(sq <= DIGITAL_SILENCE_POWER * 2 * n, f0, n);
    if (this.#rtActive) {
      this.#feedHops(f0, n);
      this.#checkHealth();
    } else if (this.#rtConnected && !this.#rtReady && this.#enabled) {
      this.#checkReady();
    }
    this.#lookaheadInput(f0, n);
    this.#maybeProbe();
    this.#updatePlan(f0);
    this.#render(f0, n, outL, output[1]);
    if (this.#curKind === SRC_RT && this.#jitter > this.#initialJitter) this.#relaxJitter(n);
    this.#maybePostStats();
  }

  // ───────────── configuration ─────────────

  #applyConfig(config: MixerConfig): void {
    this.#enabled = config.enabled;
    this.#bypassPending = !config.enabled;
    this.#gapReduction = config.gapReduction;
    this.#lookahead = config.lookahead;
    const g = config.residualGain;
    if (Number.isFinite(g)) {
      this.#gainTarget = Math.min(1, Math.max(0, g));
      if (!this.#configured) {
        this.#gain = this.#gainTarget;
        this.#gainRampLeft = 0;
      } else if (this.#gainTarget !== this.#gain) {
        this.#gainRampLeft = this.#gainRampFrames;
        this.#gainStep = (this.#gainTarget - this.#gain) / this.#gainRampFrames;
      }
    }
    const d = config.outputLatency;
    this.#outputLatency = Number.isFinite(d) ? Math.min(this.#maxOutputLatency, Math.max(0, Math.round(d))) : 0;
    this.#configured = true;
    this.#updateRealtime(this.#frame);
    if (this.#laOn()) {
      this.#laDraining = false;
    } else if (this.#enabled && this.#laConnected && this.#curKind === SRC_LA && this.#lock === LOCK_LOCKED) {
      // Look-ahead turned off while it plays: not urgent, it leaves at a planned moment.
      this.#laDraining = true;
    } else {
      this.#resetLookahead();
    }
  }

  /** Look-ahead is configured and connected (probing and new locks also need #playing). */
  #laOn(): boolean {
    return this.#enabled && this.#lookahead && this.#laConnected;
  }

  /** Look-ahead output may be used (it is on, or turned off but still leaving). */
  #laUsable(): boolean {
    return this.#enabled && this.#laConnected && (this.#lookahead || this.#laDraining);
  }

  /**
   * The element started or stopped playing. Stopped (paused, seeking, waiting, ended, another
   * speed): the look-ahead position no longer follows the input, so the lock drops at once and
   * the delayed paths may output the input from now on; of the content ahead, only what is
   * already in the device buffer has been heard. Content silence while playing keeps the lock.
   */
  #setPlaying(playing: boolean): void {
    if (playing === this.#playing) return;
    this.#playing = playing;
    if (!playing) {
      this.#presented = Math.min(this.#presented, this.#frame + STOP_TAIL);
      this.#resetLookahead();
    } else {
      // A probe window must lie entirely after the resume (or the speed change).
      this.#probeNotBefore = Math.max(this.#probeNotBefore, this.#frame + PROBE_LENGTH);
    }
  }

  /**
   * Starts or stops sending hops (enabled, connected, ready and not idle); a new session starts
   * at `from`. The worker's health carries over: going idle or disabled must not hide a dead one.
   */
  #updateRealtime(from: number): void {
    const active = this.#enabled && this.#rtConnected && this.#rtReady && !this.#idle;
    if (active === this.#rtActive) return;
    this.#rtActive = active;
    this.#rtUsed = false;
    this.#inGap = false;
    if (!active) return;
    this.#hopIndex = from;
    this.#hopSessionStart = from;
    this.#rtValidFrom = from;
    this.#hopFill = 0;
    if (this.#rtHealthy) this.#rtWaitFrom = from;
    this.#ports.postRt(RESET_MESSAGE);
  }

  /**
   * Enters idle after IDLE_SECONDS of digital silence (a paused or ended element, or silence in
   * the content): no hops, no probes. A look-ahead lock is kept, so that look-ahead output plays
   * through a gap in the content and its end in sync (a pause has already dropped it). The first
   * quantum with sound leaves idle and starts a new real-time session that includes this
   * quantum; until its speech is back the real-time output is delayed pass-through.
   */
  #trackSilence(silent: boolean, f0: number, n: number): void {
    if (!silent) {
      this.#silentFrames = 0;
      if (this.#idle) {
        this.#idle = false;
        this.#updateRealtime(f0);
      }
      return;
    }
    this.#silentFrames += n;
    if (this.#idle || this.#silentFrames < this.#idleFrames) return;
    this.#idle = true;
    this.#probePending = 0;
    this.#updateRealtime(f0 + n);
  }

  // ───────────── input, real-time hops and worker health ─────────────

  /**
   * Copies the input into the history ring and sets #inputSq = Σ(l² + r²) (a field: a returned
   * fractional number would be boxed when the call is not inlined).
   */
  #writeInput(input: Float32Array[] | undefined, f0: number, n: number): void {
    const inL = this.#inL;
    const inR = this.#inR;
    const mask = this.#inMask;
    const l = input?.[0];
    if (l === undefined) {
      for (let i = 0; i < n; i++) {
        const k = (f0 + i) & mask;
        inL[k] = 0;
        inR[k] = 0;
      }
      this.#inputSq = 0;
      return;
    }
    const r = input?.[1] ?? l;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i] ?? 0;
      const b = r[i] ?? 0;
      const k = (f0 + i) & mask;
      inL[k] = a;
      inR[k] = b;
      sq += a * a + b * b;
    }
    this.#inputSq = sq;
  }

  /** Accumulates the mid channel of [f0, f0 + n) into hops and completes full hops. */
  #feedHops(f0: number, n: number): void {
    const inL = this.#inL;
    const inR = this.#inR;
    const mask = this.#inMask;
    let buf = this.#hopBuf;
    let fill = this.#hopFill;
    for (let i = 0; i < n; i++) {
      const k = (f0 + i) & mask;
      buf[fill++] = 0.5 * (inL[k]! + inR[k]!);
      if (fill === RT_HOP) {
        this.#completeHop();
        buf = this.#hopBuf;
        fill = 0;
      }
    }
    this.#hopFill = fill;
  }

  /**
   * Posts the full hop, or drops it (its buffer is refilled) when every buffer is in flight, and
   * while the worker is unhealthy except for one heartbeat hop per RT_HEARTBEAT_SECONDS. Nothing
   * is allocated once MAX_HOPS_IN_FLIGHT buffers exist.
   */
  #completeHop(): void {
    const index = this.#hopIndex;
    this.#hopIndex = index + RT_HOP;
    if (this.#rtHealthy) {
      const next = this.#takeHopBuffer();
      if (next !== null) this.#postHop(index, next);
      return;
    }
    if (this.#frame - this.#lastBeatAt < this.#beatInterval) return;
    // After a reset, so that the worker does not fill the gap since the last heartbeat with
    // silent hops (one model run each). Copied, not transferred: a stalled worker may hold every
    // buffer. Its answer makes it healthy again (#checkHealth).
    this.#lastBeatAt = this.#frame;
    this.#ports.postRt(RESET_MESSAGE);
    this.#postHop(index, null);
  }

  /** Posts #hopBuf as the hop at `index`: transferred and replaced by `next`, or copied (null). */
  #postHop(index: number, next: Float32Array<ArrayBuffer> | null): void {
    const buf = this.#hopBuf;
    const slot = ((index - this.#hopSessionStart) / RT_HOP) & SENT_MASK;
    this.#sentIndex[slot] = index;
    this.#sentFrame[slot] = this.#frame;
    this.#inFlight++;
    this.#hopMsg.index = index;
    this.#hopMsg.data = buf;
    if (next === null) {
      this.#ports.postRt(this.#hopMsg);
      return;
    }
    this.#hopBuf = next;
    this.#hopTransfer[0] = buf.buffer;
    this.#ports.postRt(this.#hopMsg, this.#hopTransfer);
  }

  #takeHopBuffer(): Float32Array<ArrayBuffer> | null {
    if (this.#poolCount > 0) return this.#pool[--this.#poolCount]!;
    if (this.#inFlight >= MAX_HOPS_IN_FLIGHT) return null;
    this.#hopAllocations++;
    return new Float32Array(RT_HOP);
  }

  #recycle(data: Float32Array): void {
    const buffer = data.buffer;
    if (
      this.#poolCount < HOP_POOL_SIZE &&
      data.length === RT_HOP &&
      data.byteOffset === 0 &&
      buffer instanceof ArrayBuffer &&
      buffer.byteLength === RT_HOP * Float32Array.BYTES_PER_ELEMENT
    ) {
      this.#pool[this.#poolCount++] = data as Float32Array<ArrayBuffer>;
    }
  }

  #storeSpeech(index: number, data: Float32Array, passthrough: boolean): void {
    const f = this.#frame;
    this.#lastSpeechAt = f;
    if (this.#inFlight > 0) this.#inFlight--;
    const from = Math.max(index, this.#rtValidFrom, f - SPEECH_RING + 1);
    const to = Math.min(index + data.length, f);
    const speech = this.#speech;
    const stamps = this.#speechFrame;
    const flags = this.#speechPass;
    const pass = passthrough ? 1 : 0;
    for (let t = from; t < to; t++) {
      const k = t & SPEECH_MASK;
      const s = data[t - index]!;
      // A non-finite estimate is dropped (silence): it would reach the output and the envelopes.
      speech[k] = Number.isFinite(s) ? s : 0;
      stamps[k] = t;
      flags[k] = pass;
    }
    const hop = index + DFN_DELAY;
    const slot = ((hop - this.#hopSessionStart) / RT_HOP) & SENT_MASK;
    if (this.#sentIndex[slot] === hop) this.#rtRoundTrip = f - this.#sentFrame[slot]!;
    // Speech that arrives after its frames went out as pass-through: the worker is alive but
    // later than the jitter allowance. This also covers gaps that never end (constantly late).
    if (this.#inGap && from < to && from < f - this.#latency && f - this.#lastUnderrunAt >= this.#lateInterval) {
      this.#onUnderrun(f);
    }
    this.#recycle(data);
  }

  /** The worker of the current connection has loaded its model: its health clock starts now. */
  #onRtReady(): void {
    if (!this.#rtConnected || this.#rtReady) return;
    this.#rtReady = true;
    this.#rtWaitFrom = this.#frame;
    if (!this.#rtHealthy) this.#setHealthy(true);
    this.#updateRealtime(this.#frame);
  }

  /**
   * While hops are sent: the worker is unhealthy when no speech has come back for
   * RT_TIMEOUT_SECONDS since the later of the last speech and #rtWaitFrom, and healthy again with
   * the next answer, which starts the real-time path over (the worker only saw heartbeats).
   */
  #checkHealth(): void {
    const healthy = this.#frame - Math.max(this.#lastSpeechAt, this.#rtWaitFrom) <= this.#rtTimeout;
    if (healthy === this.#rtHealthy) return;
    this.#setHealthy(healthy);
    if (!healthy) return;
    this.#rtValidFrom = this.#hopIndex;
    this.#ports.postRt(RESET_MESSAGE);
  }

  /** A connected worker that has not said 'ready' within RT_READY_TIMEOUT_SECONDS is unhealthy. */
  #checkReady(): void {
    if (this.#rtHealthy && this.#frame - this.#rtWaitFrom > this.#readyTimeout) this.#setHealthy(false);
  }

  #setHealthy(healthy: boolean): void {
    this.#rtHealthy = healthy;
    // The real-time path starts over: its gaps count as underruns only once it has been used again.
    this.#rtUsed = false;
    this.#inGap = false;
  }

  // ───────────── look-ahead: verification and probing ─────────────

  /** Verifies input quantum [f0, f0 + n) against the candidate/lock. */
  #lookaheadInput(f0: number, n: number): void {
    const verdict = this.#lock === LOCK_NONE ? V_NONE : this.#verify(f0, n);
    // The input stopped matching the media (seek, pause, glitch): from f0 on it is new content
    // that the delayed paths may output, even if look-ahead output already led past it.
    if (verdict === V_BAD) this.#presented = Math.min(this.#presented, f0);
    // Look-ahead output leads the input, so only the newest verdict can allow it.
    this.#laVerified = verdict >= V_GOOD && this.#lock === LOCK_LOCKED;
  }

  #verify(f0: number, n: number): number {
    const inL = this.#inL;
    const inR = this.#inR;
    const mask = this.#inMask;
    const timeline = this.#lockTimeline;
    const offset = this.#lockOffset;
    const v = this.#lockGain;
    let p = 0;
    let e = 0;
    let mm = 0;
    let xm = 0;
    for (let i = 0; i < n; i++) {
      const m = f0 + i + offset;
      const b = this.#blocks.find(timeline, m, this.#verifyCursor);
      if (b === null) {
        if (++this.#uncoveredRun >= this.#uncoveredLimit) this.#unlock(this.#frame);
        return V_NONE;
      }
      const j = m - b.start;
      const ml = b.speechL[j]! + b.residualL[j]!;
      const mr = b.speechR[j]! + b.residualR[j]!;
      const k = (f0 + i) & mask;
      const xl = inL[k]!;
      const xr = inR[k]!;
      const dl = xl - v * ml;
      const dr = xr - v * mr;
      p += xl * xl + xr * xr;
      e += dl * dl + dr * dr;
      mm += ml * ml + mr * mr;
      xm += xl * ml + xr * mr;
    }
    this.#uncoveredRun = 0;
    // The comparisons are NaN-safe: a block with non-finite samples makes the quantum bad.
    if (p > SILENCE_POWER * 2 * n) {
      if (!(e < MATCH_RATIO * p)) return this.#onBad(f0);
      this.#sumXm = GAIN_FORGET * this.#sumXm + xm;
      this.#sumMm = GAIN_FORGET * this.#sumMm + mm;
      return this.#onGood();
    }
    const vm = v * v * mm;
    if (!(vm <= LOUD_POWER * 2 * n)) return this.#onBad(f0);
    if (p === 0 && !(vm <= PAUSE_MEDIA_POWER * 2 * n)) {
      // Exact digital silence while the media is quiet but not silent: the element paused or
      // seeks in a quiet passage (when the playback message is late), or a decoder tail at a gap
      // in the content. Counts towards unlocking without stopping look-ahead output at once, so
      // a transient mismatch is not heard and a missed pause leaks at most UNLOCK_QUANTA.
      this.#onBad(f0);
      if (this.#lock === LOCK_NONE) this.#presented = Math.min(this.#presented, this.#badStart);
    }
    return V_NEUTRAL;
  }

  /** A good quantum (its LS sums are already accumulated): refine v, count towards the lock. */
  #onGood(): number {
    if (this.#sumXm > 0 && this.#sumMm > 0) this.#lockGain = this.#sumXm / this.#sumMm;
    this.#badRun = 0;
    if (this.#lock === LOCK_PROVISIONAL && ++this.#goodRun >= LOCK_QUANTA) this.#lock = LOCK_LOCKED;
    return V_GOOD;
  }

  #onBad(f0: number): number {
    this.#goodRun = 0;
    if (this.#badRun === 0) this.#badStart = f0;
    // Probe only once the probe window lies entirely after the mismatch started (e.g. a seek).
    if (++this.#badRun >= UNLOCK_QUANTA) this.#unlock(this.#badStart + PROBE_LENGTH);
    return V_BAD;
  }

  #unlock(probeNotBefore: number): void {
    this.#lock = LOCK_NONE;
    this.#goodRun = 0;
    this.#badRun = 0;
    this.#uncoveredRun = 0;
    this.#probeNotBefore = Math.max(this.#probeNotBefore, probeNotBefore);
  }

  #resetLookahead(): void {
    this.#probePending = 0;
    this.#laDraining = false;
    if (this.#lock !== LOCK_NONE) this.#unlock(this.#frame);
  }

  #maybeProbe(): void {
    if (this.#idle || !this.#playing || this.#lock !== LOCK_NONE || !this.#laOn() || this.#blocks.blockCount === 0) {
      return;
    }
    const f = this.#frame;
    if (this.#probePending !== 0) {
      if (f - this.#probeSentAt < this.#probeTimeout) return;
      this.#probePending = 0;
    }
    if (f - this.#lastProbeAt < this.#probeInterval || f < this.#probeNotBefore) return;
    const inL = this.#inL;
    const inR = this.#inR;
    const mask = this.#inMask;
    const data = this.#probeData;
    const from = f - PROBE_LENGTH;
    for (let i = 0; i < PROBE_LENGTH; i++) {
      const k = (from + i) & mask;
      data[i] = 0.5 * (inL[k]! + inR[k]!);
    }
    const msg = this.#probeMsg;
    msg.id = ++this.#probeSeq;
    msg.frameEnd = f;
    this.#probePending = msg.id;
    this.#probeSentAt = f;
    this.#lastProbeAt = f;
    this.#ports.postLa(msg);
  }

  #onProbeResult(msg: Extract<LaFromWorker, { type: 'probe-result' }>): void {
    if (msg.id !== this.#probePending) return;
    this.#probePending = 0;
    if (
      this.#lock !== LOCK_NONE ||
      !this.#laOn() ||
      !this.#playing ||
      !msg.found ||
      !(msg.score >= MIN_PROBE_SCORE) ||
      !(msg.gain > MIN_PROBE_GAIN) ||
      !Number.isFinite(msg.gain) ||
      !Number.isSafeInteger(msg.mediaEnd - msg.frameEnd)
    ) {
      return;
    }
    this.#lock = LOCK_PROVISIONAL;
    this.#lockTimeline = msg.timelineId;
    this.#lockOffset = msg.mediaEnd - msg.frameEnd;
    this.#lockGain = msg.gain;
    this.#sumXm = 0;
    this.#sumMm = 0;
    this.#goodRun = 0;
    this.#badRun = 0;
    this.#uncoveredRun = 0;
  }

  // ───────────── planned switches ─────────────

  /**
   * Sets the look-ahead gates of #select for the quantum starting at f0. Switching between a
   * delayed source and look-ahead output, or to another D, skips content or holds silence:
   * - entering look-ahead output at f skips [f − delay, f + D): it waits until that is speech-free;
   * - leaving it (look-ahead turned off) holds silence at content f + D, and so does a smaller D':
   *   those wait until the content around f + D is speech-free;
   * - a larger D' skips [f + D, f + D'): it waits until that is speech-free.
   * Changes of D by at most UNPLANNED_DELAY_STEP are not planned.
   * The search (#scan) covers SWITCH_SEARCH_SECONDS and otherwise picks the quietest candidate.
   * Without verified look-ahead output nothing is planned: urgent switches happen at once.
   */
  #updatePlan(f0: number): void {
    if (!this.#laVerified || !this.#laUsable()) {
      if (this.#laDraining) this.#resetLookahead();
      this.#plan = PLAN_NONE;
      this.#laDAt = Infinity;
      return;
    }
    const d = this.#outputLatency;
    if (this.#curKind !== SRC_LA) {
      if (this.#laDraining) {
        // The planned switch out of look-ahead output happened.
        this.#resetLookahead();
        this.#plan = PLAN_NONE;
        return;
      }
      this.#laD = d;
      this.#laDAt = Infinity;
      this.#laUntil = Infinity;
      const delay = this.#curDelay;
      // Silence is being held (a short mismatch, or no blocks): resuming skips only that.
      if (this.#curKind === SRC_HOLD || delay + d <= FADE) {
        this.#plan = PLAN_NONE;
        this.#laFrom = PAST;
      } else {
        this.#want(PLAN_ENTER, f0, -delay, d);
        this.#laFrom = this.#planAt;
      }
      return;
    }
    this.#laFrom = PAST;
    const laD = this.#laD;
    if (this.#laDraining) {
      this.#want(PLAN_LEAVE, f0, laD - FADE, laD + FADE);
      this.#laUntil = this.#planAt;
      return;
    }
    this.#laUntil = Infinity;
    if (Math.abs(d - laD) <= UNPLANNED_DELAY_STEP) {
      this.#laD = d;
      this.#laDAt = Infinity;
      this.#plan = PLAN_NONE;
      return;
    }
    if (d > laD) this.#want(PLAN_DELAY, f0, laD, d);
    else this.#want(PLAN_DELAY, f0, laD - FADE, laD + FADE);
    this.#laDNext = d;
    this.#laDAt = this.#planAt;
  }

  /** Continues planning switch `kind` for the span [f + a, f + b), or starts it at f0. */
  #want(kind: number, f0: number, a: number, b: number): void {
    if (
      this.#plan !== kind ||
      this.#planA !== a ||
      this.#planB !== b ||
      this.#planTimeline !== this.#lockTimeline ||
      this.#planOffset !== this.#lockOffset ||
      // The chosen moment passed without the switch (e.g. no block there): plan again.
      this.#planAt < f0
    ) {
      this.#plan = kind;
      this.#planA = a;
      this.#planB = b;
      this.#planTimeline = this.#lockTimeline;
      this.#planOffset = this.#lockOffset;
      this.#planStart = f0;
      this.#planAt = Infinity;
      this.#spanCells = Math.ceil((b - a) / CELL);
      this.#scanGrid = f0 + a - this.#prerollCells * CELL;
      this.#scanCell = 0;
      this.#scanEnd = this.#prerollCells + this.#candidates - 1 + this.#spanCells;
      this.#scanRun = 0;
      this.#scanEnv = 0;
      this.#scanRef = 0;
    }
    if (this.#planAt === Infinity) this.#scan(f0);
  }

  /**
   * Scans up to CELLS_PER_QUANTUM cells of the lock's speech blocks. Candidate k (switch at
   * planStart + k · CELL) covers cells [P + k, P + k + spanCells) (P preroll cells, which only
   * set the speech level reference). The first candidate still ahead of f0 whose cells are all
   * speech-free (below SPEECH_FREE_RATIO of the loudest speech envelope so far, or below
   * PRESENCE_FLOOR) is chosen. When the last candidate has been scanned or the search time is
   * over, the candidate ahead with the least speech energy is chosen (or f0 when none is left).
   * A cell without blocks ends the scan of this quantum: blocks may still arrive.
   */
  #scan(f0: number): void {
    const prefix = this.#cellPrefix;
    const blocks = this.#blocks;
    const cursor = this.#scanCursor;
    const timeline = this.#planTimeline;
    const preroll = this.#prerollCells;
    const span = this.#spanCells;
    const v2 = this.#lockGain * this.#lockGain;
    const coef = this.#cellEnvCoef;
    // Kept in locals (stored back below): doubles stored in fields per cell could be boxed.
    let run = this.#scanRun;
    let env = this.#scanEnv;
    let ref = this.#scanRef;
    let c = this.#scanCell;
    const stop = Math.min(this.#scanEnd, c + CELLS_PER_QUANTUM);
    let at = Infinity;
    for (; c < stop; c++) {
      const m0 = this.#scanGrid + c * CELL + this.#planOffset;
      const end = m0 + CELL;
      let sum = 0;
      let m = m0;
      while (m < end) {
        const b = blocks.find(timeline, m, cursor);
        if (b === null) break;
        const sl = b.speechL;
        const sr = b.speechR;
        const j1 = Math.min(end, b.end) - b.start;
        for (let j = m - b.start; j < j1; j++) {
          const l = sl[j]!;
          const r = sr[j]!;
          sum += l * l + r * r;
        }
        m = b.start + j1;
      }
      if (m < end) {
        if (c >= preroll) break;
        // Uncovered preroll (e.g. right after a seek): no reference from there.
        prefix[c + 1] = prefix[c]!;
        run = 0;
        continue;
      }
      let p = (v2 * sum) / (2 * CELL);
      if (p <= MAX_CELL_POWER) {
        env += (p - env) * coef;
        if (env > ref) ref = env;
      } else {
        p = MAX_CELL_POWER;
      }
      prefix[c + 1] = prefix[c]! + p;
      run = p <= Math.max(PRESENCE_FLOOR, SPEECH_FREE_RATIO * ref) ? run + 1 : 0;
      const k = c + 1 - preroll - span;
      if (k >= 0 && run >= span && this.#planStart + k * CELL >= f0) {
        at = this.#planStart + k * CELL;
        c++;
        break;
      }
    }
    this.#scanCell = c;
    this.#scanRun = run;
    this.#scanEnv = env;
    this.#scanRef = ref;
    if (at !== Infinity) {
      this.#planAt = at;
      return;
    }
    if (c < this.#scanEnd && f0 < this.#planStart + this.#searchFrames) return;
    // Quietest candidate ahead among those scanned (cells [P + k, P + k + span) all scanned).
    const last = c - preroll - span;
    let best = -1;
    let bestEnergy = Infinity;
    for (let k = Math.max(0, Math.ceil((f0 - this.#planStart) / CELL)); k <= last; k++) {
      const energy = prefix[preroll + k + span]! - prefix[preroll + k]!;
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = k;
      }
    }
    this.#planAt = best >= 0 ? this.#planStart + best * CELL : f0;
  }

  // ───────────── output ─────────────

  #render(f0: number, n: number, outL: Float32Array, outR: Float32Array | undefined): void {
    const histL = this.#histL;
    const histR = this.#histR;
    const fade = this.#fadeCurve;
    const counts = this.#modeCounts;
    const laOk = this.#laVerified && this.#laUsable();
    const enabled = this.#enabled;
    const fixedMode = !enabled ? -1 : this.#idle ? MODE_IDLE : -1;
    let outSq = 0;
    for (let o = 0; o < n; o++) {
      const f = f0 + o;
      this.#select(f, laOk);
      if (
        this.#dKind !== this.#curKind ||
        this.#dDelay !== this.#curDelay ||
        (this.#dKind === SRC_LA && (this.#dOffset !== this.#curOffset || this.#dTimeline !== this.#curTimeline))
      ) {
        this.#switchSource(f);
      }
      this.#curGain = this.#dGain;
      const kind = this.#curKind;
      if (kind !== SRC_HOLD) this.#presented = Math.max(this.#presented, f - this.#curDelay + 1);
      this.#evaluate(f, false);
      this.#updateGain(kind);
      const g = this.#gEff;
      let yl = this.#eSL + g * this.#eRL;
      let yr = this.#eSR + g * this.#eRR;
      const fading = this.#fadePos < FADE;
      if (fading) {
        let pl: number;
        let pr: number;
        if (this.#prevKind !== SRC_REFLECT && this.#evaluate(f, true)) {
          pl = this.#eSL + g * this.#eRL;
          pr = this.#eSR + g * this.#eRR;
        } else {
          if (this.#prevKind !== SRC_REFLECT) {
            this.#prevKind = SRC_REFLECT;
            this.#prevAnchor = f;
          }
          const k = (2 * this.#prevAnchor - 1 - f) & HISTORY_MASK;
          pl = histL[k]!;
          pr = histR[k]!;
        }
        const w = fade[this.#fadePos++]!;
        yl = pl + w * (yl - pl);
        yr = pr + w * (yr - pr);
      }
      outL[o] = yl;
      if (outR !== undefined) outR[o] = yr;
      const h = f & HISTORY_MASK;
      histL[h] = yl;
      histR[h] = yr;
      // Disabled: 'bypass' once the output is the input, the source's mode until then.
      const mode =
        fixedMode >= 0 ? fixedMode : !enabled && kind === SRC_BYPASS && !fading ? MODE_BYPASS : SOURCE_MODES[kind]!;
      counts[mode] = counts[mode]! + 1;
      outSq += yl * yl + yr * yr;
      if (this.#debug !== null) this.#captureDebug(f, h);
    }
    this.#outSq += outSq;
  }

  /** Chooses the desired source for output frame f and tracks real-time underruns. */
  #select(f: number, laOk: boolean): void {
    if (laOk && f >= this.#laFrom && f < this.#laUntil && this.#lookaheadCovers(f)) {
      this.#dKind = SRC_LA;
      this.#dDelay = -this.#laD;
      this.#inGap = false;
    } else if (!this.#enabled || !this.#rtHealthy) {
      // Disabled, or the real-time worker stopped answering: the input without delay.
      this.#dKind = SRC_BYPASS;
      this.#dDelay = 0;
    } else {
      const delay = this.#latency;
      const t = f - delay;
      const s = t & SPEECH_MASK;
      this.#dDelay = delay;
      if (this.#speechFrame[s] === t && this.#speechPass[s] === 0) {
        this.#dKind = SRC_RT;
        this.#inGap = false;
        this.#rtUsed = true;
      } else {
        // No model output for t: missing (an underrun) or a pass-through answer (the worker
        // skipped or failed the hop), which is no underrun. Both crossfade to the input itself.
        this.#dKind = SRC_PASS;
        if (this.#rtActive && this.#speechFrame[s] !== t) {
          // Not underruns: frames before the session started (re-enable, resume from idle), and a
          // gap re-entered after a latency increase replayed frames.
          if (!this.#inGap && this.#rtUsed && t >= this.#rtValidFrom && t > this.#lastGapT) this.#onUnderrun(f);
          this.#inGap = true;
          this.#lastGapT = t;
        }
      }
    }
    // Content that was already output (look-ahead leads every other source) is not output again:
    // hold silence until the source reaches new content. Steps back of at most one crossfade
    // (a jitter increase) are left to the crossfade.
    const behind = this.#presented - (f - this.#dDelay);
    if (behind > (this.#curKind === SRC_HOLD ? 0 : FADE)) this.#dKind = SRC_HOLD;
  }

  /** A block of the lock covers the look-ahead read position of output frame f (applies a planned D). */
  #lookaheadCovers(f: number): boolean {
    if (f >= this.#laDAt) {
      this.#laD = this.#laDNext;
      this.#laDAt = Infinity;
    }
    const m = f + this.#laD + this.#lockOffset;
    if (this.#blocks.find(this.#lockTimeline, m, this.#outCursor) === null) return false;
    this.#dOffset = this.#lockOffset;
    this.#dTimeline = this.#lockTimeline;
    this.#dGain = this.#lockGain;
    return true;
  }

  /** Makes the desired source current and starts a crossfade from the previous one. */
  #switchSource(f: number): void {
    if (this.#fadePos < FADE) {
      // A fade is in progress: fade out from what was actually output.
      this.#prevKind = SRC_REFLECT;
      this.#prevAnchor = f;
    } else {
      this.#prevKind = this.#curKind;
      this.#prevDelay = this.#curDelay;
      this.#prevOffset = this.#curOffset;
      this.#prevTimeline = this.#curTimeline;
      this.#prevGain = this.#curGain;
      this.#prevCursor.block = null;
    }
    this.#curKind = this.#dKind;
    this.#curDelay = this.#dDelay;
    this.#curOffset = this.#dOffset;
    this.#curTimeline = this.#dTimeline;
    this.#fadePos = 0;
  }

  /**
   * Evaluates the current (or, with `prev`, the faded-out) source at output frame f into (S, R)
   * with output = S + gEff · R. Returns false when the source has no data for f.
   * Source parameters are read from fields: passing fractional numbers to a call that is not
   * inlined would box them (allocate) on every sample.
   */
  #evaluate(f: number, prev: boolean): boolean {
    const kind = prev ? this.#prevKind : this.#curKind;
    const t = f - (prev ? this.#prevDelay : this.#curDelay);
    if (kind === SRC_LA) {
      const m = t + (prev ? this.#prevOffset : this.#curOffset);
      const b = prev
        ? this.#blocks.find(this.#prevTimeline, m, this.#prevCursor)
        : this.#blocks.find(this.#curTimeline, m, this.#outCursor);
      if (b === null) return false;
      const j = m - b.start;
      const gain = prev ? this.#prevGain : this.#curGain;
      // Non-finite model output is dropped (silence) before it reaches the output or the gate.
      const sl = b.speechL[j]!;
      const sr = b.speechR[j]!;
      const rl = b.residualL[j]!;
      const rr = b.residualR[j]!;
      this.#eSL = Number.isFinite(sl) ? gain * sl : 0;
      this.#eSR = Number.isFinite(sr) ? gain * sr : 0;
      this.#eRL = Number.isFinite(rl) ? gain * rl : 0;
      this.#eRR = Number.isFinite(rr) ? gain * rr : 0;
      // The input has not reached this media index yet: the element plays v · mix there.
      this.#eXMid = 0.5 * (this.#eSL + this.#eRL + this.#eSR + this.#eRR);
      return true;
    }
    if (kind === SRC_HOLD) {
      this.#eSL = 0;
      this.#eSR = 0;
      this.#eRL = 0;
      this.#eRR = 0;
      this.#eXMid = 0;
      return true;
    }
    const k = t & this.#inMask;
    const xl = this.#inL[k]!;
    const xr = this.#inR[k]!;
    if (kind === SRC_RT) {
      const s = t & SPEECH_MASK;
      // A pass-through answer has no model output to fade from: the fade reflects instead.
      if (this.#speechFrame[s] !== t || this.#speechPass[s] !== 0) return false;
      const speech = this.#speech[s]!;
      this.#eSL = speech;
      this.#eSR = speech;
      this.#eRL = xl - speech;
      this.#eRR = xr - speech;
    } else {
      this.#eSL = xl;
      this.#eSR = xr;
      this.#eRL = 0;
      this.#eRR = 0;
    }
    this.#eXMid = 0.5 * (xl + xr);
    return true;
  }

  /** Advances the residual gain ramp and the gap gate; sets gEff for this sample. */
  #updateGain(kind: number): void {
    if (this.#gainRampLeft > 0) {
      this.#gain = --this.#gainRampLeft === 0 ? this.#gainTarget : this.#gain + this.#gainStep;
    }
    if (kind === SRC_RT || kind === SRC_LA) {
      const s = 0.5 * (this.#eSL + this.#eSR);
      const x = this.#eXMid;
      this.#envSpeech += (s * s - this.#envSpeech) * this.#envCoef;
      this.#envInput += (x * x - this.#envInput) * this.#envCoef;
      // Self-healing: a non-finite input sample must not stop the gate for good.
      if (!Number.isFinite(this.#envSpeech)) this.#envSpeech = 0;
      if (!Number.isFinite(this.#envInput)) this.#envInput = 0;
      const present = this.#envSpeech > this.#envInput * PRESENCE_RATIO && this.#envSpeech > PRESENCE_FLOOR;
      const target = !this.#gapReduction || present ? 1 : GATE_FLOOR;
      const d = target - this.#gate;
      if (d !== 0) this.#gate += d * (d > 0 ? this.#attackCoef : this.#releaseCoef);
    }
    this.#gEff = this.#gain * this.#gate;
  }

  /** Registers an underrun event; enough of them within the window grow the jitter allowance. */
  #onUnderrun(f: number): void {
    this.#underruns++;
    this.#lastUnderrunAt = f;
    this.#cleanFrames = 0;
    const times = this.#underrunTimes;
    times[this.#underrunPos] = f;
    this.#underrunPos = (this.#underrunPos + 1) % UNDERRUN_EVENTS;
    if (this.#underrunCount < UNDERRUN_EVENTS) this.#underrunCount++;
    // times[underrunPos] is now the oldest of the last UNDERRUN_EVENTS events.
    if (this.#underrunCount === UNDERRUN_EVENTS && f - times[this.#underrunPos]! <= this.#underrunWindow) {
      this.#underrunCount = 0;
      if (this.#jitter < this.#maxJitter) {
        this.#jitter = Math.min(this.#maxJitter, this.#jitter + JITTER_STEP);
        this.#latency = DFN_DELAY + this.#jitter;
      }
    }
  }

  /** Lowers a grown jitter allowance by one step after JITTER_DECAY_SECONDS of clean real-time output. */
  #relaxJitter(n: number): void {
    this.#cleanFrames += n;
    if (this.#cleanFrames < this.#decayFrames) return;
    this.#cleanFrames = 0;
    this.#jitter = Math.max(this.#initialJitter, this.#jitter - JITTER_STEP);
    this.#latency = DFN_DELAY + this.#jitter;
  }

  // ───────────── frame counter rebase ─────────────

  /**
   * Moves the frame domain back by a multiple of REBASE_UNIT (which every ring size divides, so
   * ring contents stay valid) to keep the counters small integers: beyond V8's Smi range every
   * frame index would be a heap number and process() would allocate. Media offsets move forward
   * by the same amount; event times older than REBASE_UNIT frames become −REBASE_UNIT, which
   * every interval test treats like −Infinity. Speech answers on their way are translated in
   * onRt() (the worker just sees hop indices jump back); a probe in flight is dropped.
   */
  #rebase(): void {
    const frame = this.#frame;
    const shift = frame - (frame % REBASE_UNIT) - REBASE_UNIT;
    this.#rebaseShift = shift;
    this.#frame = frame - shift;
    this.#presented = this.#back(this.#presented);
    this.#statsFrom = this.#back(this.#statsFrom);
    // Real-time path. Sent-hop slots count hops from the session start: keep them by moving the
    // start by whole rings of hops only.
    const ring = RT_HOP * SENT_RING;
    this.#hopSessionStart = this.#back(this.#hopIndex - ((this.#hopIndex - this.#hopSessionStart) % ring));
    this.#hopIndex = this.#back(this.#hopIndex);
    this.#rtValidFrom = this.#back(this.#rtValidFrom);
    this.#rtWaitFrom = this.#back(this.#rtWaitFrom);
    this.#lastSpeechAt = this.#back(this.#lastSpeechAt);
    this.#lastBeatAt = this.#back(this.#lastBeatAt);
    this.#lastUnderrunAt = this.#back(this.#lastUnderrunAt);
    this.#lastGapT = this.#back(this.#lastGapT);
    this.#backAll(this.#speechFrame);
    this.#backAll(this.#sentIndex);
    this.#backAll(this.#sentFrame);
    this.#backAll(this.#underrunTimes);
    // Look-ahead path and planned switch.
    this.#lockOffset += shift;
    this.#planOffset += shift;
    this.#dOffset += shift;
    this.#curOffset += shift;
    this.#prevOffset += shift;
    this.#prevAnchor = this.#back(this.#prevAnchor);
    this.#badStart = this.#back(this.#badStart);
    this.#probeNotBefore = this.#back(this.#probeNotBefore);
    this.#lastProbeAt = this.#back(this.#lastProbeAt);
    this.#probeSentAt = this.#back(this.#probeSentAt);
    this.#probePending = 0;
    this.#laFrom = this.#back(this.#laFrom);
    this.#laUntil = this.#back(this.#laUntil);
    this.#laDAt = this.#back(this.#laDAt);
    this.#planStart = this.#back(this.#planStart);
    this.#planAt = this.#back(this.#planAt);
    this.#scanGrid = this.#back(this.#scanGrid);
  }

  /** `x` in the rebased frame domain (see #rebase). */
  #back(x: number): number {
    return Math.max(x - this.#rebaseShift, -REBASE_UNIT);
  }

  #backAll(a: Float64Array): void {
    for (let k = 0; k < a.length; k++) a[k] = this.#back(a[k]!);
  }

  // ───────────── stats and debug capture ─────────────

  /** Posts the stats every STATS_SECONDS, and at once when a disabled mixer has reached bypass. */
  #maybePostStats(): void {
    if (this.#bypassPending && this.#curKind === SRC_BYPASS && this.#fadePos === FADE) {
      // From the next quantum on the output is the input: the controller may take the mixer out.
      this.#bypassPending = false;
      this.#postStats(MODE_BYPASS);
    } else if (this.#frame - this.#statsFrom >= this.#statsPeriod) {
      this.#postStats(MODE_MAJORITY);
    }
  }

  /** Posts the stats since the last report with `mode` (MODE_MAJORITY: that of most samples). */
  #postStats(mode: number): void {
    const frames = this.#frame - this.#statsFrom;
    const counts = this.#modeCounts;
    if (mode === MODE_MAJORITY) {
      mode = 0;
      for (let k = 1; k < counts.length; k++) if (counts[k]! > counts[mode]!) mode = k;
    }
    const stats = this.#stats;
    stats.mode = MODE_NAMES[mode]!;
    stats.locked = this.#lock === LOCK_LOCKED;
    // Look-ahead output is in sync with the picture (it leads the input by D): 0, like bypass.
    stats.latency = Math.max(0, this.#curDelay);
    stats.underruns = this.#underruns;
    stats.inRms = Math.sqrt(this.#inSq / (2 * frames));
    stats.outRms = Math.sqrt(this.#outSq / (2 * frames));
    const readPos = this.#frame + this.#laD + this.#lockOffset;
    stats.laAhead =
      this.#lock === LOCK_LOCKED ? this.#blocks.contiguousAhead(this.#lockTimeline, readPos) / this.#sampleRate : 0;
    stats.rtRoundTripMs = (this.#rtRoundTrip * 1000) / this.#sampleRate;
    stats.rtHealthy = this.#rtHealthy;
    this.#ports.postMain(this.#statsMsg);
    counts.fill(0);
    this.#inSq = 0;
    this.#outSq = 0;
    this.#statsFrom = this.#frame;
  }

  #startDebug(seconds: number): void {
    const frames = Math.round(Math.min(MAX_DEBUG_SECONDS, seconds) * this.#sampleRate);
    if (!(frames > 0)) {
      this.#debug = null;
      return;
    }
    this.#debug = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
    this.#debugPos = 0;
  }

  /**
   * Records the input x[f] as it arrived (not delayed) and the output y[f] of the same frames f.
   * Real-time output lags the input by L and look-ahead output leads it by D, so consumers locate
   * the output in the content themselves (e.g. by correlation).
   */
  #captureDebug(f: number, h: number): void {
    const debug = this.#debug!;
    const k = f & this.#inMask;
    const pos = this.#debugPos++;
    debug[0][pos] = this.#inL[k]!;
    debug[1][pos] = this.#inR[k]!;
    debug[2][pos] = this.#histL[h]!;
    debug[3][pos] = this.#histR[h]!;
    if (this.#debugPos < debug[0].length) return;
    this.#debug = null;
    this.#ports.postMain({ type: 'debug-recording', input: [debug[0], debug[1]], output: [debug[2], debug[3]] }, [
      debug[0].buffer,
      debug[1].buffer,
      debug[2].buffer,
      debug[3].buffer,
    ]);
  }
}
