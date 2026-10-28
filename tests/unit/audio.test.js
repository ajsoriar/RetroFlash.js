'use strict';
// Sound: the reader's sound tags, the PCM/ADPCM decoders and MP3 frame headers, the AudioController (event
// sounds, button sounds, streams, the AVM1 Sound object, loadSound) driven tick by tick with a recording
// backend, the Player's audio options, and the Web Audio backend on a stand-in AudioContext. What a browser
// actually plays is checked by hand with demo/player.html and tests/fixtures/valid/fws-sound.swf.
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../support/harness');
const { SWFReader, RetroFlash } = require('../support/load-reader');
const { FIXTURE_DIR } = require('../fixtures/build-fixtures');
const { FRAMES, PER_FRAME, STREAM_RATE, tone } = require('../fixtures/sound');
const B = require('../support/swf-builder');
const { push, rec, str } = require('../support/avm1-asm');

const I = RetroFlash.internals;
const fixture = () => new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, 'valid/fws-sound.swf')));
const GET = [0x1c], SET = [0x1d], POP = [0x17];
const show = () => B.tag(B.T.ShowFrame);
const end = () => B.tag(B.T.End);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A backend that records what it is asked to play; tests move voices (pos) and end them (finish()).
function recorder() {
  const voices = [], calls = [];
  const backend = {
    play(media, options) {
      const voice = {
        media, options, gains: options.gains, stopped: false, pos: options.start,
        stop() { this.stopped = true; }, setGains(g) { this.gains = g; }, position() { return this.pos; },
        finish() { options.onended(); }
      };
      voices.push(voice);
      return voice;
    },
    prepare(media) { calls.push(['prepare', media]); return Promise.resolve(); },
    suspend() { calls.push(['suspend']); }, resume() { calls.push(['resume']); },
    setVolume(v) { calls.push(['volume', v]); }, close() { calls.push(['close']); }
  };
  return { backend, voices, calls, playing: () => voices.filter((v) => !v.stopped) };
}

// A movie run as the player runs it, with a recording backend (or `backend: null` for none).
async function setup(bytes, { backend, limits, loader } = {}) {
  const swf = await SWFReader.load(bytes);
  const movie = new I.Movie(swf), reported = [], rec = recorder();
  const report = (feature) => reported.push(feature);
  const audio = new I.AudioController(backend === null ? null : rec.backend, report, I.resolveLimits(limits));
  const env = I.createEnv(movie, report, { audio, loader });
  const root = new I.Clip(env, movie.root, 0, null);
  root.gotoFrame(1);
  env.scripts.run();
  audio.sync();
  const input = new I.InputController(env, () => root);
  const update = (changed) => { if (changed) { env.scripts.beginUpdate(); env.scripts.run(); audio.sync(); } return changed; };
  const version = swf.version;
  return {
    swf, movie, env, root, audio, input, reported, ...rec,
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) {
        env.scripts.beginUpdate();
        audio.collect(env.scripts);
        root.tick();
        env.scripts.run();
        if (input.afterTick()) env.scripts.run();
        audio.sync();
      }
    },
    event: update,
    run: (...records) => {
      const code = new I.ActionCode(Uint8Array.from(records.flat(Infinity)), version);
      const act = new I.Activation(env.scripts, root, code, 'test');
      act.run();
      env.scripts.run();
      audio.sync();
      return Array.from(act.stack);
    },
    v: (name) => root.variables.get(version < 7 ? name.toLowerCase() : name)
  };
}
// AVM1: object.method(args...) leaving the result; set(name, value...) and the like.
const method = (object, name, ...args) => [push(...args.slice().reverse(), args.length, object), GET, push(name), [0x52]];
const set = (name, ...value) => [push(name), ...value, SET];
const newObject = (name, ...args) => [push(...args.slice().reverse(), args.length, name), [0x40]];

// ---- Reader -------------------------------------------------------------------------------------------------

