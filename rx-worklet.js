// Receiver AudioWorklet: runs the TANK demodulator on the microphone input.
import { MfskDemod } from './demod.js';

class ModemRx extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const post = (m) => this.port.postMessage(m);
    const d = (this.demod = new MfskDemod(opts.processorOptions.mode, sampleRate));
    d.onHeader = (len) => post({ t: 'hdr', len });
    d.onBlock = (bytes, ok) => post({ t: 'blk', bytes, ok });
    d.onEnd = () => post({ t: 'end' });
    d.onLost = () => post({ t: 'lost' });
    d.onCarrier = (on) => post({ t: 'cd', on });
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
      this.demod.push(x);
      this.acc += x * x;
      if (++this.n === this.statEvery) {
        this.port.postMessage({ t: 'stat', rms: Math.sqrt(this.acc / this.n), lock: this.demod.lock });
        this.acc = 0;
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('modem-rx', ModemRx);
