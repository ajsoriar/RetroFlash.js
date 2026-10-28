/* RetroFlash.js - The sounds of a movie: event sounds (StartSound, button sounds, the AVM1 Sound object) and
   timeline stream sounds (SoundStreamHead/SoundStreamBlock), with their volume and pan. Playing them is the
   job of an audio backend; without one, sounds are tracked but silent. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;
  var decodeSoundBlocks = M.decodeSoundBlocks, decodesItself = M.decodesItself, soundFormatName = M.soundFormatName;

  var MAX_SOUNDS = 32;            // sounds playing at once, streams included, as in Flash Player
  var STREAM_RESYNC_SECONDS = 1;  // a stream further than this from its timeline starts again where the timeline is
  var EVENT_RATE = 44100;         // in and out points, envelopes and Sound.start offsets count 44.1 kHz samples

  /* The backend contract (the Player option `audio`; browser/web-audio.js gives the Web Audio one):
     - play(media, options) starts a sound and returns a voice, or null. `media` is decoded samples,
       { rate, channels: [Float32Array] }, or MP3 frames for the backend to decode, { rate, stereo, mp3 }. The
       same object comes back for the same sound, so the backend can cache what it makes of it. options:
       { start, end (seconds in the media), loops (1 or more), envelope ([{ time (seconds from the start of
       playback), left, right (0-1) }] or null), gains ([ll, lr, rl, rr]: left from left, left from right,
       right from left, right from right), sync (a stream: a late start skips what is late), onended() (the
       sound finished by itself), onerror(error) (it could not be decoded) }.
     - voice.stop(); voice.setGains(gains); voice.position() gives seconds in the media, or null before it starts.
     - Optional: prepare(media) decodes ahead; suspend() and resume() pause and continue every sound;
       setVolume(0-1); close() ends everything. */

  // A sound transform as AVM1 Sound sets it: volume and the four channel weights, in percent.
  function newTransform() { return { volume: 100, ll: 100, lr: 0, rl: 0, rr: 100 }; }
  // The gains `g` (a 2x2 matrix [ll, lr, rl, rr]) followed by transform `t`.
  function applyTransform(g, t) {
    var v = t.volume / 10000, ll = t.ll * v, lr = t.lr * v, rl = t.rl * v, rr = t.rr * v;
    return [ll * g[0] + lr * g[2], ll * g[1] + lr * g[3], rl * g[0] + rr * g[2], rl * g[1] + rr * g[3]];
  }
  function channelsOf(sound) { return sound.stereo ? 2 : 1; }

  /* The sounds of one player. `limits.maxAudioSamples` bounds the samples decoded and kept (all sounds and
     streams together). Instances are { sound, owner (the clip that started it, or the AVM1 Sound target),
     soundObject (an AVM1 Sound), stream (the clip whose stream it is), voice, skip, done }. */
  function AudioController(backend, report, limits) {
    this.backend = backend || null;
    this.report = report || function () {};
    this.maxSamples = limits && limits.maxAudioSamples ? limits.maxAudioSamples : M.DEFAULT_LIMITS.maxAudioSamples;
    this.samples = 0;
    this.cache = new Map();      // sound character or stream -> media data (null when it cannot be played)
    this.instances = [];
    this.ended = [];             // instances whose voice finished, until collect()
    this.quiet = 0;              // while above 0, frames entered start no sound (seeking, button hit areas)
    this.transform = newTransform(); // the global transform: new Sound() without a target
    this.volume = 1;
  }

  // ---- Media ----
  // The samples of a sound character, or null when they cannot be played (reported once).
  AudioController.prototype.mediaOf = function (sound) {
    if (this.cache.has(sound)) return this.cache.get(sound);
    var media = null, data = sound.bytes || sound.swf.getTagData(sound.tag).subarray(sound.dataStart);
    if (sound.format === 2) {
      if (this.reserve(sound.sampleCount * channelsOf(sound), sound.id)) media = { rate: sound.rate, stereo: sound.stereo, mp3: data };
    } else if (decodesItself(sound.format)) {
      // The declared sample count may exceed what the data holds; only decoded samples count.
      var room = Math.floor((this.maxSamples - this.samples) / channelsOf(sound));
      media = decodeSoundBlocks(sound.format, sound.rate, sound.is16Bit, sound.stereo, [data], Math.min(sound.sampleCount, room));
      if (media.channels[0].length === room && room < sound.sampleCount) { media = null; this.overBudget(sound.id); }
      else this.samples += media.channels[0].length * media.channels.length;
    } else {
      this.unsupportedFormat(sound.format, sound.id);
    }
    this.cache.set(sound, media);
    return media;
  };
  AudioController.prototype.reserve = function (samples, source) {
    if (this.samples + samples > this.maxSamples) { this.overBudget(source); return false; }
    this.samples += samples;
    return true;
  };
  AudioController.prototype.overBudget = function (source) {
    this.report('sound:memoryLimit', 'Decoded sounds would exceed limits.maxAudioSamples (' + this.maxSamples + ' samples); this sound is not played.', source);
  };
  AudioController.prototype.unsupportedFormat = function (format, source) {
    this.report('sound:' + soundFormatName(format), soundFormatName(format) + ' sound data is not decoded yet; the sound is not played.', source);
  };
  /* The stream of a timeline (def.stream: { head, blocks: [{ frame, tag }], swf }) as one sound: { media,
     starts (frame -> seconds where its block begins), duration, skip }, or null. MP3 blocks are joined into
     one run of frames; PCM and ADPCM blocks are decoded one by one. */
  AudioController.prototype.streamData = function (stream) {
    if (this.cache.has(stream)) return this.cache.get(stream);
    var head = stream.head, data = null;
    if (!head) {
      this.report('sound:streamWithoutHead', 'SoundStreamBlock without a SoundStreamHead in its timeline; the stream is not played.', stream.name);
    } else if (head.format === 2) {
      data = this.mp3Stream(stream, head);
    } else if (decodesItself(head.format)) {
      var starts = new Map(), firsts = [], room = Math.floor((this.maxSamples - this.samples) / channelsOf(head));
      var media = decodeSoundBlocks(head.format, head.rate, head.is16Bit, head.stereo,
        stream.blocks.map(function (b) { return stream.swf.getTagData(b.tag); }), room, firsts);
      var frames = media.channels[0].length;
      this.samples += frames * media.channels.length;
      stream.blocks.forEach(function (b, i) { if (!starts.has(b.frame)) starts.set(b.frame, firsts[i] / head.rate); });
      if (frames === room) this.overBudget(stream.name); // what fitted still plays
      data = { media: media, starts: starts, duration: frames / head.rate, skip: 0 };
    } else {
      this.unsupportedFormat(head.format, stream.name);
    }
    this.cache.set(stream, data);
    return data;
  };
  // MP3 stream blocks: SampleCount (UI16) and SeekSamples (SI16), then MP3 frames.
  AudioController.prototype.mp3Stream = function (stream, head) {
    var parts = [], size = 0, samples = 0, starts = new Map();
    stream.blocks.forEach(function (b) {
      var d = stream.swf.getTagData(b.tag);
      if (d.length < 4) return;
      if (!starts.has(b.frame)) starts.set(b.frame, samples / head.rate);
      samples += d[0] | (d[1] << 8);
      parts.push(d.subarray(4));
      size += d.length - 4;
    });
    if (!this.reserve(samples * channelsOf(head), stream.name)) return null;
    var bytes = new Uint8Array(size), at = 0;
    parts.forEach(function (p) { bytes.set(p, at); at += p.length; });
    return {
      media: { rate: head.rate, stereo: head.stereo, mp3: bytes }, starts: starts, duration: samples / head.rate,
      skip: head.latencySeek > 0 ? head.latencySeek / head.rate : 0
    };
  };
  // Lets the backend decode a movie's MP3 sounds and streams ahead of their first use.
  AudioController.prototype.prepare = function (movie) {
    if (!this.backend || typeof this.backend.prepare !== 'function') return;
    var self = this;
    Object.keys(movie.characters).forEach(function (id) {
      var c = movie.characters[id];
      if (c.type === 'sound' && c.format === 2) self.prepareMedia(self.mediaOf(c));
      else if (c.type === 'sprite' && c.stream && c.stream.head && c.stream.head.format === 2) self.prepareStream(c.stream);
    });
    if (movie.root.stream && movie.root.stream.head && movie.root.stream.head.format === 2) this.prepareStream(movie.root.stream);
  };
  AudioController.prototype.prepareStream = function (stream) {
    var data = this.streamData(stream);
    if (data) this.prepareMedia(data.media);
  };
  AudioController.prototype.prepareMedia = function (media) {
    if (!media) return;
    var self = this;
    Promise.resolve().then(function () { return self.backend && self.backend.prepare(media); }).catch(function () { /* reported when played */ });
  };

  // ---- Playing ----
  // The gains of a sound owned by `owner`: the transforms of the owner and its parents, then the global one.
  AudioController.prototype.gainsFor = function (owner) {
    var g = [1, 0, 0, 1];
    for (var clip = owner; clip; clip = clip.parent) if (clip.soundTransform) g = applyTransform(g, clip.soundTransform);
    return applyTransform(g, this.transform);
  };
  // Applies changed transforms to the sounds playing.
  AudioController.prototype.refresh = function () {
    var self = this;
    this.instances.forEach(function (i) { i.voice.setGains(self.gainsFor(i.owner)); });
  };
  AudioController.prototype.canPlay = function (source) {
    if (!this.backend) {
      this.report('sound:noOutput', 'Sounds are not played: the player has no audio output (the Player option `audio`, or a browser without Web Audio).', source);
      return false;
    }
    if (this.instances.length >= MAX_SOUNDS) {
      this.report('sound:limit', 'More than ' + MAX_SOUNDS + ' sounds at once; further ones are not played.', source);
      return false;
    }
    return true;
  };
  AudioController.prototype.play = function (inst, media, options) {
    var self = this;
    options.gains = this.gainsFor(inst.owner);
    options.onended = function () { self.ended.push(inst); };
    options.onerror = function (err) {
      self.ended.push(inst);
      self.report('sound:decodeFailed', 'A sound could not be decoded and is not played.', (inst.sound ? inst.sound.id : 'stream') + ': ' + (err && err.message ? err.message : err));
    };
    inst.voice = this.backend.play(media, options);
    if (!inst.voice) return null;
    this.instances.push(inst);
    return inst;
  };
  /* Starts an event sound. settings: SOUNDINFO fields { inPoint, outPoint, loopCount, envelope } (positions
     in 44.1 kHz samples); a loop count below 1 plays once. Returns the instance, or null. */
  AudioController.prototype.start = function (sound, settings, owner, soundObject) {
    if (!this.canPlay(sound.id)) return null;
    var media = this.mediaOf(sound);
    if (!media) return null;
    // MP3 data starts with decoder delay (SeekSamples), which is skipped.
    var skip = sound.format === 2 && sound.seekSamples > 0 ? sound.seekSamples / sound.rate : 0, length = sound.sampleCount / sound.rate;
    var start = Math.min(length, (settings.inPoint || 0) / EVENT_RATE);
    var end = settings.outPoint !== undefined ? Math.min(length, settings.outPoint / EVENT_RATE) : length;
    if (end <= start) return null;
    var envelope = settings.envelope && settings.envelope.length ? settings.envelope.map(function (p) {
      return { time: p.pos44 / EVENT_RATE, left: p.left / 32768, right: p.right / 32768 };
    }) : null;
    var inst = { sound: sound, owner: owner || null, soundObject: soundObject || null, stream: null, voice: null, skip: skip, done: false };
    return this.play(inst, media, { start: skip + start, end: skip + end, loops: Math.max(1, settings.loopCount || 1), envelope: envelope, sync: false });
  };
  /* StartSound and button sounds: SOUNDINFO syncStop stops the sound, syncNoMultiple starts it only when it is
     not playing already. `characters` is the dictionary of the movie the tag comes from. */
  AudioController.prototype.perform = function (owner, characters, soundId, info) {
    var sound = characters[soundId];
    if (!sound || sound.type !== 'sound') {
      return this.report('sound:missingCharacter', 'A StartSound or button sound refers to a sound id that is not defined; nothing is played.', soundId);
    }
    if (info.syncStop) return this.stopSound(sound);
    if (info.syncNoMultiple && this.isPlaying(sound)) return;
    this.start(sound, info, owner, null);
  };
  AudioController.prototype.isPlaying = function (sound) {
    return this.instances.some(function (i) { return i.sound === sound; });
  };
  AudioController.prototype.remove = function (inst) {
    var at = this.instances.indexOf(inst);
    if (at >= 0) this.instances.splice(at, 1);
    if (inst.done) return;
    inst.done = true;
    inst.voice.stop();
  };
  AudioController.prototype.stopWhere = function (match) {
    var self = this;
    this.instances.filter(match).forEach(function (i) { self.remove(i); });
  };
  AudioController.prototype.stopSound = function (sound) { this.stopWhere(function (i) { return i.sound === sound; }); };
  // StopSounds (stopAllSounds) and the global Sound's stop(): every sound, streams included.
  AudioController.prototype.stopAll = function () { this.stopWhere(function () { return true; }); };
  // A targeted Sound's stop(): the sounds that clip started or that were started through its Sound objects.
  AudioController.prototype.stopOwned = function (clip) { this.stopWhere(function (i) { return i.owner === clip; }); };

  /* A timeline entered frame `n`. Its StartSound tags play. A stream plays while its timeline does: a timeline
     that reaches one of its blocks by playing (`ticked`; also when a timeline enters its first frame) starts
     it from that block, or, when it is already playing, starts it again if it drifted too far; a jump
     (gotoAndPlay, ...) stops it until the timeline plays into a block again. */
  AudioController.prototype.enterFrame = function (clip, n, ticked) {
    if (this.quiet) return;
    var tags = clip.def.frames[n - 1];
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (tag.code === 15 && tag.fields) this.perform(clip, clip.env.characters, tag.fields.soundId, tag.fields.info);
      else if (tag.code === 89) this.report('sound:StartSound2', 'StartSound2 names an ActionScript 3 sound class; it is not played.', tag.fields ? tag.fields.className : tag.offset);
    }
    var stream = clip.def.stream;
    if (!stream) return;
    var current = this.streamOf(clip);
    if (!ticked) { if (current) this.remove(current); return; }
    var data = this.streamData(stream), time = data ? data.starts.get(n) : undefined;
    if (time === undefined) return;
    if (current) {
      var position = current.voice.position();
      if (position === null || Math.abs(position - current.skip - time) < STREAM_RESYNC_SECONDS) return;
      this.remove(current);
    }
    if (!this.canPlay(stream.name)) return;
    var inst = { sound: null, owner: clip, soundObject: null, stream: clip, def: clip.def, voice: null, skip: data.skip, done: false };
    this.play(inst, data.media, { start: data.skip + time, end: data.skip + data.duration, loops: 1, envelope: null, sync: true });
  };
  AudioController.prototype.streamOf = function (clip) {
    for (var i = 0; i < this.instances.length; i++) if (this.instances[i].stream === clip) return this.instances[i];
    return null;
  };
  // After an update: streams of timelines that stopped, left the stage or changed content end.
  AudioController.prototype.sync = function () {
    this.stopWhere(function (i) { var c = i.stream; return c && (c.removed || !c.playing || c.def !== i.def); });
  };
  /* Before a tick: sounds that finished leave the list, and AVM1 Sound objects get an onSoundComplete call
     queued on `scheduler` for each of their sounds that finished. The position of each Sound object (its
     latest sound) is updated. */
  AudioController.prototype.collect = function (scheduler) {
    var ended = this.ended.splice(0), self = this, rt = null;
    function runtime() { return rt || (rt = M.runtimeOf(scheduler)); }
    ended.forEach(function (inst) {
      if (inst.done) return;
      self.remove(inst);
      var obj = inst.soundObject;
      if (!obj) return;
      if (obj.instance === inst) setPosition(runtime(), obj, obj.soundDuration);
      scheduler.enqueueCall(scheduler.root, M.getMember(runtime(), obj, 'onSoundComplete'), obj, [], 'onSoundComplete');
    });
    this.instances.forEach(function (inst) {
      var obj = inst.soundObject, position = obj && obj.instance === inst ? inst.voice.position() : null;
      if (position !== null) setPosition(runtime(), obj, Math.max(0, Math.round((position - inst.skip) * 1000)));
    });
  };
  function setPosition(rt, obj, ms) { M.setOwn(obj, 'position', ms, rt.version, true); }

  // ---- The player ----
  // A movie starts again: every sound stops and the global transform is reset.
  AudioController.prototype.reset = function () {
    this.stopAll();
    this.ended.length = 0;
    this.transform = newTransform();
  };
  // Another movie: decoded sounds are released as well.
  AudioController.prototype.clear = function () {
    this.reset();
    this.cache.clear();
    this.samples = 0;
  };
  AudioController.prototype.suspend = function () { if (this.backend && this.backend.suspend) this.backend.suspend(); };
  AudioController.prototype.resume = function () { if (this.backend && this.backend.resume) this.backend.resume(); };
  AudioController.prototype.setVolume = function (volume) {
    this.volume = volume;
    if (this.backend && this.backend.setVolume) this.backend.setVolume(volume);
  };
  AudioController.prototype.close = function () {
    this.clear();
    if (this.backend && this.backend.close) this.backend.close();
    this.backend = null;
  };

  // The sounds of a scheduler; a silent controller when the scheduler has none (tests, tools).
  function audioOf(scheduler) {
    return scheduler.audio || (scheduler.audio = new AudioController(null, scheduler.report, scheduler.limits));
  }

  Object.assign(M, { AudioController: AudioController, audioOf: audioOf, newSoundTransform: newTransform, MAX_SOUNDS: MAX_SOUNDS });
})(typeof window !== 'undefined' ? window : globalThis);