test('reader: DefineSound, StartSound, DefineButtonSound and SoundStreamHead2 bodies', async () => {
  const swf = await SWFReader.load(fixture());
  const of = (code) => swf.tags.filter((t) => t.code === code);
  assert.ok(swf.tags.filter((t) => [14, 15, 17, 18, 19, 45].includes(t.code)).every((t) => t.status === 'decoded'));
  assert.deepStrictEqual(of(14).map((t) => t.fields), [
    { soundId: 1, format: 3, rate: 5512.5, is16Bit: true, stereo: false, sampleCount: 661, dataStart: 7 },
    { soundId: 2, format: 1, rate: 11025, is16Bit: true, stereo: false, sampleCount: 882, dataStart: 7 },
    { soundId: 3, format: 0, rate: 11025, is16Bit: false, stereo: true, sampleCount: 662, dataStart: 7 },
    { soundId: 4, format: 2, rate: 44100, is16Bit: true, stereo: false, sampleCount: 1728, seekSamples: 576, dataStart: 9 }
  ]);
  assert.deepStrictEqual(of(15).map((t) => t.fields), [
    { soundId: 1, info: { syncStop: false, syncNoMultiple: false, loopCount: 2, envelope: [{ pos44: 0, left: 32768, right: 0 }, { pos44: 10560, left: 0, right: 32768 }] } },
    { soundId: 4, info: { syncStop: false, syncNoMultiple: false } },
    { soundId: 1, info: { syncStop: true, syncNoMultiple: false } }
  ]);
  assert.deepStrictEqual(of(17)[0].fields, {
    buttonId: 10,
    sounds: [null, { soundId: 2, info: { syncStop: false, syncNoMultiple: false } }, { soundId: 3, info: { syncStop: false, syncNoMultiple: true } }, null]
  });
  assert.deepStrictEqual(of(45)[0].fields, { playbackRate: 11025, playback16Bit: true, playbackStereo: false, format: 1, rate: 11025, is16Bit: true, stereo: false, sampleCount: PER_FRAME });
  assert.strictEqual(of(19).length, FRAMES);
  assert.deepStrictEqual(swf.unsupported, []);
});

test('reader: SOUNDINFO in and out points, SoundStreamHead with LatencySeek, StartSound2, codec rates', async () => {
  const swf = await SWFReader.load(B.swf({ version: 6, tags: [
    B.startSound(7, { inPoint: 4410, outPoint: 44100, loopCount: 3 }),
    B.soundStreamHead({ format: 2, rate: 3, stereo: true, sampleCount: 1176, latencySeek: 1105 }, 1),
    B.tag(18, Uint8Array.from([0x0e, 0x2f, 0x98, 0x04])), // MP3 head without LatencySeek, as some tools write it
    B.tag(89, B.body((w) => { w.string('Click'); B.soundInfo(w, { syncNoMultiple: true }); })),
    B.defineSound(8, { format: 5, rate: 3, sampleCount: 0, data: [] }),
    B.defineSound(9, { format: 11, rate: 0, sampleCount: 0, data: [] }),
    show(), end()
  ] }));
  const [start, head, bare, start2, nelly, speex] = swf.tags.map((t) => t.fields);
  assert.deepStrictEqual(start.info, { syncStop: false, syncNoMultiple: false, inPoint: 4410, outPoint: 44100, loopCount: 3 });
  assert.deepStrictEqual([head.format, head.rate, head.stereo, head.sampleCount, head.latencySeek], [2, 44100, true, 1176, 1105]);
  assert.strictEqual(swf.tags[1].name, 'SoundStreamHead');
  assert.deepStrictEqual([bare.format, bare.sampleCount, 'latencySeek' in bare], [2, 1176, false]);
  assert.deepStrictEqual(start2, { className: 'Click', info: { syncStop: false, syncNoMultiple: true } });
  assert.deepStrictEqual([nelly.rate, speex.rate], [8000, 16000], 'Nellymoser 8 kHz and Speex ignore the rate code');
  assert.deepStrictEqual(swf.diagnostics, []);
  const truncated = await SWFReader.load(B.swf({ tags: [B.tag(15, Uint8Array.from([1, 0, 0x01, 0])), show(), end()] }));
  assert.strictEqual(truncated.tags[0].status, 'invalid', 'an InPoint cut short');
});

// ---- Codecs -------------------------------------------------------------------------------------------------

test('PCM: 16-bit little-endian and 8-bit unsigned, mono and stereo, bounded by the declared count', () => {
  const pcm = (bytes, is16Bit, stereo, limit = 100) => I.decodeSoundBlocks(3, 11025, is16Bit, stereo, [Uint8Array.from(bytes)], limit).channels.map((c) => Array.from(c));
  assert.deepStrictEqual(pcm([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f], true, false), [[0.5, -0.5, 32767 / 32768]]);
  assert.deepStrictEqual(pcm([128, 0, 192, 64], false, true), [[0, 0.5], [-1, -0.5]]);
  assert.deepStrictEqual(pcm([0x00, 0x40, 0x00, 0xc0, 0x01], true, false, 1), [[0.5]], 'declared count, then whole frames only');
  assert.deepStrictEqual(pcm([1, 2, 3], true, true), [[], []]);
});

