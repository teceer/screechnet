# 📞 SCREECHNET

**The internet, over a phone call. Literally.** → **[screechnet.vercel.app](https://screechnet.vercel.app)**

Your laptop is the modem. A phone call on speaker is the line. Type a message, and it leaves your speakers as that 1995 dial-up screech, travels through an ordinary phone call and types itself out on your friend's screen.

No servers, no accounts, no packets. The whole thing is a static page. The only network is sound.

## Try it

1. Call a friend. Any phone call works. Put it on speaker.
2. Both of you open the page and flip **POWER**. Allow the microphone.
3. Lay the phone next to your laptop and turn the volume up.
4. Type, hit **TRANSMIT**, and listen.

Alone? Tick **LOCAL ECHO**, and your own mic decodes what your speakers send.

Want the full nostalgia hit? Press **ATDT ☎** for a synthesized dial-up handshake.

## How it survives a phone call

Phone calls are hostile to modems. Voice codecs drop 20 ms packets, jitter buffers cut and stretch time, and noise suppression deletes steady tones. So SCREECHNET speaks one mode, **TANK** (~34 bit/s), built for exactly that and borrowing ideas from ham-radio modes like FT8 and Olivia:

- **16 tones, hopping every 40 ms** (MFSK16, 800–1550 Hz), so noise suppression doesn't treat the signal as a steady whine.
- **A Costas array** marks the start of a message, so the receiver can find it even deep in noise.
- **A K=7 convolutional code with soft-decision Viterbi decoding, plus bit interleaving**, turns a dropped packet into scattered bit errors that the decoder repairs.
- **A re-sync marker and a CRC-16 on every 8-byte block.** The receiver tracks symbol timing with a Viterbi search over time offsets. If a block fails its CRC, it retries other timing hypotheses and lets the data decide.
- **A block that is still lost shows up as `░░░`** instead of taking the whole message down.

The loopback simulation (`npm test`) sends messages over simulated calls:
- **Bad VoIP** (5% packet loss, jitter, 6 dB SNR): 12/12 messages arrive intact.
- **Brutal VoIP** (8% loss, jitter every ~0.5 s, 3 dB SNR): about 80% of blocks still get through.

A plain two-tone FSK modem (Bell 103 style), which this project started with, got 0/12 on the bad line.

## Private line (end-to-end encryption)

Both sides type the same **room key**. Messages then go out as AES-256-GCM ciphertext: anyone listening to the call hears the screech but reads nothing. On screen, the hex ciphertext streams in and then decrypts into text.

- The key is derived with PBKDF2-SHA256 (600k iterations) via WebCrypto and never leaves the browser.
- A short **key ID** (e.g. `3F-A9-C2`) lets you confirm over the call that you typed the same key without saying it out loud.
- Air time is precious, so the envelope is trimmed to 17 bytes: a 64-bit random nonce and a 64-bit authentication tag.

Honest caveats: it is a toy, not Signal.
- A weak passphrase can be brute-forced offline by anyone who records the call.
- There is no forward secrecy and no replay protection.
- A single lost FEC block makes an encrypted message unreadable.

## Run locally

The microphone needs `https://` or `localhost`.

```bash
python3 -m http.server 8000   # or any static server
open http://localhost:8000
```

```bash
npm test   # modulate → simulated phone line (band-pass, noise, drift, packet loss, jitter, AGC) → demodulate
```

The test has no dependencies and runs on Node 20+.

## Code map

| File | What |
|---|---|
| `modem.js` | payload format, MFSK modulator, block assembler, dial-up handshake synth |
| `demod.js` | `MfskDemod`: Goertzel tone bank, Costas hunt, per-block timing search and decoding |
| `fec.js` | CRC-16, convolutional code, soft Viterbi, interleaver, Gray mapping |
| `crypto.js` | room key derivation, seal/open |
| `rx-worklet.js` | AudioWorklet running the demodulator on the microphone |
| `app.js` | UI: LEDs, waterfall, terminal, compose |

## License

MIT
