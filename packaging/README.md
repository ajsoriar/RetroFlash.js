# RetroFlash.js

RetroFlash.js is a dependency-free Flash SWF player and ActionScript runtime for modern browsers. It plays SWF content on Canvas 2D with controlled ActionScript 1/2 support and a small ActionScript 3 subset.

RetroFlash.js 1.0.1 is the current version. The first stable release was 1.0.0. Review the [known limitations](https://github.com/ajsoriar/RetroFlash.js/blob/main/LIMITATIONS.md) for current SWF coverage.

## Install

```sh
npm install retroflash.js
```

## Browser usage

Load the browser bundle from the installed package:

```html
<canvas id="stage"></canvas>
<input id="swf" type="file" accept=".swf">
<script src="./node_modules/retroflash.js/dist/retroflash-{{version}}.min.js"></script>
<script>
  var player = new RetroFlash.Player({
    canvas: document.getElementById('stage')
  });

  document.getElementById('swf').addEventListener('change', function (event) {
    var file = event.target.files[0];
    if (file) player.load(file).then(function () { player.play(); });
  });
</script>
```

The bundle also detects legacy Flash `<object>` and `<embed>` elements. Movies can request navigation, page calls, or external resources; these browser interactions follow the browser's security rules, including CORS. See the [project README](https://github.com/ajsoriar/RetroFlash.js/blob/main/README.md) for usage.

The 1.0.1 browser bundle `dist/retroflash-{{version}}.min.js` uses ES5 syntax and targets Chrome 38 and later. It includes the compatibility fallbacks needed for older browsers; SWF feature support remains subject to the known limitations.

RetroFlash.js has no runtime dependencies. The browser needs Canvas 2D; Web Audio is optional.

## License

MIT. See the included `LICENSE` file.
