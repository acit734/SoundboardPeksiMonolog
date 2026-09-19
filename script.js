/* ============================================================
   SOUNDBOARD — script.js
   ------------------------------------------------------------
   • 4 file suara diambil dari direktori lokal sebagai Blob
     (fetch → Blob → ArrayBuffer → AudioBuffer).
   • TIDAK memakai elemen <audio> sama sekali.
   • Semua sound di-loop (source.loop = true).
   • Setiap pad punya pengaturan sendiri:
       - Fade In  (ms)     → input di kartu
       - Fade Out (ms)     → input di kartu
       - Volume   (0–100%) → slider di kartu
   • Suara bisa ditumpuk (stack) tanpa batas.
   • Volume bisa diubah saat sedang berbunyi (real-time ramp).
   • Pause menyimpan posisi (loop-aware), tombol play berubah
     jadi "mulai kembali".
   • Stop menghentikan semua lapisan suara dengan fade out.
   ============================================================ */

/* ------------------------------------------------------------
   1. Audio Context global
   ------------------------------------------------------------ */
const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioCtxClass();

/* ------------------------------------------------------------
   2. Konfigurasi 4 sound
      Ganti "file" sesuai nama file di folder sounds/
   ------------------------------------------------------------ */
const SOUNDS = [
  { id: "s1", title: "White Noise",       file: "sounds/white_noise.mp3",      icon: "fa-tv"     },
  { id: "s2", title: "Suasana Flashback", file: "sounds/suasana_flashback.mp3", icon: "fa-camera" },
  { id: "s3", title: "Tegang",            file: "sounds/tegang.mp3",           icon: "fa-bolt"   },
  { id: "s4", title: "Tenang",            file: "sounds/tenang.mp3",           icon: "fa-water"  },
];

/* ------------------------------------------------------------
   3. Helper
   ------------------------------------------------------------ */
const FADE_MIN = 0;
const FADE_MAX = 10000; // 10 detik
const MIN_GAIN = 0.0001; // batas bawah untuk exponentialRamp

function clampFade(value) {
  if (isNaN(value)) return 0;
  return Math.max(FADE_MIN, Math.min(FADE_MAX, value));
}

function clampVolume(value) {
  if (isNaN(value)) return 100;
  return Math.max(0, Math.min(100, value));
}

/* ------------------------------------------------------------
   4. Kelas SoundPad
   ------------------------------------------------------------ */
class SoundPad {
  constructor(config, element) {
    this.config = config;
    this.el = element;

    this.buffer = null;          // AudioBuffer hasil decode
    this.blob = null;            // Blob mentah dari fetch

    this.instances = new Set();  // instance yang sedang berbunyi
    this.pausedSnapshots = [];   // posisi suara saat di-pause
    this.state = "idle";         // idle | playing | paused

    this.refs = {
      play:        element.querySelector(".ctrl-play"),
      playIcon:    element.querySelector(".ctrl-play i"),
      pause:       element.querySelector(".ctrl-pause"),
      stop:        element.querySelector(".ctrl-stop"),
      badge:       element.querySelector(".pad-badge"),
      sub:         element.querySelector(".pad-sub"),
      fadeIn:      element.querySelector(".fade-in-input"),
      fadeOut:     element.querySelector(".fade-out-input"),
      volume:      element.querySelector(".volume-slider"),
      volumeValue: element.querySelector(".volume-value"),
    };

    // Volume awal (0..1)
    this.volume = clampVolume(parseInt(this.refs.volume?.value, 10)) / 100;
    this.#renderVolumeLabel();

    this.#bindUI();
    this.render();
  }

  /* ---------- Muat file sebagai BLOB (bukan <audio>) ---------- */
  async load() {
    try {
      const response = await fetch(this.config.file);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // >>> File suara berubah menjadi Blob di memori <<<
      this.blob = await response.blob();

      // Blob → ArrayBuffer → AudioBuffer (di-decode oleh Web Audio API)
      const arrayBuffer = await this.blob.arrayBuffer();
      this.buffer = await audioCtx.decodeAudioData(arrayBuffer);

      this.el.classList.add("is-ready");
      this.refs.sub.textContent =
        `${this.config.file} · ${(this.blob.size / 1024).toFixed(0)} KB · loop`;
    } catch (error) {
      console.error(`[Soundboard] Gagal memuat ${this.config.file}`, error);
      this.el.classList.add("is-error");
      this.refs.sub.textContent = "gagal dimuat — cek folder sounds/";
    }
  }

  /* ---------- Getter nilai input per-pad ---------- */
  getFadeIn() {
    return clampFade(parseInt(this.refs.fadeIn?.value, 10));
  }

  getFadeOut() {
    return clampFade(parseInt(this.refs.fadeOut?.value, 10));
  }

  getVolume() {
    return clampVolume(parseInt(this.refs.volume?.value, 10)) / 100;
  }

