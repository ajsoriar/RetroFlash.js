# RetroFlash.js

RetroFlash.js is a dependency-free Flash SWF player and ActionScript runtime for modern browsers. It plays SWF content on Canvas 2D with controlled ActionScript 1/2 support and a small ActionScript 3 subset.

RetroFlash.js 1.0.0 is the first stable release. Review the [known limitations](https://github.com/ajsoriar/RetroFlash.js/blob/main/LIMITATIONS.md) for current SWF coverage.

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
  const player = new RetroFlash.Player({
    canvas: document.getElementById('stage')
  });

  document.getElementById('swf').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await player.load(file);
    player.play();
  });
</script>
```

The bundle also detects legacy Flash `<object>` and `<embed>` elements. Movies can request navigation, page calls, or external resources; these browser interactions follow the browser's security rules, including CORS. See the [project README](https://github.com/ajsoriar/RetroFlash.js/blob/main/README.md) for usage.

The package also includes `dist/retroflash-{{version}}.legacy.min.js`, transpiled to ES5 syntax for older JavaScript engines. It adds the few ES2015 functions the player needs, and both bundles fall back to `XMLHttpRequest`, a JavaScript zlib/DEFLATE decoder, mouse events, and `<img>` image decoding where newer browser APIs are missing.

RetroFlash.js has no runtime dependencies. The browser needs Canvas 2D; Web Audio is optional.

## License

MIT. See the included `LICENSE` file.
