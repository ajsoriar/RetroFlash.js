/* RetroFlash.js - Matrices [a, b, c, d, tx, ty] (Canvas order) and colour transforms. */
(function (global) {
  'use strict';

  var M = global.RetroFlashModules;

  var IDENTITY = [1, 0, 0, 1, 0, 0];
  // SWF MATRIX: x' = x*ScaleX + y*RotateSkew1 + TranslateX; y' = x*RotateSkew0 + y*ScaleY + TranslateY.
  function toMatrix(m) { return m ? [m.scaleX, m.rotateSkew0, m.rotateSkew1, m.scaleY, m.translateX, m.translateY] : IDENTITY; }
  function multiply(p, c) {
    return [
      p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
      p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
      p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]
    ];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det || !isFinite(det)) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function transformPoint(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // Colour transform [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, aAdd]; multipliers as factors (SWF 256 = 1.0).
  var CX_IDENTITY = [1, 1, 1, 1, 0, 0, 0, 0];
  function toColorTransform(c) {
    if (!c) return CX_IDENTITY;
    return [c.redMult / 256, c.greenMult / 256, c.blueMult / 256, c.alphaMult === undefined ? 1 : c.alphaMult / 256,
      c.redAdd, c.greenAdd, c.blueAdd, c.alphaAdd || 0];
  }
  // Child transform applied first, then the parent's.
  function concatColorTransform(p, c) {
    return [p[0] * c[0], p[1] * c[1], p[2] * c[2], p[3] * c[3],
      p[0] * c[4] + p[4], p[1] * c[5] + p[5], p[2] * c[6] + p[6], p[3] * c[7] + p[7]];
  }
  function channel(v) { return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v); }
  function cssColor(color, cx) {
    return 'rgba(' + channel(color.r * cx[0] + cx[4]) + ',' + channel(color.g * cx[1] + cx[5]) + ',' +
      channel(color.b * cx[2] + cx[6]) + ',' + channel(color.a * cx[3] + cx[7]) / 255 + ')';
  }

  Object.assign(M, { IDENTITY: IDENTITY, toMatrix: toMatrix, multiply: multiply, invert: invert,
    transformPoint: transformPoint, CX_IDENTITY: CX_IDENTITY, toColorTransform: toColorTransform,
    concatColorTransform: concatColorTransform, cssColor: cssColor });
})(typeof window !== 'undefined' ? window : globalThis);