  /* ---------- Event handler ---------- */
  #bindUI() {
    this.refs.play.addEventListener("click", () => this.handlePlay());
    this.refs.pause.addEventListener("click", () => this.handlePause());
    this.refs.stop.addEventListener("click", () => this.handleStop());

    // Validasi input fade saat blur (biar rapi)
    this.refs.fadeIn?.addEventListener("blur", () => {
      const v = clampFade(parseInt(this.refs.fadeIn.value, 10));
      this.refs.fadeIn.value = isNaN(v) ? 0 : v;
    });
    this.refs.fadeOut?.addEventListener("blur", () => {
      const v = clampFade(parseInt(this.refs.fadeOut.value, 10));
      this.refs.fadeOut.value = isNaN(v) ? 0 : v;
    });

    // Volume real-time
    this.refs.volume?.addEventListener("input", () => {
      this.volume = this.getVolume();
      this.#renderVolumeLabel();
      this.#applyVolumeRealtime();
    });
  }

  #renderVolumeLabel() {
    if (!this.refs.volumeValue) return;
    this.refs.volumeValue.textContent = `${Math.round(this.volume * 100)}%`;
  }

  /* ---------- PLAY / STACK / RESUME ---------- */
  async handlePlay() {
    // AudioContext baru boleh hidup setelah interaksi user
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    if (!this.buffer) return; // belum selesai dimuat

    // Sinkronkan volume dari slider (kalau user baru menggeser)
    this.volume = this.getVolume();

    const fadeInMs = this.getFadeIn();

    // Kalau sedang pause → lanjutkan dari posisi terakhir (fade in)
    if (this.state === "paused") {
      const snapshots = this.pausedSnapshots;
      this.pausedSnapshots = [];

      this.setState("playing");
      snapshots.forEach((snap) =>
        this.#startInstance(snap.offset, fadeInMs)
      );
      return;
    }

    // Idle atau sedang playing → selalu buat instance baru (STACK)
    this.#startInstance(0, fadeInMs);
    this.setState("playing");
  }

  /* ---------- PAUSE (fade out + simpan posisi) ---------- */
  handlePause() {
    if (this.state !== "playing") return;

    const fadeOutMs = this.getFadeOut();
    const snapshots = [];
    const duration = this.buffer?.duration || 0;

    this.instances.forEach((inst) => {
      // Hitung posisi saat ini (loop-aware)
      const elapsed = audioCtx.currentTime - inst.startTime + inst.offset;
      const loopedOffset = duration > 0
        ? ((elapsed % duration) + duration) % duration
        : 0;

      snapshots.push({ offset: loopedOffset });

      // Fade out lalu hentikan source
      this.#fadeOutAndStop(inst, fadeOutMs);
    });

    this.instances.clear();
    this.pausedSnapshots = snapshots;
    this.setState("paused");
  }

  /* ---------- STOP (fade out) ---------- */
  handleStop() {
    const fadeOutMs = this.getFadeOut();

    this.instances.forEach((inst) => {
      this.#fadeOutAndStop(inst, fadeOutMs);
    });

    this.instances.clear();
    this.pausedSnapshots = [];
    this.setState("idle");
  }

  /* ---------- Internal: ubah volume semua instance real-time ---------- */
  #applyVolumeRealtime() {
    if (this.instances.size === 0) return;

    const now = audioCtx.currentTime;
    const target = Math.max(this.volume, MIN_GAIN);

    this.instances.forEach((inst) => {
      try {
        const current = Math.max(inst.gain.gain.value, MIN_GAIN);
        inst.gain.gain.cancelScheduledValues(now);
        inst.gain.gain.setValueAtTime(current, now);
        // Ramp pendek supaya tidak "klik"
        inst.gain.gain.exponentialRampToValueAtTime(target, now + 0.05);
      } catch (_) {
        /* abaikan */
      }
    });
  }

  /* ---------- Internal: buat satu lapisan suara (loop + fade in) ---------- */
  #startInstance(offset = 0, fadeInMs = 0) {
    if (!this.buffer) return;

    const source = audioCtx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;               // >>> LOOPING AKTIF <<<

    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    const targetGain = Math.max(this.volume, MIN_GAIN);

    if (fadeInMs > 0) {
      gain.gain.setValueAtTime(MIN_GAIN, now);
      gain.gain.exponentialRampToValueAtTime(
        targetGain,
        now + fadeInMs / 1000
      );
    } else {
      gain.gain.setValueAtTime(targetGain, now);
    }

    source.connect(gain);
    gain.connect(audioCtx.destination);

    const instance = {
      source,
      gain,
      offset,
      startTime: now,
      finished: false,
    };

    source.onended = () => {
      if (instance.finished) return;
      instance.finished = true;
      this.instances.delete(instance);

      if (this.instances.size === 0 && this.state === "playing") {
        this.setState("idle");
      } else {
        this.render();
      }
    };

    // Aman untuk looping: pastikan offset dalam rentang durasi buffer
    const duration = this.buffer.duration || 0;
    const safeOffset = duration > 0
      ? ((offset % duration) + duration) % duration
      : 0;

    source.start(0, safeOffset);
    this.instances.add(instance);
    this.render();
  }

  /* ---------- Internal: fade out halus lalu stop source ---------- */
  #fadeOutAndStop(instance, fadeOutMs) {
    const now = audioCtx.currentTime;
    const currentGain = instance.gain.gain.value;

    // Tandai sudah "selesai" agar onended tidak memicu state idle
    instance.finished = true;

    try {
      instance.gain.gain.cancelScheduledValues(now);
      instance.gain.gain.setValueAtTime(
        Math.max(currentGain, MIN_GAIN),
        now
      );

      if (fadeOutMs > 0) {
        instance.gain.gain.exponentialRampToValueAtTime(
          MIN_GAIN,
          now + fadeOutMs / 1000
        );
      } else {
        instance.gain.gain.setValueAtTime(MIN_GAIN, now);
      }
    } catch (_) {
      /* abaikan error scheduling */
    }

    setTimeout(() => {
      try { instance.source.stop(); } catch (_) {}
    }, fadeOutMs + 30);
  }

  /* ---------- State + render ---------- */
  setState(nextState) {
    this.state = nextState;
    this.render();
  }

  render() {
    const { el, refs } = this;

    el.classList.toggle("is-playing", this.state === "playing");
    el.classList.toggle("is-paused", this.state === "paused");

    // Ikon tombol utama: play ↔ mulai-kembali
    refs.playIcon.className =
      this.state === "paused"
        ? "fa-solid fa-rotate-right"
        : "fa-solid fa-play";

    refs.play.title =
      this.state === "paused"
        ? "Mulai kembali"
        : this.state === "playing"
        ? "Tumpuk suara lagi (stack)"
        : "Putar (loop)";

    // Badge jumlah lapisan aktif
    const count =
      this.state === "paused"
        ? this.pausedSnapshots.length
        : this.instances.size;

    refs.badge.textContent = `×${count}`;
    refs.badge.classList.toggle("show", count > 0);
  }
}

