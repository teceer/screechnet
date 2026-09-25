// Demodulators. ES module shared by the AudioWorklet and the Node tests.
import { COSTAS, MARK, HEADER_BYTES, BLOCK_BYTES, MAGIC, blockSymbols, decodeBlock, softBitsFromSpectrum } from './fec.js';

// ——— FskDemod: non-coherent FSK with async (8N1) UART framing ———
//
// Per sample it correlates the input with the mark and space tones over a
// sliding window of exactly one bit (a matched filter), then:
//   - carrier detect = share of total energy sitting in the two tones (level independent)
//   - bit decision   = which tone is louder
//   - byte clock     = restarted on every start bit, so sound card drift never matters

export class FskDemod {
  constructor(mode, fs) {
    this.mode = mode;
    this.spb = fs / mode.baud;
    const N = (this.N = Math.max(8, Math.round(this.spb)));
    this.rot = [mode.mark, mode.space].map((f) => [Math.cos((2 * Math.PI * f) / fs), Math.sin((2 * Math.PI * f) / fs)]);
    this.osc = [1, 0, 1, 0]; // mark cos/sin, space cos/sin
    this.buf = [0, 1, 2, 3, 4].map(() => new Float64Array(N)); // mI mQ sI sQ power
    this.sum = new Float64Array(5);
    this.i = 0;
    this.t = 0;
    this.lock = 0;
    this.k = 1 / (2 * N);
    this.floor = 1e-7 * N; // about -70 dBFS
    this.carrier = false;
    this.state = 0; // 0 waiting for mark, 1 armed, 2 inside a byte
    this.onByte = null;
    this.onCarrier = null;
  }

  push(x) {
    const o = this.osc, b = this.buf, s = this.sum, i = this.i;
    for (let j = 0; j < 5; j++) {
      const v = x * (j < 4 ? o[j] : x);
      s[j] += v - b[j][i];
      b[j][i] = v;
    }
    // advance both oscillators by rotation instead of calling sin/cos
    for (let j = 0; j < 2; j++) {
      const [c, sn] = this.rot[j], a = o[2 * j], q = o[2 * j + 1];
      o[2 * j] = a * c - q * sn;
      o[2 * j + 1] = q * c + a * sn;
    }
    if (++this.i === this.N) {
      // once per window: kill float drift in the running sums and oscillators
      this.i = 0;
      for (let j = 0; j < 5; j++) s[j] = b[j].reduce((acc, y) => acc + y, 0);
      for (let j = 0; j < 2; j++) {
        const m = Math.hypot(o[2 * j], o[2 * j + 1]);
        o[2 * j] /= m;
        o[2 * j + 1] /= m;
      }
    }
    this.t++;

    const M = s[0] * s[0] + s[1] * s[1];
    const S = s[2] * s[2] + s[3] * s[3];
    const P = s[4];
    // a clean tone gives 0.5, broadband noise gives almost 0
    const ratio = P > this.floor ? (M + S) / (this.N * P) : 0;
    this.lock += (ratio - this.lock) * this.k;

    if (!this.carrier) {
      if (this.lock > 0.18 && this.t > this.N) {
        this.carrier = true;
        this.state = 0;
        this.onCarrier?.(true);
      } else return;
    } else if (this.lock < 0.09) {
      this.carrier = false;
      this.onCarrier?.(false);
      return;
    }

    const mark = M > S;
    switch (this.state) {
      case 0:
        if (mark) this.state = 1;
        break;
      case 1:
        if (!mark) {
          // The filter output crosses over half a bit after the real edge, and is
          // cleanest one full bit after it — so sample every bit at t0 + spb/2 + n·spb.
          this.state = 2;
          this.t0 = this.t;
          this.bit = 0;
          this.byte = 0;
          this.next = this.t0 + this.spb / 2;
        }
        break;
      case 2:
        if (this.t < this.next) break;
        if (this.bit === 0) {
          if (mark) {
            this.state = 0; // glitch, not a start bit
            break;
          }
        } else if (this.bit <= 8) {
          if (mark) this.byte |= 1 << (this.bit - 1);
        } else {
          if (mark) {
            this.onByte?.(this.byte);
            this.state = 1;
          } else this.state = 0; // framing error
          break;
        }
        this.bit++;
        this.next = this.t0 + this.spb / 2 + this.bit * this.spb;
        break;
    }
  }
}

