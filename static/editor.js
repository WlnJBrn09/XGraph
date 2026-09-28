(() => {
  'use strict';
  const M = window.GraphModel;
  const $ = id => document.getElementById(id);
  const canvas = $('draw-canvas');
  let data = M.blank(), changed = () => {}, tool = 'select', selected = null, drag = null;
  let fill = '#b8c0cb', stroke = '#24272d', strokeWidth = 2;
  const undo = [], redo = [];
  function checkpoint() { undo.push(JSON.stringify(data)); if (undo.length > 80) undo.shift(); redo.length = 0; }
  function mark() { changed(); }
  function current() { return data.shapes.find(shape => shape.id === selected); }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(data.width, (event.clientX - rect.left) / rect.width * data.width));
    const y = Math.max(0, Math.min(data.height, (event.clientY - rect.top) / rect.height * data.height));
    return data.snap ? { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 } : { x, y };
  }
  function outline(shape) {
    let x = shape.x, y = shape.y, w = shape.w || 100, h = shape.h || 50;
    if (shape.type === 'text') { w = Math.max(60, shape.text.length * shape.fontSize * .52); h = shape.fontSize * 1.2; y -= h; }
    if (shape.type === 'pen' && shape.points.length) {
      const xs = shape.points.map(p => p[0]), ys = shape.points.map(p => p[1]);
      x += Math.min(...xs); y += Math.min(...ys); w = Math.max(...xs) - Math.min(...xs); h = Math.max(...ys) - Math.min(...ys);
    }
    return `<rect class="selection" x="${Math.min(x, x + w) - 6}" y="${Math.min(y, y + h) - 6}" width="${Math.abs(w) + 12}" height="${Math.abs(h) + 12}"/>`;
  }
  function renderCanvas() {
    canvas.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
    canvas.setAttribute('width', data.width); canvas.setAttribute('height', data.height);
    canvas.dataset.tool = tool;
    canvas.innerHTML = M.body(data, true) + (current() ? outline(current()) : '');
  }
  function renderInspector() {
    $('page-width').value = data.width; $('page-height').value = data.height;
    $('show-grid').checked = data.grid; $('snap-grid').checked = data.snap;
    const shape = current();
    $('shape-fill').value = /^#[0-9a-f]{6}$/i.test(shape?.fill || '') ? shape.fill : fill;
    $('shape-stroke').value = /^#[0-9a-f]{6}$/i.test(shape?.stroke || '') ? shape.stroke : stroke;
    $('stroke-width').value = shape?.strokeWidth ?? strokeWidth;
    $('shape-text').value = shape?.type === 'text' ? shape.text : '';
    $('shape-text').disabled = shape?.type !== 'text';
    const layers = $('layers'); layers.replaceChildren();
    [...data.shapes].reverse().forEach(shape => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'layer-item' + (shape.id === selected ? ' active' : '');
      button.textContent = `${shape.type === 'text' ? (shape.text || 'Text').slice(0, 28) : shape.type[0].toUpperCase() + shape.type.slice(1)}`;
      button.addEventListener('click', () => { selected = shape.id; tool = 'select'; updateTool(); render(); }); layers.append(button);
    });
  }
  function updateTool() { document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool))); }
  function render() { renderCanvas(); renderInspector(); updateTool(); }
  function blank() { data = M.blank(); undo.length = 0; redo.length = 0; selected = null; render(); }
  function load(value) { data = M.normalize(value); undo.length = 0; redo.length = 0; selected = null; render(); }
  function makeShape(type, p) {
    return { id: M.id(), type, x: p.x, y: p.y, w: 0, h: 0, fill: type === 'line' || type === 'arrow' || type === 'pen' ? 'none' : fill,
      stroke, strokeWidth, text: type === 'text' ? 'Text' : '', fontSize: 32, points: type === 'pen' ? [[0, 0]] : [], d: '' };
  }
  function pointerDown(event) {
    if (event.button !== 0) return;
    const p = point(event);
    if (tool === 'select') {
      const target = event.target.closest('[data-shape-id]');
      selected = target?.dataset.shapeId || null;
      if (selected) { checkpoint(); const shape = current(); drag = { mode: 'move', start: p, x: shape.x, y: shape.y }; canvas.setPointerCapture(event.pointerId); }
      render(); return;
    }
    checkpoint();
    const shape = makeShape(tool, p); data.shapes.push(shape); selected = shape.id;
    if (tool === 'text') { shape.w = 150; shape.h = 40; tool = 'select'; render(); $('shape-text').focus(); $('shape-text').select(); mark(); return; }
    drag = { mode: 'draw', start: p, id: shape.id };
    canvas.setPointerCapture(event.pointerId); render(); mark();
  }
  function pointerMove(event) {
    if (!drag) return;
    const p = point(event), shape = current(); if (!shape) return;
    if (drag.mode === 'move') { shape.x = drag.x + p.x - drag.start.x; shape.y = drag.y + p.y - drag.start.y; }
    else if (shape.type === 'pen') {
      const local = [p.x - shape.x, p.y - shape.y], last = shape.points[shape.points.length - 1];
      if (Math.hypot(local[0] - last[0], local[1] - last[1]) >= 3) shape.points.push(local);
    } else {
      shape.w = p.x - drag.start.x; shape.h = p.y - drag.start.y;
      if (event.shiftKey && shape.type !== 'line') { const size = Math.max(Math.abs(shape.w), Math.abs(shape.h)); shape.w = Math.sign(shape.w || 1) * size; shape.h = Math.sign(shape.h || 1) * size; }
    }
    renderCanvas(); mark();
  }
  function pointerUp(event) {
    if (!drag) return;
    const shape = current();
    if (shape && drag.mode === 'draw' && shape.type !== 'pen' && Math.abs(shape.w) < 4 && Math.abs(shape.h) < 4) {
      shape.w = ['line', 'arrow'].includes(shape.type) ? 140 : 160; shape.h = ['line', 'arrow'].includes(shape.type) ? 0 : 100;
    }
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    render(); mark();
  }
  function remove() { if (!selected) return; checkpoint(); data.shapes = data.shapes.filter(s => s.id !== selected); selected = null; render(); mark(); }
  function undoAction() { if (!undo.length) return; redo.push(JSON.stringify(data)); data = JSON.parse(undo.pop()); selected = null; render(); mark(); }
  function redoAction() { if (!redo.length) return; undo.push(JSON.stringify(data)); data = JSON.parse(redo.pop()); selected = null; render(); mark(); }
  function init(onChange) {
    changed = onChange;
    document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => { tool = b.dataset.tool; updateTool(); renderCanvas(); }));
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('dblclick', event => {
      const id = event.target.closest('[data-shape-id]')?.dataset.shapeId;
      const shape = data.shapes.find(s => s.id === id);
      if (shape?.type === 'text') { selected = id; renderInspector(); $('shape-text').focus(); $('shape-text').select(); }
    });
    for (const [field, key] of [['show-grid', 'grid'], ['snap-grid', 'snap']]) $(field).addEventListener('change', event => { checkpoint(); data[key] = event.target.checked; renderCanvas(); mark(); });
    for (const [field, key] of [['page-width', 'width'], ['page-height', 'height']]) $(field).addEventListener('change', event => {
      const value = Math.max(100, Math.min(4000, Number(event.target.value) || data[key])); checkpoint(); data[key] = value; render(); mark();
    });
    for (const [field, key] of [['shape-fill', 'fill'], ['shape-stroke', 'stroke'], ['stroke-width', 'strokeWidth'], ['shape-text', 'text']]) {
      $(field).addEventListener('focus', () => { if (current()) checkpoint(); });
      $(field).addEventListener('input', event => {
        const value = key === 'strokeWidth' ? Math.max(0, Math.min(30, Number(event.target.value) || 0)) : event.target.value;
        if (key === 'fill') fill = value; if (key === 'stroke') stroke = value; if (key === 'strokeWidth') strokeWidth = value;
        if (current()) { current()[key] = value; renderCanvas(); mark(); if (key === 'text') renderInspector(); }
      });
    }
    $('bring-forward').addEventListener('click', () => { const i = data.shapes.findIndex(s => s.id === selected); if (i < 0 || i === data.shapes.length - 1) return; checkpoint(); [data.shapes[i], data.shapes[i + 1]] = [data.shapes[i + 1], data.shapes[i]]; render(); mark(); });
    $('send-backward').addEventListener('click', () => { const i = data.shapes.findIndex(s => s.id === selected); if (i <= 0) return; checkpoint(); [data.shapes[i], data.shapes[i - 1]] = [data.shapes[i - 1], data.shapes[i]]; render(); mark(); });
    $('insert-image').addEventListener('click', () => $('image-input').click());
    $('image-input').addEventListener('change', event => {
      const file = event.target.files[0]; event.target.value = '';
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { alert('Choose a PNG, JPEG, WebP, or GIF under 10 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        checkpoint(); const shape = makeShape('image', { x: 100, y: 100 });
        shape.w = Math.min(500, data.width - 200); shape.h = Math.min(350, data.height - 200);
        shape.src = reader.result; data.shapes.push(shape); selected = shape.id; tool = 'select'; render(); mark();
      };
      reader.onerror = () => alert('Could not open image.');
      reader.readAsDataURL(file);
    });
    $('delete-shape').addEventListener('click', remove); $('undo-btn').addEventListener('click', undoAction); $('redo-btn').addEventListener('click', redoAction);
    window.addEventListener('keydown', event => {
      if (event.target.matches('input,textarea,[contenteditable]')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoAction(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoAction(); }
    });
  }
  function importFile(name, content) {
    if (/\.json$/i.test(name)) { const source = JSON.parse(content); load(source.content || source); }
    else if (/\.svg$/i.test(name)) load(M.fromSvg(content));
    else if (/\.odg$/i.test(name)) {
      if (content.trimStart().startsWith('{')) load(JSON.parse(content).document);
      else if (new DOMParser().parseFromString(content, 'application/xml').documentElement.localName === 'svg') load(M.fromSvg(content));
      else load(M.fromOdg(content));
    }
    else throw new Error('Open an SVG, ODG, or XGraph JSON file');
    return { title: name.replace(/\.[^.]+$/, '') };
  }
  function toPng(svg, width, height) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); const image = new Image();
      image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(image, 0, 0); URL.revokeObjectURL(url); canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG could not be rasterized')); }; image.src = url;
    });
  }
  async function exportFile(format, title) {
    if (format === 'odg') {
      const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, format, content: JSON.stringify({ document: data, svg: M.svg(data) }) }) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'ODG export failed'); }
      return { data: await response.blob(), mime: 'application/vnd.oasis.opendocument.graphics', filename: `${title}.odg` };
    }
    if (format === 'svg') return { data: M.svg(data), mime: 'image/svg+xml', filename: `${title}.svg` };
    if (format === 'png') return { data: await toPng(M.svg(data), data.width, data.height), mime: 'image/png', filename: `${title}.png` };
    if (format === 'json') return { data: JSON.stringify(data, null, 2), mime: 'application/json', filename: `${title}.json` };
    throw new Error('Unsupported drawing export');
  }
  window.XEditor = { init, blank, load, snapshot: () => structuredClone(data), importFile, export: exportFile };
})();