test('ADPCM: a packet decoded by hand, and round trips through an independent encoder', () => {
  // 4-bit codes: first sample 1000 at step index 0, then code 7 (+11) and code 15 (-30 at step index 8).
  const w = new B.BitWriter().ub(2, 2).sb(16, 1000).ub(6, 0).ub(4, 7).ub(4, 15);
  const hand = I.decodeSoundBlocks(1, 11025, true, false, [w.bytes()], 10).channels[0];
  assert.deepStrictEqual(Array.from(hand, (v) => Math.round(v * 32768)), [1000, 1011, 981]);
  for (const bits of [2, 3, 4, 5]) {
    const left = tone(11025, 5000, 700).map((v) => Math.round(v * 32767)), right = tone(11025, 5000, 300).map((v) => Math.round(v * 20000));
    const decoded = I.decodeSoundBlocks(1, 11025, true, true, [B.adpcm([left, right], bits)], 5000).channels;
    assert.strictEqual(decoded[0].length, 5000, 'two packets of 4096 frames, the second one short');
    const error = (ch, ref) => Math.sqrt(ref.reduce((s, v, i) => s + (ch[i] * 32768 - v) ** 2, 0) / ref.length);
    const limit = { 2: 9000, 3: 3000, 4: 900, 5: 400 }[bits];
    assert.ok(error(decoded[0], left) < limit && error(decoded[1], right) < limit, bits + '-bit codes stay close: ' + error(decoded[0], left));
    assert.strictEqual(decoded[0][4096] * 32768, left[4096], 'each packet restarts from an exact sample');
  }
  // Stream blocks each restart the decoder. A block does not record its sample count, so padding bits that
  // hold a whole code decode as one more sample (the second block: 28 bits of data, 4 of padding).
  const starts = [];
  const blocks = I.decodeSoundBlocks(1, 11025, true, false, [B.adpcm([[0, 100, 200]]), B.adpcm([[5, 6]])], Infinity, starts);
  assert.deepStrictEqual([starts, blocks.channels[0].length, blocks.channels[0][3] * 32768], [[0, 3], 6, 5]);
  assert.deepStrictEqual(Array.from(I.decodeSoundBlocks(1, 11025, true, false, [Uint8Array.from([0x80])], 10).channels[0]), [], 'too short for a packet');
});

test('MP3 frame headers: sample rate, channels and sample count, after an ID3v2 tag and junk', () => {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
  const file = Buffer.concat([id3, Buffer.from([0, 0, 0xff]), B.mp3Silence(3)]);
  assert.deepStrictEqual(I.parseMp3(new Uint8Array(file)), { rate: 44100, stereo: false, sampleCount: 3 * 1152, start: 18 });
  const mpeg2 = Buffer.from(B.mp3Silence(1));
  mpeg2[1] = 0xf3; // MPEG-2: 576 samples per frame, 22.05 kHz; frame length 72 * 128000 / 22050
  assert.deepStrictEqual(I.parseMp3(new Uint8Array(mpeg2.subarray(0, 417))), null, 'a frame that does not fit');
  assert.strictEqual(I.parseMp3(new Uint8Array([1, 2, 3, 4])), null);
});

// ---- Event sounds, streams and buttons from the fixture --------------------------------------------------------

test('StartSound: in and out points, loops and envelope reach the backend; MP3 skips its SeekSamples; SyncStop stops', async () => {
  const g = await setup(fixture());
  const [beep, stream] = g.voices;
  assert.strictEqual(beep.media.rate, 5512.5);
  assert.strictEqual(beep.media.channels[0].length, 661);
  assert.deepStrictEqual([beep.options.start, beep.options.loops, beep.options.sync, beep.gains], [0, 2, false, [1, 0, 0, 1]]);
  assert.ok(near(beep.options.end, 661 / 5512.5));
  assert.deepStrictEqual(beep.options.envelope, [{ time: 0, left: 1, right: 0 }, { time: 10560 / 44100, left: 0, right: 1 }]);
  assert.strictEqual(stream.options.sync, true);
  g.tick(5);
  const mp3 = g.voices[2];
  assert.strictEqual(mp3.media.mp3.length, 2 * 417);
  assert.ok(near(mp3.options.start, 576 / 44100) && near(mp3.options.end, (576 + 1728) / 44100));
  g.tick(6);
  assert.strictEqual(g.root.frame, FRAMES);
  assert.ok(beep.stopped, 'SyncStop stops every instance of the sound');
  assert.ok(!mp3.stopped);
  // The same character starts again from its cached samples: Sound in and out points, as SOUNDINFO counts them.
  const inst = g.audio.start(g.movie.characters[1], { inPoint: 2205, outPoint: 4410 * 3 }, null, null);
  assert.strictEqual(inst.voice.media, beep.media);
  assert.ok(near(inst.voice.options.start, 0.05) && near(inst.voice.options.end, 661 / 5512.5), 'the out point clamped to the sound');
  assert.strictEqual(g.audio.start(g.movie.characters[1], { inPoint: 44100 }, null, null), null, 'nothing between in and out');
  assert.deepStrictEqual(g.reported, []);
});

