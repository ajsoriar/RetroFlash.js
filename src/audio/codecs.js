/* RetroFlash.js - Sound codecs: SWF sound data turned into samples an audio output can play. Uncompressed PCM
   and ADPCM are decoded here; MP3 is left to the output (browsers decode it natively), and only its frame
   headers are read, for files that scripts load (Sound.loadSound). Nellymoser and Speex are not decoded. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var FORMAT_NAMES = { 0: 'PCM', 1: 'ADPCM', 2: 'MP3', 3: 'PCM', 4: 'Nellymoser 16 kHz', 5: 'Nellymoser 8 kHz', 6: 'Nellymoser', 11: 'Speex' };
  function formatName(format) { return FORMAT_NAMES[format] || 'format ' + format; }

  /* Uncompressed samples: 8-bit unsigned or 16-bit signed little-endian (format 0, "native endian", is
     little-endian too in practice), interleaved when stereo. Writes at most `limit` sample frames into
     `channels` (Float32Arrays) from frame `at`; returns the number of frames written. */
  function decodePcm(bytes, is16Bit, stereo, channels, at, limit) {
    var count = stereo ? 2 : 1, frameBytes = count * (is16Bit ? 2 : 1);
    var frames = Math.min(limit, Math.floor(bytes.length / frameBytes)), p = 0;
    for (var i = 0; i < frames; i++) {
      for (var c = 0; c < count; c++) {
        var v;
        if (is16Bit) { v = bytes[p] | (bytes[p + 1] << 8); if (v >= 0x8000) v -= 0x10000; v /= 32768; p += 2; }
        else { v = (bytes[p] - 128) / 128; p++; }
        channels[c][at + i] = v;
      }
    }
    return frames;
  }

  /* ADPCM (SWF19 "ADPCM compression"): AdpcmCodeSize UB[2] (2 to 5 bits per code), then packets of 4096 sample
     frames. Each packet starts, per channel, with the first sample (SB[16]) and a step index (UB[6], so 0-63); 4095 codes
     per channel follow, interleaved when stereo. The last packet may be shorter. Same contract as decodePcm. */
  var STEP_SIZES = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598,
    658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
    4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
    20350, 22385, 24623, 27086, 29794, 32767];
  // Step index change for each code magnitude, by code size (2 to 5 bits).
  var INDEX_TABLES = {
    2: [-1, 2],
    3: [-1, -1, 2, 4],
    4: [-1, -1, -1, -1, 2, 4, 6, 8],
    5: [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16]
  };
  function decodeAdpcm(bytes, stereo, channels, at, limit) {
    var totalBits = bytes.length * 8, pos = 0;
    function bits(n) {
      var v = 0;
      for (var i = 0; i < n; i++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      return v;
    }
    if (totalBits < 2) return 0;
    var size = bits(2) + 2, table = INDEX_TABLES[size], sign = 1 << (size - 1), count = stereo ? 2 : 1;
    var sample = [0, 0], index = [0, 0], written = 0;
    while (written < limit && totalBits - pos >= 22 * count) {
      for (var c = 0; c < count; c++) {
        var first = bits(16);
        sample[c] = first >= 0x8000 ? first - 0x10000 : first;
        index[c] = bits(6);
        channels[c][at + written] = sample[c] / 32768;
      }
      written++;
      for (var n = 1; n < 4096 && written < limit && totalBits - pos >= size * count; n++, written++) {
        for (c = 0; c < count; c++) {
          var code = bits(size), step = STEP_SIZES[index[c]], diff = step >> (size - 1);
          for (var mask = sign >> 1, shift = 0; mask; mask >>= 1, shift++) if (code & mask) diff += step >> shift;
          var s = code & sign ? sample[c] - diff : sample[c] + diff;
          sample[c] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
          var next = index[c] + table[code & (sign - 1)];
          index[c] = next < 0 ? 0 : next > 88 ? 88 : next;
          channels[c][at + written] = sample[c] / 32768;
        }
      }
    }
    return written;
  }
  // The most sample frames `bytes` can hold in `format` (PCM and ADPCM), to size buffers before decoding.
  function maxFrames(format, bytes, is16Bit, stereo) {
    var count = stereo ? 2 : 1;
    if (format === 1) return bytes.length < 1 ? 0 : Math.floor((bytes.length * 8 - 2) / (2 * count)) + 1;
    return Math.floor(bytes.length / (count * (is16Bit ? 2 : 1)));
  }
  /* Decodes PCM or ADPCM sound data into { rate, channels: [Float32Array] } of at most `limit` frames (the
     declared sample count). One block of data per entry of `blocks` (stream blocks each restart the decoder);
     `starts` receives the first frame of each block. */
  function decodeBlocks(format, rate, is16Bit, stereo, blocks, limit, starts) {
    var capacity = 0;
    blocks.forEach(function (b) { capacity += maxFrames(format, b, is16Bit, stereo); });
    capacity = Math.min(capacity, limit);
    var count = stereo ? 2 : 1, channels = [], at = 0;
    for (var c = 0; c < count; c++) channels.push(new Float32Array(capacity));
    blocks.forEach(function (b) {
      if (starts) starts.push(at);
      var room = capacity - at;
      if (room > 0) at += format === 1 ? decodeAdpcm(b, stereo, channels, at, room) : decodePcm(b, is16Bit, stereo, channels, at, room);
    });
    return { rate: rate, channels: channels.map(function (ch) { return at < capacity ? ch.subarray(0, at) : ch; }) };
  }
  // Whether this module decodes `format` itself (PCM and ADPCM); MP3 goes to the output as it is.
  function decodesItself(format) { return format === 0 || format === 1 || format === 3; }

  /* MP3 frame headers (ISO 11172-3 and 13818-3, layer III only): { rate, stereo, sampleCount, start } for the
     frames found in `bytes`, after an ID3v2 tag if there is one; null when there is no valid frame. */
  var MP3_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  var MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mp3FrameAt(bytes, p) {
    if (p + 4 > bytes.length || bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) return null;
    var version = (bytes[p + 1] >> 3) & 3, layer = (bytes[p + 1] >> 1) & 3;
    var bitrateIndex = bytes[p + 2] >> 4, rateIndex = (bytes[p + 2] >> 2) & 3, padding = (bytes[p + 2] >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    var rate = MP3_RATES[version][rateIndex], bitrate = MP3_BITRATES[version === 3 ? 1 : 2][bitrateIndex] * 1000;
    var samples = version === 3 ? 1152 : 576;
    return { rate: rate, stereo: (bytes[p + 3] >> 6) !== 3, samples: samples, length: Math.floor(samples / 8 * bitrate / rate) + padding };
  }
  function parseMp3(bytes) {
    var p = 0;
    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      p = 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
      if (bytes[5] & 0x10) p += 10; // footer
    }
    var first = null, start = 0, sampleCount = 0;
    // Junk before the first frame is skipped (up to 64 KiB); after it, frames must follow each other.
    for (var limit = Math.min(bytes.length, p + 65536); p < limit && !first; p++) {
      var frame = mp3FrameAt(bytes, p), next = frame && mp3FrameAt(bytes, p + frame.length);
      if (frame && (next || p + frame.length === bytes.length)) { first = frame; start = p; }
    }
    if (!first) return null;
    for (p = start; ;) {
      var f = mp3FrameAt(bytes, p);
      if (!f || p + f.length > bytes.length) break;
      sampleCount += f.samples;
      p += f.length;
    }
    return { rate: first.rate, stereo: first.stereo, sampleCount: sampleCount, start: start };
  }

  Object.assign(M, {
    soundFormatName: formatName, decodeSoundBlocks: decodeBlocks, decodesItself: decodesItself, parseMp3: parseMp3,
    decodePcm: decodePcm, decodeAdpcm: decodeAdpcm
  });
})(typeof window !== 'undefined' ? window : globalThis);
