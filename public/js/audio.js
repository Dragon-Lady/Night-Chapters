/**
 * Night Chapters — gentle ambient + soft cues via Web Audio API only.
 * No samples, no deps. Wonder-first; never harsh.
 * NC_BUILD 1.7.33 — includes sensorPing for forward scanner
 *
 * Chapter ambients: rain | warm | cold | rose
 * Cues: pin chime, mystery hum, sensor ping, wind whoosh, rest = silence ambient
 */

const PRESETS = {
  rain: {
    // soft rain + distant tone
    droneFreq: 110,
    droneType: "sine",
    droneGain: 0.018,
    noiseGain: 0.045,
    noiseFilter: 1200,
    noiseQ: 0.4,
    lfoRate: 0.08,
    secondFreq: 165,
    secondGain: 0.008,
  },
  warm: {
    droneFreq: 98,
    droneType: "triangle",
    droneGain: 0.022,
    noiseGain: 0.012,
    noiseFilter: 800,
    noiseQ: 0.6,
    lfoRate: 0.05,
    secondFreq: 196,
    secondGain: 0.012,
  },
  cold: {
    droneFreq: 82,
    droneType: "sine",
    droneGain: 0.016,
    noiseGain: 0.02,
    noiseFilter: 2800,
    noiseQ: 0.3,
    lfoRate: 0.12,
    secondFreq: 246,
    secondGain: 0.006,
  },
  rose: {
    droneFreq: 130.8,
    droneType: "sine",
    droneGain: 0.02,
    noiseGain: 0.015,
    noiseFilter: 1600,
    noiseQ: 0.5,
    lfoRate: 0.06,
    secondFreq: 196,
    secondGain: 0.01,
  },
};