test('stream: plays while the timeline plays, resynchronizes, stops on stop() and jumps, restarts at the next block', async () => {
  const g = await setup(fixture());
  const first = g.voices[1], data = g.audio.streamData(g.movie.root.stream), length = first.media.channels[0].length;
  // Every block decoded into one sound (3-bit codes: each block's 6 padding bits add two samples).
  assert.strictEqual(length, FRAMES * (PER_FRAME + 2));
  assert.deepStrictEqual([first.options.start, first.options.loops], [0, 1]);
  assert.ok(near(first.options.end, length / STREAM_RATE));
  const frameTime = (n) => data.starts.get(n);
  assert.ok(near(frameTime(2), (PER_FRAME + 2) / STREAM_RATE));
  for (let n = 2; n <= 4; n++) { first.pos = frameTime(n); g.tick(); }
  assert.strictEqual(g.playing().filter((v) => v.options.sync).length, 1, 'no restart while in step');
  first.pos = 2; // more than a second away from frame 5
  g.tick();
  const second = g.voices[g.voices.length - 1];
  assert.ok(first.stopped && second.options.sync && near(second.options.start, frameTime(5)), 'restarted where the timeline is');
  g.run([0x07]); // the root stops
  assert.ok(second.stopped, 'a stopped timeline stops its stream');
  const count = g.voices.length;
  g.tick(2);
  assert.strictEqual(g.voices.length, count, 'nothing while stopped');
  g.root.playing = true;
  g.tick();
  const third = g.voices[g.voices.length - 1];
  assert.ok(near(third.options.start, frameTime(6)), 'plays again from the block the timeline reached');
  g.run([0x81, 2, 0, 1, 0], [0x06]); // gotoFrame(2) then play: a jump
  assert.ok(third.stopped, 'a jump stops the stream');
  g.tick();
  assert.ok(near(g.voices[g.voices.length - 1].options.start, frameTime(3)));
  // stopAllSounds stops the stream too; it starts again at the next frame.
  g.run([0x09]);
  assert.strictEqual(g.playing().length, 0);
  g.tick();
  assert.ok(near(g.playing()[0].options.start, frameTime(4)));
});

test('stream: a sprite stream starts again when its timeline loops after it ended, and ends when the sprite is removed', async () => {
  const sprite = B.tag(B.T.DefineSprite, Buffer.concat([
    B.body((w) => w.u16(5).u16(3)),
    B.soundStreamHead({ format: 3, rate: 1, is16Bit: true, sampleCount: 2 }),
    B.soundStreamBlock(B.pcm16([0.1, 0.2])), show(), B.soundStreamBlock(B.pcm16([0.3, 0.4])), show(), show(), end()
  ]));
  const place = B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x20).u16(1).u16(5).string('s'); }));
  const remove = B.tag(B.T.RemoveObject2, B.body((w) => w.u16(1)));
  const g = await setup(B.swf({ version: 6, frameCount: 5, tags: [sprite, place, show(), show(), show(), show(), remove, show(), end()] }));
  const [first] = g.voices;
  assert.deepStrictEqual(Array.from(first.media.channels[0], (v) => Math.round(v * 10)), [1, 2, 3, 4]);
  g.tick(2); // sprite frames 2 (in step) and 3 (no block)
  assert.strictEqual(g.voices.length, 1);
  first.finish();
  g.tick(); // the sprite loops to frame 1
  const second = g.voices[1];
  assert.ok(second && second.options.start === 0, 'started again from the beginning');
  g.tick(); // root frame 5 removes the sprite
  assert.ok(second.stopped, 'the stream of a removed clip ends');
  assert.strictEqual(g.voices.length, 2);
});

test('button sounds: roll over and press play their DefineButtonSound entries; no multiple is honoured', async () => {
  const g = await setup(fixture());
  const at = [3200, 2000];
  const before = g.voices.length;
  g.event(g.input.move(at[0], at[1]));
  const over = g.voices[before];
  assert.strictEqual(over.media.channels[0].length, 882, 'roll over: the ADPCM click');
  g.event(g.input.down());
  const press = g.voices[before + 1];
  assert.deepStrictEqual([press.media.channels.length, press.media.channels[0].length], [2, 662], 'press: the stereo chirp');
  g.event(g.input.up());
  const beep = g.voices[before + 2];
  assert.strictEqual(beep.media, g.voices[0].media, 'release: Sound.attachSound("beep").start()');
  assert.deepStrictEqual([beep.options.loops, beep.gains], [2, [1, 0, 0, 0]], 'setPan(-100) keeps only the left output');
  g.event(g.input.down());
  assert.strictEqual(g.voices.length, before + 3, 'the chirp is still playing: not started again');
  press.finish();
  g.tick();
  g.event(g.input.up());
  g.event(g.input.down());
  assert.strictEqual(g.voices[g.voices.length - 1].media, press.media, 'once finished it plays again');
  g.event(g.input.move(10, 10));
  assert.ok(!g.reported.length, g.reported.join());
});

