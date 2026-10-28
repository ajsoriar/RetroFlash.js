'use strict';
// Project-authored sound fixture (SWF 6, 320x200, 12 fps, 12 root frames). Every sample is synthesized here.
//   sound 1 "beep": PCM 16-bit mono at 5.5 kHz, a 0.12 s 660 Hz tone, exported as "beep"
//   sound 2: ADPCM 4-bit mono at 11 kHz, a 0.08 s 1320 Hz click
//   sound 3: PCM 8-bit stereo at 11 kHz, a 0.06 s chirp (rising on the left, falling on the right)
//   sound 4: MP3 (MPEG-1 layer III), two frames of silence, SeekSamples 576
//   root stream: SoundStreamHead2 ADPCM 3-bit mono at 11 kHz, one SoundStreamBlock per frame: a tone rising
//     one fifth over the 12 frames
//   button 10 (DefineButton2): blue rectangle (shape 20); DefineButtonSound plays sound 2 on roll over and sound 3 on
//     press (no multiple); release runs: s = new Sound(); s.attachSound("beep"); s.setPan(-100); s.start(0, 2)
//   frame 1: StartSound 1, played twice, panned from left to right by its envelope
//   frame 6: StartSound 4 · frame 12: StartSound 1 with SyncStop
const B = require('../support/swf-builder');
const { push, rec, str } = require('../support/avm1-asm');

const RATE_CODE = { 5512.5: 0, 11025: 1, 22050: 2, 44100: 3 };
const FRAMES = 12, STREAM_RATE = 11025, PER_FRAME = Math.ceil(STREAM_RATE / 12);

// `count` samples of a sine of `freq` Hz (or freq(t) for a sweep) at `rate`, faded in and out over 5 ms.
function tone(rate, count, freq, amplitude = 0.6) {
  const out = [], fade = Math.max(1, Math.round(rate * 0.005));
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const f = typeof freq === 'function' ? freq(i / count) : freq;
    phase += (2 * Math.PI * f) / rate;
    out.push(amplitude * Math.sin(phase) * Math.min(1, i / fade, (count - 1 - i) / fade));
  }
  return out;
}
const int16 = (samples) => samples.map((v) => Math.round(v * 32767));

function buildSound() {
  const rect = B.defineShape(20, {
    version: 1, bounds: { xMin: -1600, xMax: 1600, yMin: -600, yMax: 600 }, fills: [{ color: [59, 130, 246] }],
    records: [{ move: [-1600, -600], fill1: 1 }, { to: [1600, -600] }, { to: [1600, 600] }, { to: [-1600, 600] }, { to: [-1600, -600] }]
  });
  const beep = tone(5512.5, 661, 660);
  const click = tone(11025, 882, 1320);
  const left = tone(11025, 662, (t) => 600 + 1200 * t), right = tone(11025, 662, (t) => 1800 - 1200 * t);
  const chirp = Buffer.from(left.flatMap((v, i) => [Math.round(128 + v * 127), Math.round(128 + right[i] * 127)]));
  // s = new Sound(); s.attachSound("beep"); s.setPan(-100); s.start(0, 2)
  const call = (name, ...args) => [push(...args.slice().reverse(), args.length, 's'), [0x1c], push(name), [0x52], [0x17]];
  const release = [push('s', 0, 'Sound'), [0x40], [0x1d], call('attachSound', 'beep'), call('setPan', -100), call('start', 0, 2)];
  const stream = tone(STREAM_RATE, PER_FRAME * FRAMES, (t) => 440 * Math.pow(1.5, t), 0.4);
  const block = (k) => B.soundStreamBlock(B.adpcm([int16(stream.slice(k * PER_FRAME, (k + 1) * PER_FRAME))], 3));
  const place = B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x04).u16(1).u16(10); B.matrix(w, { translateX: 3200, translateY: 2000 }); }));
  const show = () => B.tag(B.T.ShowFrame);
  const frames = [];
  for (let k = 0; k < FRAMES; k++) {
    frames.push(block(k));
    if (k === 0) frames.push(place, B.startSound(1, { loopCount: 2, envelope: [[0, 32768, 0], [10560, 0, 32768]] }));
    if (k === 5) frames.push(B.startSound(4));
    if (k === FRAMES - 1) frames.push(B.startSound(1, { syncStop: true }));
    frames.push(show());
  }
  const tags = [
    B.tag(B.T.SetBackgroundColor, B.body((w) => w.rgb({ r: 15, g: 23, b: 42 }))),
    rect,
    B.defineSound(1, { format: 3, rate: RATE_CODE[5512.5], is16Bit: true, stereo: false, sampleCount: beep.length, data: B.pcm16(beep) }),
    B.defineSound(2, { format: 1, rate: RATE_CODE[11025], is16Bit: true, stereo: false, sampleCount: click.length, data: B.adpcm([int16(click)], 4) }),
    B.defineSound(3, { format: 0, rate: RATE_CODE[11025], is16Bit: false, stereo: true, sampleCount: left.length, data: chirp }),
    B.defineSound(4, { format: 2, rate: RATE_CODE[44100], is16Bit: true, stereo: false, sampleCount: 2 * 1152 - 576, seekSamples: 576, data: B.mp3Silence(2) }),
    B.tag(56, B.body((w) => w.u16(1).u16(1).string('beep'))),
    B.defineButton2(10, {
      records: [{ states: { up: true, over: true, down: true, hit: true }, character: 20, depth: 1 }],
      actions: [{ conditions: 1 << 3, records: release.flat(Infinity) }]
    }),
    B.defineButtonSound(10, [null, { id: 2 }, { id: 3, info: { syncNoMultiple: true } }, null]),
    B.soundStreamHead({ format: 1, rate: RATE_CODE[STREAM_RATE], is16Bit: true, stereo: false, sampleCount: PER_FRAME }),
    ...frames,
    B.tag(B.T.End)
  ];
  return B.swf({ version: 6, stage: { xMax: 6400, yMax: 4000 }, fps: 12, frameCount: FRAMES, tags });
}

module.exports = { buildSound, FRAMES, PER_FRAME, STREAM_RATE, tone };
