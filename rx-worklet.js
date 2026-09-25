// Receiver AudioWorklet. Runs one demodulator per mode at once,
// so the receiver never needs a speed setting.
import { FskDemod, MfskDemod } from './demod.js';

class ModemRx extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const post = (m) => this.port.postMessage(m);
    this.demods = opts.processorOptions.modes.map((mode, k) => {
      if (mode.type === 'mfsk') {
        const d = new MfskDemod(mode, sampleRate);
        d.onHeader = (len) => post({ t: 'hdr', k, len });
        d.onBlock = (bytes, ok) => post({ t: 'blk', k, bytes, ok });
        d.onEnd = () => post({ t: 'end', k });
        d.onLost = () => post({ t: 'lost', k });
        d.onCarrier = (on) => post({ t: 'cd', k, on });
        return d;
      }
      const d = new FskDemod(mode, sampleRate);
      d.onByte = (b) => post({ t: 'byte', k, b });
      d.onCarrier = (on) => post({ t: 'cd', k, on });
      return d;
    });
    this.muted = false;
    this.acc = 0;
    this.n = 0;
    this.statEvery = Math.round(sampleRate / 20);
    this.port.onmessage = (e) => {
      if (e.data.t === 'mute') this.muted = e.data.v;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // while we transmit, feed silence so we don't decode our own echo
      const x = this.muted ? 0 : ch[i];
      for (const d of this.demods) d.push(x);
      this.acc += x * x;
      if (++this.n === this.statEvery) {
        this.port.postMessage({ t: 'stat', rms: Math.sqrt(this.acc / this.n), lock: this.demods.map((d) => d.lock) });
        this.acc = 0;
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('modem-rx', ModemRx);
