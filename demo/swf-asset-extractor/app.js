/* SWF Asset Extractor - the page: file selection, progress, the movie header, and the resource table built
   from SWFAssetExtractor.analyze (extract.js). Text from the SWF only ever enters the page through
   textContent; previews use object URLs, which are revoked when another file is opened. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var input = $('file'), drop = $('drop'), status = $('status'), progress = $('progress'), filter = $('filter');
  var STATUS_LABELS = { converted: 'converted', partial: 'partial', raw: 'raw data', unsupported: 'not convertible', error: 'error' };
  var urls = [], fontFaces = [], run = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function urlOf(blob) {
    var url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  }
  function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
  }
  function setStatus(text, isError) {
    status.textContent = text;
    status.className = 'status' + (isError ? ' error' : '');
  }
  // Forgets the previous file: its rows, previews, object URLs and preview fonts.
  function reset() {
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    fontFaces.forEach(function (f) { if (document.fonts) document.fonts.delete(f); });
    fontFaces = [];
    $('rows').textContent = '';
    $('header').textContent = '';
    $('diagnostics').textContent = '';
    filter.textContent = '';
    $('movie').hidden = $('results').hidden = $('diagnostics-box').hidden = $('empty').hidden = true;
  }

  // ---- Movie header ----

  function renderMovie(movie) {
    var header = $('header'), bg = movie.background;
    [
      ['File', movie.name], ['SWF version', movie.version], ['Compression', movie.compression],
      ['Stage', movie.width + ' × ' + movie.height + ' px'], ['Frame rate', movie.fps + ' fps'],
      ['Frames', movie.frames + (movie.actualFrames !== movie.frames ? ' (' + movie.actualFrames + ' found)' : '')],
      ['File size', size(movie.fileSize) + (movie.declaredLength !== movie.fileSize ? ' (' + size(movie.declaredLength) + ' uncompressed)' : '')],
      ['Tags', movie.tags], ['Background', bg ? 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')' : 'not set'], ['ActionScript', movie.actionScript]
    ].forEach(function (pair) {
      var box = el('div');
      box.appendChild(el('dt', null, pair[0]));
      box.appendChild(el('dd', null, pair[1]));
      header.appendChild(box);
    });
    var notes = movie.diagnostics.map(function (d) { return [d.level, d.code, d.path || '', d.message]; })
      .concat(movie.unsupported.map(function (u) { return ['not decoded', u.feature, u.firstPath || '', u.count + '×: ' + u.reason]; }));
    if (notes.length) {
      var body = $('diagnostics');
      notes.slice(0, 500).forEach(function (n) {
        var tr = el('tr');
        n.forEach(function (v, i) { tr.appendChild(el('td', i === 2 ? 'mono' : null, v)); });
        body.appendChild(tr);
      });
      $('diagnostics-summary').textContent = 'Reader notes (' + movie.diagnostics.length + ' diagnostic' + (movie.diagnostics.length === 1 ? '' : 's') + ', ' + movie.unsupported.length + ' kind' + (movie.unsupported.length === 1 ? '' : 's') + ' of data not decoded)';
      $('diagnostics-box').hidden = false;
    }
    $('movie').hidden = false;
  }

  // ---- Resource rows ----

  function previewCell(a) {
    var td = el('td', 'preview'), p = a.preview;
    if (!p) { td.appendChild(el('span', 'none', 'no preview')); return td; }
    if (p.type === 'image' || p.type === 'images') {
      (p.type === 'image' ? [{ blob: p.blob, caption: null }] : p.items).forEach(function (item) {
        var fig = el('figure'), img = el('img');
        img.alt = p.alt || a.title + (item.caption ? ' (' + item.caption + ')' : '');
        img.loading = 'lazy';
        img.src = urlOf(item.blob);
        fig.appendChild(img);
        if (item.caption) fig.appendChild(el('figcaption', null, item.caption));
        td.appendChild(fig);
      });
    } else if (p.type === 'audio') {
      var audio = el('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = urlOf(p.blob);
      audio.setAttribute('aria-label', a.title);
      td.appendChild(audio);
    } else if (p.type === 'text') {
      td.appendChild(el('pre', null, p.text.length > 400 ? p.text.slice(0, 400) + '…' : p.text));
    } else if (p.type === 'font') {
      var sample = el('span', 'font', 'Aa Bb 123');
      td.appendChild(sample);
      loadFont(p, sample);
    }
    return td;
  }
  // Shows a font program's sample with the font itself, when the browser can load it.
  function loadFont(p, sample) {
    if (typeof FontFace !== 'function' || !document.fonts) { sample.textContent = 'preview unavailable'; return; }
    var family = 'SWF extracted font ' + (fontFaces.length + 1), current = run;
    p.blob.arrayBuffer().then(function (buffer) {
      var face = new FontFace(family, buffer);
      return face.load().then(function () {
        if (current !== run) return;
        document.fonts.add(face);
        fontFaces.push(face);
        sample.style.fontFamily = '"' + family + '", serif';
      });
    }).catch(function () { sample.textContent = 'the browser cannot display this font'; });
  }
  function downloadsCell(a) {
    var td = el('td', 'downloads');
    if (!a.outputs.length) td.appendChild(el('span', 'none', 'nothing to download'));
    a.outputs.forEach(function (o) {
      var link = el('a', null, o.label + ' ');
      link.href = urlOf(o.blob);
      link.download = o.filename;
      link.type = o.mime;
      link.title = o.filename;
      link.appendChild(el('small', null, '(' + size(o.blob.size) + ')'));
      td.appendChild(link);
    });
    return td;
  }
  function detailsRow(a) {
    var tr = el('tr', 'details'), td = el('td');
    td.colSpan = 6;
    if (a.explanation) td.appendChild(el('p', 'explain', a.explanation));
    if (a.error) td.appendChild(el('p', 'problem', 'Could not convert: ' + a.error));
    if (a.metadata.length) {
      var dl = el('dl', 'facts');
      a.metadata.forEach(function (m) {
        var box = el('div');
        box.appendChild(el('dt', null, m[0]));
        box.appendChild(el('dd', null, m[1]));
        dl.appendChild(box);
      });
      td.appendChild(dl);
    }
    if (a.limitations.length) {
      var ul = el('ul', 'limits');
      a.limitations.forEach(function (l) { ul.appendChild(el('li', null, l)); });
      td.appendChild(ul);
    }
    tr.appendChild(td);
    return tr;
  }
  function renderAssets(result) {
    var body = $('rows'), counts = {}, kinds = SWFAssetExtractor.kinds;
    result.assets.forEach(function (a) {
      counts[a.kind] = (counts[a.kind] || 0) + 1;
      var tr = el('tr', 'asset');
      tr.dataset.kind = a.kind;
      tr.appendChild(previewCell(a));
      var name = el('td');
      name.appendChild(el('span', 'title', a.title));
      name.appendChild(el('span', 'kind', kinds[a.kind] || a.kind));
      name.appendChild(el('span', 'chip ' + a.status, STATUS_LABELS[a.status] || a.status));
      tr.appendChild(name);
      tr.appendChild(el('td', null, a.format || '—'));
      var sizes = el('td', null, a.outputs.length ? size(a.outputs[0].blob.size) : '—');
      sizes.appendChild(el('span', 'kind', size(a.encodedBytes) + ' in the SWF'));
      tr.appendChild(sizes);
      var where = el('td');
      where.appendChild(el('span', null, a.tagName + (a.characterId !== null ? ' #' + a.characterId : '')));
      where.appendChild(el('span', 'kind mono', 'path ' + a.path + ', offset ' + a.offset));
      tr.appendChild(where);
      tr.appendChild(downloadsCell(a));
      var details = detailsRow(a);
      details.dataset.kind = a.kind;
      body.appendChild(tr);
      body.appendChild(details);
    });
    var all = el('option', null, 'All resources (' + result.assets.length + ')');
    all.value = '';
    filter.appendChild(all);
    Object.keys(kinds).forEach(function (k) {
      if (!counts[k]) return;
      var option = el('option', null, kinds[k] + ' (' + counts[k] + ')');
      option.value = k;
      filter.appendChild(option);
    });
    var empty = $('empty');
    if (!result.assets.length) {
      empty.textContent = 'No extractable resources were found in this file. Its structure is described in the reader notes above.';
      empty.hidden = false;
    } else if (result.skipped) {
      empty.textContent = 'This file has more resources than this page lists at once; ' + result.skipped + ' further resource(s) were not converted.';
      empty.hidden = false;
    }
    $('results').hidden = false;
  }
  filter.addEventListener('change', function () {
    var kind = filter.value;
    Array.prototype.forEach.call($('rows').children, function (tr) { tr.hidden = !!kind && tr.dataset.kind !== kind; });
  });

  // ---- File selection ----

  function readFile(file) {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('The file could not be read.')); };
      reader.readAsArrayBuffer(file);
    });
  }
  function open(file) {
    if (!file) return;
    var current = ++run;
    reset();
    setStatus('Reading ' + file.name + '…');
    progress.hidden = false;
    progress.removeAttribute('value');
    readFile(file).then(function (buffer) {
      if (current !== run) return null;
      setStatus('Extracting resources from ' + file.name + '…');
      return SWFAssetExtractor.analyze(new Uint8Array(buffer), file.name, function (done, total) {
        if (current !== run) return;
        progress.max = total;
        progress.value = done;
        setStatus('Extracting resources from ' + file.name + ': ' + done + ' of ' + total + '…');
      });
    }).then(function (result) {
      if (!result || current !== run) return;
      progress.hidden = true;
      renderMovie(result.movie);
      renderAssets(result);
      var errors = result.assets.filter(function (a) { return a.status === 'error'; }).length;
      setStatus(file.name + ': ' + result.assets.length + ' resource(s) found' + (errors ? ', ' + errors + ' could not be converted (see their rows)' : '') + '.');
    }).catch(function (err) {
      if (current !== run) return;
      progress.hidden = true;
      var message = err && err.message ? err.message.replace(/^SWFReader: /, '') : String(err);
      setStatus('This file could not be read as a SWF movie: ' + message, true);
    });
  }

  input.addEventListener('change', function () { open(input.files[0]); input.value = ''; });
  drop.addEventListener('click', function () { input.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { open(e.dataTransfer && e.dataTransfer.files[0]); });
  if (typeof SWFAssetExtractor === 'undefined') setStatus('The extractor scripts did not load; open this page from its own folder.', true);
})();