// ---- The AVM1 Sound object ----------------------------------------------------------------------------------

const exportBeep = (version = 6) => [
  B.defineSound(1, { format: 3, rate: 1, is16Bit: true, sampleCount: 1103, data: B.pcm16(new Array(1103).fill(0.25)) }),
  B.tag(56, B.body((w) => w.u16(1).u16(1).string('Beep'))),
  B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(2).u16(1)), show(), end()])),
  B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x20).u16(1).u16(2).string('mc'); })),
  B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02 | 0x20).u16(2).u16(2).string('other'); }))
];
const soundMovie = (version = 6) => setup(B.swf({ version, frameCount: 2, tags: [...exportBeep(version), show(), show(), end()] }));

test('Sound: attachSound (case-insensitive name), duration, start with offset and loops, position and onSoundComplete', async () => {
  const g = await soundMovie();
  g.run(set('s', newObject('Sound')), method('s', 'attachSound', 'beep'), POP);
  assert.deepStrictEqual(g.run(push('s'), GET, push('duration'), [0x4e]), [100], '1103 samples at 11025 Hz');
  g.run(method('s', 'start', 0.05, 3), POP);
  const voice = g.voices[0];
  assert.deepStrictEqual([voice.options.loops, voice.options.envelope, voice.gains], [3, null, [1, 0, 0, 1]]);
  assert.ok(near(voice.options.start, Math.floor(0.05 * 44100) / 44100));
  voice.pos = 0.0425;
  g.tick();
  assert.deepStrictEqual(g.run(push('s'), GET, push('position'), [0x4e]), [43]);
  // onSoundComplete runs once the sound finished.
  g.run(push('s'), GET, push('onSoundComplete'), fnBody([push('done', 1), SET]), [0x4f]);
  voice.finish();
  g.tick();
  assert.strictEqual(g.v('done'), 1);
  assert.deepStrictEqual(g.run(push('s'), GET, push('position'), [0x4e]), [100], 'a finished sound is at its end');
  g.run(method('s', 'start', 'x', 'y'), POP);
  assert.deepStrictEqual([g.voices[1].options.start, g.voices[1].options.loops], [0, 1], 'bad arguments: from the start, once');
  g.run(set('t', newObject('Sound')), method('t', 'attachSound', 'nothing'), POP, method('t', 'start'), POP);
  assert.strictEqual(g.voices.length, 2, 'nothing attached: nothing plays');
  assert.deepStrictEqual(g.reported, ['sound:attachMissing']);
});
// A function literal (DefineFunction) with parameters `params` whose body is `records`.
function fnBody(records, params = []) {
  const code = records.flat(Infinity);
  return rec(0x9b, ...str(''), params.length & 0xff, params.length >> 8, ...params.flatMap(str), code.length & 0xff, code.length >> 8).concat(code);
}

test('Sound: volume, pan and transform belong to the target clip (or to every sound) and reach playing sounds', async () => {
  const g = await soundMovie();
  g.run(
    set('g', newObject('Sound')), method('g', 'attachSound', 'Beep'), POP,
    set('a', push('mc'), GET, push(1, 'Sound'), [0x40]), method('a', 'attachSound', 'Beep'), POP,
    set('b', push('mc'), GET, push(1, 'Sound'), [0x40]),
    set('o', push('other'), GET, push(1, 'Sound'), [0x40]), method('o', 'attachSound', 'Beep'), POP,
    method('a', 'start'), POP, method('o', 'start'), POP, method('g', 'start'), POP
  );
  const [inMc, inOther, global] = g.voices;
  g.run(method('a', 'setVolume', 50), POP);
  assert.deepStrictEqual(g.run(method('b', 'getVolume')), [50], 'Sound objects of one clip share its volume');
  assert.deepStrictEqual([inMc.gains, inOther.gains, global.gains], [[0.5, 0, 0, 0.5], [1, 0, 0, 1], [1, 0, 0, 1]]);
  g.run(method('g', 'setVolume', 50), POP);
  assert.deepStrictEqual([inMc.gains, inOther.gains], [[0.25, 0, 0, 0.25], [0.5, 0, 0, 0.5]], 'the global volume applies to every sound');
  g.run(method('o', 'setPan', 40), POP);
  assert.deepStrictEqual(inOther.gains.map((v) => +v.toFixed(3)), [0.3, 0, 0, 0.5]);
  assert.deepStrictEqual(g.run(method('o', 'getPan')), [40]);
  g.run(method('o', 'setPan', -30), POP);
  assert.deepStrictEqual(g.run(method('o', 'getPan')), [-30]);
  g.run(set('t', push('rr', 0, 'lr', 100, 2), [0x43]), push('t'), GET, push(1, 'o'), GET, push('setTransform'), [0x52], POP);
  assert.deepStrictEqual(inOther.gains.map((v) => +v.toFixed(3)), [0.5, 0.5, 0, 0], 'both inputs to the left output');
  g.run(set('tr', method('o', 'getTransform')), set('ll', push('tr'), GET, push('ll'), [0x4e]), set('rr', push('tr'), GET, push('rr'), [0x4e]));
  assert.deepStrictEqual([g.v('ll'), g.v('rr')], [100, 0]);
  // stop(): the target's sounds; stop(name): that sound everywhere; the global stop(): everything.
  g.run(method('a', 'stop'), POP);
  assert.deepStrictEqual(g.voices.map((v) => v.stopped), [true, false, false]);
  g.run(method('o', 'start'), POP, method('a', 'stop', 'beep'), POP);
  assert.deepStrictEqual(g.voices.map((v) => v.stopped), [true, true, true, true]);
  g.run(method('a', 'start'), POP, method('g', 'stop'), POP);
  assert.strictEqual(g.playing().length, 0);
  // A Sound whose clip left the stage does nothing.
  g.root.childByName('mc').removed = true;
  assert.deepStrictEqual(g.run(method('a', 'getVolume')), [undefined]);
  g.run(method('a', 'start'), POP);
  assert.strictEqual(g.voices.length, 5);
});