export function createAudio() {
  let ctx = null;
  let master = null;
  let ambientGain = null;
  let cueGain = null;
  let windGain = null;
  let noiseSrc = null;
  let noiseFilter = null;
  let drone = null;
  let drone2 = null;
  let lfo = null;
  let lfoGain = null;
  let windFilter = null;
  let windSrc = null;
  let started = false;
  let muted = loadMute();
  let ambientOn = false;
  let currentMood = "rain";
  let restSilent = false;

  function loadMute() {
    try {
      return localStorage.getItem("night-chapters.audioMuted.v1") === "1";
    } catch {
      return false;
    }
  }

  function saveMute() {
    try {
      localStorage.setItem(
        "night-chapters.audioMuted.v1",
        muted ? "1" : "0"
      );
    } catch {
      /* ignore */
    }
  }

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ctx.destination);

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(master);

    cueGain = ctx.createGain();
    cueGain.gain.value = muted ? 0 : 0.55;
    cueGain.connect(master);

    windGain = ctx.createGain();
    windGain.gain.value = 0;
    windGain.connect(master);

    // Shared pink-ish noise buffer
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
    }

    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 1200;
    noiseFilter.Q.value = 0.4;
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(ambientGain);
    noiseSrc.start();

    drone = ctx.createOscillator();
    drone.type = "sine";
    drone.frequency.value = 110;
    const droneG = ctx.createGain();
    droneG.gain.value = 0.018;
    drone.connect(droneG);
    droneG.connect(ambientGain);
    drone._gain = droneG;
    drone.start();

    drone2 = ctx.createOscillator();
    drone2.type = "sine";
    drone2.frequency.value = 165;
    const drone2G = ctx.createGain();
    drone2G.gain.value = 0.008;
    drone2.connect(drone2G);
    drone2G.connect(ambientGain);
    drone2._gain = drone2G;
    drone2.start();

    lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.004;
    lfo.connect(lfoGain);
    lfoGain.connect(droneG.gain);
    lfo.start();

    // Wind layer (separate noise, highpassed)
    windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = "highpass";
    windFilter.frequency.value = 400;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windSrc.start();

    started = true;
    return true;
  }

  async function unlock() {
    if (!ensure()) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* user gesture may still be needed */
      }
    }
    return true;
  }

  function setMuted(m) {
    muted = !!m;
    saveMute();
    if (!master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.linearRampToValueAtTime(muted ? 0 : 0.85, t + 0.15);
    if (cueGain) cueGain.gain.value = muted ? 0 : 0.55;
  }

  function toggleMute() {
    setMuted(!muted);
    return muted;
  }

  function applyPreset(mood) {
    const p = PRESETS[mood] || PRESETS.rain;
    currentMood = mood in PRESETS ? mood : "rain";
    if (!ensure()) return;
    const t = ctx.currentTime;
    noiseFilter.frequency.setTargetAtTime(p.noiseFilter, t, 0.5);
    noiseFilter.Q.setTargetAtTime(p.noiseQ, t, 0.5);
    drone.type = p.droneType;
    drone.frequency.setTargetAtTime(p.droneFreq, t, 0.8);
    drone._gain.gain.setTargetAtTime(p.droneGain, t, 0.5);
    drone2.frequency.setTargetAtTime(p.secondFreq, t, 0.8);
    drone2._gain.gain.setTargetAtTime(p.secondGain, t, 0.5);
    lfo.frequency.setTargetAtTime(p.lfoRate, t, 0.5);
    // noise relative gain via ambient — filter does most of the character
  }

  function startAmbient(mood = "rain") {
    if (!ensure()) return;
    applyPreset(mood);
    restSilent = false;
    ambientOn = true;
    const t = ctx.currentTime;
    const target = muted ? 0 : 1;
    ambientGain.gain.cancelScheduledValues(t);
    ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
    ambientGain.gain.linearRampToValueAtTime(target * 0.9, t + 1.8);
  }

  function stopAmbient({ fade = 1.2 } = {}) {
    if (!ambientGain || !ctx) return;
    ambientOn = false;
    const t = ctx.currentTime;
    ambientGain.gain.cancelScheduledValues(t);
    ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
    ambientGain.gain.linearRampToValueAtTime(0, t + fade);
  }

  /** Rest: silence ambient gently; wind also off */
  function enterRestSilence() {
    restSilent = true;
    if (!ctx || !ambientGain) return;
    const t = ctx.currentTime;
    ambientGain.gain.cancelScheduledValues(t);
    ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
    ambientGain.gain.linearRampToValueAtTime(0, t + 0.9);
    setWind(0);
  }

  function leaveRestSilence() {
    if (!restSilent) return;
    restSilent = false;
    if (ambientOn) startAmbient(currentMood);
  }

  /**
   * Wind whoosh intensity from throttle 0–1
   */
  function setWind(throttle = 0) {
    if (!ensure() || !windGain) return;
    if (muted || restSilent) {
      windGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      return;
    }
    const t = Math.max(0, Math.min(1, throttle));
    // only audible when actually gliding
    const level = t < 0.05 ? 0 : 0.008 + t * 0.055;
    windGain.gain.setTargetAtTime(level, ctx.currentTime, 0.12);
    if (windFilter) {
      windFilter.frequency.setTargetAtTime(350 + t * 2200, ctx.currentTime, 0.15);
    }
  }

  function tone({ freq, type = "sine", dur = 0.4, gain = 0.08, when = 0 }) {
    if (!ensure() || muted) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(cueGain);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** Soft two-note pin arrival chime */
  function pinChime() {
    if (!ensure() || muted) return;
    tone({ freq: 523.25, type: "sine", dur: 0.55, gain: 0.06 }); // C5
    tone({ freq: 659.25, type: "sine", dur: 0.7, gain: 0.04, when: 0.08 }); // E5
  }

  /** Mystery glow hum — low gentle pulse */
  function mysteryHum() {
    if (!ensure() || muted) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(180, t0);
    o.frequency.linearRampToValueAtTime(220, t0 + 1.2);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.045, t0 + 0.3);
    g.gain.linearRampToValueAtTime(0.02, t0 + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.8);
    o.connect(g);
    g.connect(cueGain);
    o.start(t0);
    o.stop(t0 + 2);
  }

  /** Soft UI blip */
  function uiTap() {
    tone({ freq: 440, type: "sine", dur: 0.12, gain: 0.03 });
  }

  /**
   * Forward sensor ping — quiet sonar-like blip (Star Trek soft, not arcade).
   * strength 0–1 scales gain; pitch drops slightly when closing.
   */
  function sensorPing({ strength = 0.5, closing = false } = {}) {
    if (!ensure() || muted || restSilent) return;
    const s = Math.max(0.15, Math.min(1, Number(strength) || 0.5));
    const base = closing ? 520 : 640;
    const t0 = ctx.currentTime;
    // Soft sine + faint bandpass noise tick
    tone({
      freq: base,
      type: "sine",
      dur: 0.22,
      gain: 0.012 * s,
      when: 0,
    });
    tone({
      freq: base * 0.72,
      type: "sine",
      dur: 0.28,
      gain: 0.007 * s,
      when: 0.03,
    });
    try {
      const bufferSize = 2048;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.12));
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(base * 1.1, t0);
      bp.Q.setValueAtTime(4, t0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.008 * s, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      src.connect(bp);
      bp.connect(g);
      g.connect(cueGain);
      src.start(t0);
      src.stop(t0 + 0.2);
    } catch {
      /* optional noise tick */
    }
  }

  function setChapterMood(moodOrSky) {
    let mood = "rain";
    if (typeof moodOrSky === "string") mood = moodOrSky;
    else if (moodOrSky?.mood) mood = moodOrSky.mood;
    applyPreset(mood);
    if (ambientOn && !restSilent) startAmbient(mood);
  }

  return {
    unlock,
    startAmbient,
    stopAmbient,
    enterRestSilence,
    leaveRestSilence,
    setWind,
    pinChime,
    mysteryHum,
    uiTap,
    sensorPing,
    setChapterMood,
    setMuted,
    toggleMute,
    get muted() {
      return muted;
    },
    get ready() {
      return started;
    },
  };
}