/* ------------------------------------------------------------
   5. Bangun kartu pad di DOM
   ------------------------------------------------------------ */
function buildPad(config) {
  const pad = document.createElement("article");
  pad.className = "pad";
  pad.dataset.id = config.id;

  pad.innerHTML = `
    <div class="pad-ring"></div>

    <div class="pad-top">
      <div class="pad-icon"><i class="fa-solid ${config.icon}"></i></div>
      <span class="pad-badge">×0</span>
    </div>

    <h2 class="pad-title">${config.title}</h2>
    <p class="pad-sub">memuat…</p>

    <!-- Fade In / Fade Out per-sound -->
    <div class="pad-settings">
      <label class="mini-field" title="Fade In (ms)">
        <span>In</span>
        <input
          class="fade-in-input"
          type="number"
          value="500"
          min="0"
          max="10000"
          step="50"
          inputmode="numeric"
        />
        <em>ms</em>
      </label>

      <label class="mini-field" title="Fade Out (ms)">
        <span>Out</span>
        <input
          class="fade-out-input"
          type="number"
          value="500"
          min="0"
          max="10000"
          step="50"
          inputmode="numeric"
        />
        <em>ms</em>
      </label>
    </div>

    <!-- Volume per-sound -->
    <div class="pad-volume">
      <i class="fa-solid fa-volume-low"></i>
      <input
        class="volume-slider"
        type="range"
        min="0"
        max="100"
        value="100"
        step="1"
        aria-label="Volume ${config.title}"
      />
      <span class="volume-value">100%</span>
    </div>

    <!-- Kontrol play / pause / stop -->
    <div class="pad-controls">
      <button class="ctrl ctrl-play" type="button" title="Putar (loop)" aria-label="Putar ${config.title}">
        <i class="fa-solid fa-play"></i>
      </button>
      <button class="ctrl ctrl-pause" type="button" title="Pause" aria-label="Pause ${config.title}">
        <i class="fa-solid fa-pause"></i>
      </button>
      <button class="ctrl ctrl-stop" type="button" title="Stop" aria-label="Stop ${config.title}">
        <i class="fa-solid fa-stop"></i>
      </button>
    </div>
  `;

  return pad;
}

/* ------------------------------------------------------------
   6. Inisialisasi
   ------------------------------------------------------------ */
async function initSoundboard() {
  const grid = document.getElementById("padGrid");
  if (!grid) return;

  const pads = SOUNDS.map((config) => {
    const el = buildPad(config);
    grid.appendChild(el);
    return new SoundPad(config, el);
  });

  // Muat keempat Blob secara paralel
  await Promise.all(pads.map((pad) => pad.load()));
}

document.addEventListener("DOMContentLoaded", initSoundboard);

/* ------------------------------------------------------------
   7. Resume AudioContext pada interaksi pertama
   ------------------------------------------------------------ */
document.addEventListener(
  "pointerdown",
  () => {
    if (audioCtx.state === "suspended") audioCtx.resume();
  },
  { passive: true }
);