test('StopSounds, the 32-sound limit, no output, unsupported codecs and the sample budget are handled and reported', async () => {
  const g = await soundMovie();
  for (let i = 0; i < 33; i++) g.audio.start(g.movie.characters[1], {}, null, null);
  assert.strictEqual(g.playing().length, I.MAX_SOUNDS);
  assert.deepStrictEqual(g.reported, ['sound:limit']);
  g.run([0x09]);
  assert.strictEqual(g.playing().length, 0, 'StopSounds');

  const silent = await setup(B.swf({ version: 6, tags: [...exportBeep(), B.startSound(1), show(), end()] }), { backend: null });
  assert.deepStrictEqual(silent.reported, ['sound:noOutput']);

  const nelly = await setup(B.swf({ version: 6, tags: [B.defineSound(3, { format: 6, rate: 1, sampleCount: 10, data: [1, 2, 3] }), B.startSound(3), B.startSound(9), show(), end()] }));
  assert.deepStrictEqual(nelly.reported, ['sound:Nellymoser', 'sound:missingCharacter']);

  const tight = await setup(B.swf({ version: 6, tags: [...exportBeep(), B.startSound(1), show(), end()] }), { limits: { maxAudioSamples: 1000 } });
  assert.deepStrictEqual([tight.voices.length, tight.reported], [0, ['sound:memoryLimit']]);
});

test('sounds of sprites in a button hit area are not played', async () => {
  const sprite = B.tag(B.T.DefineSprite, Buffer.concat([B.body((w) => w.u16(5).u16(1)), B.startSound(1), show(), end()]));
  const button = B.defineButton2(6, { records: [{ states: { hit: true }, character: 5, depth: 1 }] });
  const place = B.tag(B.T.PlaceObject2, B.body((w) => { w.u8(0x02).u16(1).u16(6); }));
  const g = await setup(B.swf({ version: 6, tags: [...exportBeep(), sprite, button, place, show(), end()] }));
  assert.strictEqual(g.voices.length, 0);
  assert.deepStrictEqual(g.reported, []);
});

test('Sound.loadSound: an MP3 file through the loader, onLoad(success), streaming start, and failures', async () => {
  const mp3 = new Uint8Array(B.mp3Silence(4));
  const files = { 'music.mp3': mp3, 'bad.mp3': new Uint8Array([1, 2, 3]) };
  const g = await setup(B.swf({ version: 6, tags: [show(), end()] }), { loader: (r) => (r.type === 'sound' ? files[r.url] : null) || null });
  g.run(
    set('s', newObject('Sound')), set('log', push('')),
    push('s'), GET, push('onLoad'), fnBody([push('log', 'log'), GET, push('success'), GET, [0x47], SET], ['success']), [0x4f],
    method('s', 'loadSound', 'music.mp3', true), POP
  );
  await g.env.loads.idle();
  g.event(g.env.loads.apply());
  assert.strictEqual(g.v('log'), 'true', 'onLoad(true)');
  const voice = g.voices[0];
  assert.ok(voice && voice.media.mp3.length === mp3.length, 'a streaming sound starts once loaded');
  assert.deepStrictEqual(g.run(push('s'), GET, push('duration'), [0x4e], method('s', 'getBytesTotal')), [104, mp3.length]);
  g.run(method('s', 'start'), POP);
  assert.ok(voice.stopped, 'a streaming sound plays one instance at a time');
  g.run(method('s', 'loadSound', 'bad.mp3', false), POP);
  await g.env.loads.idle();
  g.event(g.env.loads.apply());
  assert.ok(g.reported.includes('load:failed'));
  assert.strictEqual(g.v('log'), 'truefalse', 'onLoad(false)');
});