// ——— MfskDemod: 16 hopping tones, Costas sync, FEC-protected blocks (TANK mode) ———
// Every quarter symbol it measures all 16 tones over the last full symbol (Goertzel).
// Hunting: looks for the Costas pattern in that history.
// Receiving: reads one symbol every 4 steps and nudges its clock by a quarter symbol when a
// neighbouring window fits better — VoIP jitter buffers stretch and squeeze time.

const HIST = 256;
const SLACK = 5; // quarter-symbols the timing may wander inside one block
const PENALTY = 0.6;

export class MfskDemod {
  constructor(mode, fs) {
    this.mode = mode;
    this.H = Math.round((fs * mode.symbol) / 4);
    this.N = this.H * 4;
    this.ring = new Float32Array(this.N);
    this.w = 0;
    this.c = 0;
    this.coef = Array.from({ length: 16 }, (_, j) => 2 * Math.cos((2 * Math.PI * (mode.base + j * mode.spacing)) / fs));
    this.hist = new Float64Array(HIST * 16);
    this.tot = new Float64Array(HIST);
    this.inPow = new Float64Array(HIST);
    this.k = 0;
    this.lock = 0;
    this.lastLock = -1e9;
    this.cand = null;
    this.state = 'hunt';
    this.onCarrier = this.onHeader = this.onBlock = this.onEnd = this.onLost = null;
  }

  push(x) {
    this.ring[this.w] = x;
    if (++this.w === this.N) this.w = 0;
    if (++this.c === this.H) {
      this.c = 0;
      this.measure();
      this.step(this.k++);
    }
  }