// ---- Player ---------------------------------------------------------------------------------------------------

if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class { constructor(m) { this.m = m; } };
function headlessPlayer(options) {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });
  return new RetroFlash.Player(Object.assign({ canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 }, input: false }, options));
}

test('Player: audio and volume options, decoding ahead, pause and play, seek, restart and destroy', async () => {
  for (const audio of ['web', 1, {}]) assert.throws(() => headlessPlayer({ audio }), (e) => e.code === 'INVALID_OPTION');
  for (const volume of [-0.1, 2, '1']) assert.throws(() => headlessPlayer({ volume }), (e) => e.code === 'INVALID_OPTION');
  assert.ok(!headlessPlayer().audio.backend, 'Node has no Web Audio: no output');
  const r = recorder(), raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const player = headlessPlayer({ audio: r.backend, volume: 0.5 });
    assert.deepStrictEqual(r.calls, [['volume', 0.5]]);
    assert.strictEqual(player.getVolume(), 0.5);
    assert.throws(() => player.setVolume(3), (e) => e.code === 'INVALID_OPTION');
    await player.load(fixture());
    assert.ok(r.calls.some((c) => c[0] === 'prepare' && c[1].mp3), 'MP3 sounds are decoded ahead');
    assert.strictEqual(r.playing().length, 2, 'frame 1: the beep and the stream');
    player.play();
    assert.deepStrictEqual(r.calls[r.calls.length - 1], ['resume']);
    player.pause();
    assert.deepStrictEqual(r.calls[r.calls.length - 1], ['suspend']);
    const count = r.voices.length;
    player.seek(6);
    assert.strictEqual(r.voices.length, count, 'seek plays no sound');
    player.step();
    assert.strictEqual(player.root.frame, 7);
    player.stop();
    assert.ok(r.voices.slice(0, count).every((v) => v.stopped), 'a restart stops every sound');
    assert.strictEqual(r.playing().length, 2, 'and frame 1 plays again');
    player.setVolume(1);
    player.destroy();
    assert.deepStrictEqual(r.calls.slice(-2), [['suspend'], ['close']]);
    assert.strictEqual(r.playing().length, 0);
  } finally {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
  }
  const off = headlessPlayer({ audio: false });
  await off.load(fixture());
  assert.ok(off.getDiagnostics().unsupported.some((u) => u.feature === 'sound:noOutput'));
});

// ---- The Web Audio backend --------------------------------------------------------------------------------------

// A stand-in AudioContext that records the graph and the scheduling calls.
function fakeWindow({ failDecode = false } = {}) {
  const log = [], listeners = {};
  class Param { constructor(v) { this.value = v; this.events = []; } setValueAtTime(v, t) { this.events.push(['set', v, t]); } linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); } }
  class Node { constructor(kind) { this.kind = kind; this.out = []; } connect(node, output, input) { this.out.push([node, output, input]); } disconnect() { this.out = []; this.disconnected = true; } }
  class Buffer { constructor(channels, length, rate) { this.data = Array.from({ length: channels }, () => new Float32Array(length)); this.numberOfChannels = channels; this.length = length; this.sampleRate = rate; this.duration = length / rate; } getChannelData(c) { return this.data[c]; } }
  class Context {
    constructor() { this.currentTime = 10; this.state = 'suspended'; this.destination = new Node('destination'); log.push(['context', this]); }
    createGain() { const n = new Node('gain'); n.gain = new Param(1); return n; }
    createBufferSource() { const n = new Node('source'); n.start = (...a) => log.push(['start', ...a]); n.stop = (...a) => log.push(['stop', ...a]); return n; }
    createChannelSplitter(n) { return new Node('splitter' + n); }
    createChannelMerger(n) { return new Node('merger' + n); }
    createBuffer(c, l, r) { return new Buffer(c, l, r); }
    decodeAudioData(data, ok, fail) {
      log.push(['decode', data]);
      return failDecode ? Promise.reject(new Error('bad data')) : Promise.resolve(new Buffer(1, 4410, 44100));
    }
    resume() { log.push(['resume']); this.state = 'running'; return Promise.resolve(); }
    suspend() { log.push(['suspend']); this.state = 'suspended'; return Promise.resolve(); }
    close() { log.push(['close']); return Promise.resolve(); }
  }
  return {
    log, listeners, AudioContext: Context,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }
  };
}
const tickAsync = () => new Promise((resolve) => setImmediate(resolve));