  measure() {
    const { ring, N, w } = this, o = (this.k % HIST) * 16;
    let p = 0;
    for (let i = 0; i < N; i++) p += ring[i] * ring[i];
    let tot = 0;
    for (let j = 0; j < 16; j++) {
      const cf = this.coef[j];
      let s1 = 0, s2 = 0;
      for (let i = w; i < N; i++) {
        const s0 = ring[i] + cf * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      for (let i = 0; i < w; i++) {
        const s0 = ring[i] + cf * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const e = s1 * s1 + s2 * s2 - cf * s1 * s2;
      this.hist[o + j] = e;
      tot += e;
    }
    this.tot[this.k % HIST] = tot;
    this.inPow[this.k % HIST] = p / N;
  }

  E(s, j) { return this.hist[(s % HIST) * 16 + j]; }
  frac(s, j) { const t = this.tot[s % HIST]; return t > 0 ? this.E(s, j) / t : 0; }
  peak(s) {
    let m = 0;
    for (let j = 0; j < 16; j++) m = Math.max(m, this.E(s, j));
    return m;
  }

  step(k) {
    if (this.state === 'hunt') return this.hunt(k);
    if (this.state === 'mark') {
      if (k < this.markAt + 6) return;
      this.resync();
    }
    // a block is decoded in one go once every window it might need has been measured
    if (k >= this.next + 4 * (this.nsym - 1) + SLACK) this.readBlock();
  }

  hunt(k) {
    if (k < 61 || k - 60 <= this.lastLock + 4) return;
    let sc = 0;
    for (let i = 0; i < 16; i++) sc += this.frac(k - 4 * (15 - i), COSTAS[i]);
    sc /= 16;
    this.lock += (sc - this.lock) * 0.2;
    if (this.cand) {
      if (sc > this.cand.sc) this.cand = { k, sc };
      else if (k - this.cand.k >= 3) {
        this.begin(this.cand.k);
        this.cand = null;
      }
    } else if (sc > 0.35 && this.inPow[k % HIST] > 1e-8) this.cand = { k, sc };
  }

  begin(ks) {
    let ref = 0;
    for (let i = 0; i < 16; i++) ref += this.tot[(ks - 4 * i) % HIST];
    this.ref = ref / 16;
    this.lastLock = ks;
    this.next = ks + 4;
    this.dead = 0;
    this.phase = 'hdr';
    this.nsym = blockSymbols(HEADER_BYTES);
    this.state = 'read';
    this.onCarrier?.(true);
  }

  stop() {
    this.state = 'hunt';
    this.onCarrier?.(false);
  }

  // Before every block: find the 4-symbol marker within ±6 quarter-symbols and re-align.
  // A timing slip can then cost at most one block, never the rest of the message.
  expectMark() {
    this.markAt = this.next + 4 * (MARK.length - 1);
    this.state = 'mark';
  }

  resync() {
    let best = 0, bestSc = -1;
    for (let o = -6; o <= 6; o++) {
      let sc = 0;
      for (let i = 0; i < MARK.length; i++) sc += this.frac(this.markAt + o - 4 * (MARK.length - 1 - i), MARK[i]);
      if (sc > bestSc + 1e-9 || (Math.abs(sc - bestSc) < 1e-9 && Math.abs(o) < Math.abs(best))) {
        bestSc = sc;
        best = o;
      }
    }
    this.next = this.markAt + best + 4;
    this.phase = 'blk';
    this.nsym = blockSymbols(BLOCK_BYTES);
    this.state = 'read';
  }

  // Timing path through the block (Viterbi over ±slack quarter-symbol offsets): stay aligned
  // with the strongest tone, but pay PENALTY for every move. A VoIP jitter buffer cutting or
  // repeating 10 ms is worth following; one dropped packet is not.
  timingPath(n, slack, prior) {
    const W = 2 * slack + 1, base = this.next - slack;
    const m = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let o = 0; o < W; o++) row.push(this.peak(base + 4 * i + o));
      const top = Math.max(...row) || 1;
      m.push(row.map((v, o) => v / top - prior * Math.abs(o - slack)));
    }
    let score = m[0].map((v, o) => v - PENALTY * Math.abs(o - slack));
    const back = [];
    for (let i = 1; i < n; i++) {
      const b = new Int8Array(W), next = new Array(W);
      for (let o = 0; o < W; o++) {
        let best = -Infinity;
        for (const d of [0, -1, 1]) {
          const p = o + d;
          if (p < 0 || p >= W) continue;
          const v = score[p] - (d ? PENALTY : 0);
          if (v > best) {
            best = v;
            b[o] = p;
          }
        }
        next[o] = best + m[i][o];
      }
      back.push(b);
      score = next;
    }
    const path = new Array(n);
    path[n - 1] = score.indexOf(Math.max(...score));
    for (let i = n - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]];
    return path.map((o, i) => base + 4 * i + o); // absolute window steps
  }

  softFor(steps) {
    const soft = [];
    for (const s of steps) {
      const tot = this.tot[s % HIST];
      const spec = Array.from({ length: 16 }, (_, j) => this.E(s, j));
      soft.push(...softBitsFromSpectrum(spec, Math.min(1, (2 * tot) / this.ref)));
    }
    return soft;
  }

  // Energy alone cannot tell "half a symbol late" from "half a symbol early" — the neighbour
  // symbol looks just as clean. So when a block fails its CRC, try other timing hypotheses
  // and let the data decide.
  readBlock() {
    const n = this.nsym, bytes = this.phase === 'hdr' ? HEADER_BYTES : BLOCK_BYTES;
    const tries = [[SLACK, 0], [2, 0], [SLACK, 0.15], [1, 0.3], [0, 0], [3, 0.05], [4, 0.1]];
    let res, steps, first;
    for (const [slack, prior] of tries) {
      const st = this.timingPath(n, slack, prior);
      if (steps && st.every((v, i) => v === steps[i])) continue;
      steps = st;
      res = decodeBlock(this.softFor(steps), bytes);
      first ??= { res, steps };
      if (res.ok) break;
    }
    if (!res.ok) ({ res, steps } = first);

    let dead = 0, worst = 0;
    for (const s of steps) {
      const tot = this.tot[s % HIST];
      dead = tot < this.ref * 0.02 ? dead + 1 : 0;
      worst = Math.max(worst, dead);
      if (tot > this.ref * 0.3) this.ref += (tot - this.ref) * 0.05; // follow the phone's AGC
    }
    this.path = steps;
    this.next = steps[n - 1] + 4;

    if (worst > 12) {
      this.stop();
      if (this.phase === 'blk') this.onLost?.();
      return;
    }
    if (this.phase === 'hdr') {
      const { bytes, ok } = res;
      const len = (bytes[1] << 8) | bytes[2];
      if (!ok || bytes[0] !== MAGIC || !len || len > 2048) return this.stop(); // false sync
      this.blocksLeft = Math.ceil(len / BLOCK_BYTES);
      this.onHeader?.(len);
      return this.expectMark();
    }
    this.onBlock?.(res.bytes, res.ok);
    if (--this.blocksLeft === 0) {
      this.stop();
      this.onEnd?.();
    } else this.expectMark();
  }
}