test('Web Audio backend: buffers (5.5 kHz upsampled), the channel graph, loops, position, end and stop', async () => {
  assert.strictEqual(I.createWebAudioBackend({ window: {} }), null, 'no Web Audio: no backend');
  const win = fakeWindow(), backend = I.createWebAudioBackend({ window: win });
  const ended = [];
  const media = { rate: 5512.5, channels: [new Float32Array([0, 1, 0.5])] };
  const voice = backend.play(media, { start: 0, end: 3 / 5512.5, loops: 1, envelope: null, gains: [1, 0, 0, 0.5], sync: false, onended: () => ended.push(1) });
  assert.strictEqual(voice.position(), null, 'not started before its buffer is ready');
  await tickAsync();
  const source = voice.source;
  assert.deepStrictEqual([source.buffer.sampleRate, Array.from(source.buffer.data[0])], [11025, [0, 0.5, 1, 0.75, 0.5, 0.5]]);
  assert.deepStrictEqual(win.log.find((e) => e[0] === 'start').slice(1), [10, 0, 3 / 5512.5]);
  assert.ok(source.out.length === 2 && !source.out.some(([n]) => n.kind.startsWith('splitter')), 'mono feeds both sides');
  assert.deepStrictEqual(voice.channel.map((n) => n.gain.value), [1, 0, 0, 0.5]);
  voice.setGains([0.2, 0.2, 0.2, 0.2]);
  assert.deepStrictEqual(voice.channel.map((n) => n.gain.value), [0.2, 0.2, 0.2, 0.2]);
  win.log[0][1].currentTime = 10.0002;
  assert.ok(near(voice.position(), 0.0002));
  source.onended();
  source.onended && source.onended();
  assert.deepStrictEqual(ended, [1], 'onended once');
  assert.ok(win.listeners.pointerdown.length, 'waits for a gesture while suspended');
  win.listeners.pointerdown[0]();
  await tickAsync();
  assert.strictEqual(win.log[0][1].state, 'running');
  assert.ok(!win.listeners.pointerdown.length, 'stops listening once running');

  // Stereo with loops and an envelope; stopped by the player: no onended.
  const stereo = { rate: 22050, channels: [new Float32Array(2205), new Float32Array(2205)] };
  const looped = backend.play(stereo, { start: 0.02, end: 0.08, loops: 3, envelope: [{ time: 0, left: 1, right: 0 }, { time: 0.1, left: 0, right: 1 }], gains: [1, 0, 0, 1], onended: () => ended.push(2) });
  await tickAsync();
  const ls = looped.source;
  assert.ok(ls.out[0][0].kind === 'splitter2' && ls.loop && near(ls.loopStart, 0.02) && near(ls.loopEnd, 0.08));
  const starts = win.log.filter((e) => e[0] === 'start'), stops = win.log.filter((e) => e[0] === 'stop' && e.length > 1);
  assert.ok(near(starts[1][2], 0.02) && near(stops[0][1], 10.0002 + 0.18), 'three passes of the loop');
  const left = ls.out[0][0].out[0][0].gain.events;
  assert.deepStrictEqual(left.map((e) => [e[0], e[1]]), [['set', 1], ['set', 1], ['ramp', 0]]);
  win.log[0][1].currentTime = 10.0002 + 0.13;
  assert.ok(near(looped.position(), 0.02 + 0.01), 'position wraps around the loop');
  looped.stop();
  assert.ok(!looped.source && ended.length === 1);

  // MP3 through decodeAudioData (on a copy), suspend and resume, close.
  const mp3 = { rate: 44100, stereo: false, mp3: new Uint8Array([1, 2, 3]) };
  await backend.prepare(mp3);
  const decodeCall = win.log.find((e) => e[0] === 'decode');
  assert.ok(decodeCall[1] instanceof ArrayBuffer && decodeCall[1] !== mp3.mp3.buffer);
  const late = backend.play(mp3, { start: 0, end: 0.1, loops: 1, gains: [1, 0, 0, 1], sync: true });
  await tickAsync();
  assert.ok(late.source, 'played from the decoded buffer');
  backend.suspend();
  backend.resume();
  assert.deepStrictEqual(win.log.slice(-2).map((e) => e[0]), ['suspend', 'resume']);
  backend.close();
  assert.strictEqual(win.log[win.log.length - 1][0], 'close');
  assert.strictEqual(backend.play(media, { start: 0, end: 1, loops: 1, gains: [1, 0, 0, 1] }), null);

  const failing = I.createWebAudioBackend({ window: fakeWindow({ failDecode: true }) });
  const errors = [];
  failing.play(mp3, { start: 0, end: 1, loops: 1, gains: [1, 0, 0, 1], onerror: (e) => errors.push(e.message) });
  await tickAsync();
  assert.deepStrictEqual(errors, ['bad data']);
});
