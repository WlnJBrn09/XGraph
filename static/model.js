(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GraphModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(-10000, Math.min(10000, Number(value))) : fallback;
  const color = (value, fallback) => /^(none|transparent|#[0-9a-fA-F]{3,8}|(?:rgb|rgba)\([\d.,%\s]+\)|[a-zA-Z]{1,20})$/.test(String(value || '')) ? String(value) : fallback;
  const id = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  function blank() { return { width: 1200, height: 800, grid: false, snap: false, shapes: [] }; }
  function normalize(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid drawing document');
    const width = Math.max(100, Math.min(4000, number(source.width, 1200)));
    const height = Math.max(100, Math.min(4000, number(source.height, 800)));
    const shapes = Array.isArray(source.shapes) ? source.shapes.slice(0, 2000).map(raw => {
      if (!raw || typeof raw !== 'object') return null;
      const type = ['rect', 'ellipse', 'line', 'arrow', 'text', 'pen', 'path', 'image'].includes(raw.type) ? raw.type : null;
      if (!type) return null;
      const points = Array.isArray(raw.points) ? raw.points.slice(0, 2000).map(p => [number(p?.[0]), number(p?.[1])]) : [];
      const d = typeof raw.d === 'string' && /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\sEe]*$/.test(raw.d) ? raw.d.slice(0, 100000) : '';
      return { id: String(raw.id || id()).slice(0, 80), type, x: number(raw.x), y: number(raw.y), w: number(raw.w, 100), h: number(raw.h, 70),
        fill: color(raw.fill, type === 'line' || type === 'arrow' || type === 'pen' || type === 'path' ? 'none' : '#b8c0cb'),
        stroke: color(raw.stroke, '#24272d'), strokeWidth: Math.max(0, Math.min(30, number(raw.strokeWidth, 2))),
        text: String(raw.text ?? '').slice(0, 2000), fontSize: Math.max(8, Math.min(200, number(raw.fontSize, 32))), points, d,
        src: typeof raw.src === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw.src) && raw.src.length < 16_000_000 ? raw.src : '' };
    }).filter(Boolean) : [];
    return { width, height, grid: !!source.grid, snap: !!source.snap, shapes };
  }
  const fmt = n => Number(n.toFixed(2));
  function shapeSvg(shape, interactive = false) {
    const a = interactive ? ` data-shape-id="${esc(shape.id)}"` : '';
    const style = ` fill="${esc(shape.fill)}" stroke="${esc(shape.stroke)}" stroke-width="${fmt(shape.strokeWidth)}"`;
    const x = fmt(shape.x), y = fmt(shape.y), w = fmt(shape.w), h = fmt(shape.h);
    if (shape.type === 'rect') return `<rect${a} x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}"${style}/>`;
    if (shape.type === 'ellipse') return `<ellipse${a} cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}"${style}/>`;
    if (shape.type === 'line' || shape.type === 'arrow') {
      const line = `<line x1="${x}" y1="${y}" x2="${fmt(x + w)}" y2="${fmt(y + h)}"${style}/>`;
      if (shape.type === 'line') return `<g${a}>${line}</g>`;
      const angle = Math.atan2(h, w), length = 16 + shape.strokeWidth * 2;
      const ax = x + w, ay = y + h;
      const leftX = fmt(ax - Math.cos(angle - .48) * length), leftY = fmt(ay - Math.sin(angle - .48) * length);
      const rightX = fmt(ax - Math.cos(angle + .48) * length), rightY = fmt(ay - Math.sin(angle + .48) * length);
      return `<g${a}>${line}<path d="M ${leftX} ${leftY} L ${fmt(ax)} ${fmt(ay)} L ${rightX} ${rightY}" fill="none" stroke="${esc(shape.stroke)}" stroke-width="${fmt(shape.strokeWidth)}" stroke-linejoin="round"/></g>`;
    }
    if (shape.type === 'text') return `<text${a} x="${x}" y="${y}" fill="${esc(shape.fill === 'none' ? shape.stroke : shape.fill)}" stroke="none" font-family="Arial,sans-serif" font-size="${fmt(shape.fontSize)}" xml:space="preserve">${esc(shape.text)}</text>`;
    if (shape.type === 'pen') return `<polyline${a} transform="translate(${x} ${y})" points="${shape.points.map(p => `${fmt(p[0])},${fmt(p[1])}`).join(' ')}"${style} stroke-linecap="round" stroke-linejoin="round"/>`;
    if (shape.type === 'path') return `<path${a} transform="translate(${x} ${y})" d="${esc(shape.d)}"${style}/>`;
    if (shape.type === 'image' && shape.src) return `<image${a} x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" href="${esc(shape.src)}" preserveAspectRatio="xMidYMid meet"/>`;
    return '';
  }
  function body(source, interactive = false) {
    const d = normalize(source);
    const page = `<rect width="${d.width}" height="${d.height}" fill="#ffffff"/>`;
    const grid = interactive && d.grid ? `<defs><pattern id="xgraph-grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="#e7e7e9" stroke-width="0.6"/></pattern></defs><rect width="${d.width}" height="${d.height}" fill="url(#xgraph-grid)"/>` : '';
    return page + grid + d.shapes.map(s => shapeSvg(s, interactive)).join('');
  }
  function svg(source) {
    const d = normalize(source);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}">${body(d)}</svg>`;
  }
  function fromSvg(text) {
    if (typeof DOMParser === 'undefined') throw new Error('SVG import requires a browser');
    const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (xml.querySelector('parsererror')) throw new Error('Invalid SVG file');
    const root = xml.documentElement;
    if (root.localName !== 'svg') throw new Error('File is not SVG');
    const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const width = viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : parseFloat(root.getAttribute('width')) || 1200;
    const height = viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : parseFloat(root.getAttribute('height')) || 800;
    const shapes = [];
    const skip = new Set();
    const attr = (el, key, fallback = 0) => parseFloat(el.getAttribute(key)) || fallback;
    const translation = (el) => {
      const match = /^translate\(\s*([-+]?\d*\.?\d+)\s*[, ]\s*([-+]?\d*\.?\d+)\s*\)$/.exec(el.getAttribute('transform') || '');
      return match ? [Number(match[1]), Number(match[2])] : [0, 0];
    };
    const supported = new Set(['rect','ellipse','circle','line','text','polyline','polygon','path','image']);
    for (const el of root.querySelectorAll('*')) {
      if (!supported.has(el.localName) || el.closest('defs,clipPath,mask,pattern,symbol') || skip.has(el)) continue;
      if (shapes.length >= 2000) break;
      const tag = el.localName;
      const base = { id: id(), fill: el.getAttribute('fill') || '#b8c0cb', stroke: el.getAttribute('stroke') || '#24272d', strokeWidth: attr(el, 'stroke-width', 2) };
      if (tag === 'rect' && el.parentElement === root && el.getAttribute('width') === String(width) && el.getAttribute('height') === String(height) && (el.getAttribute('fill') || '').toLowerCase() === '#ffffff') continue;
      if (tag === 'rect') shapes.push({ ...base, type: 'rect', x: attr(el, 'x'), y: attr(el, 'y'), w: attr(el, 'width', 100), h: attr(el, 'height', 70) });
      if (tag === 'ellipse') shapes.push({ ...base, type: 'ellipse', x: attr(el, 'cx') - attr(el, 'rx', 40), y: attr(el, 'cy') - attr(el, 'ry', 40), w: attr(el, 'rx', 40) * 2, h: attr(el, 'ry', 40) * 2 });
      if (tag === 'circle') shapes.push({ ...base, type: 'ellipse', x: attr(el, 'cx') - attr(el, 'r', 40), y: attr(el, 'cy') - attr(el, 'r', 40), w: attr(el, 'r', 40) * 2, h: attr(el, 'r', 40) * 2 });
      if (tag === 'line') {
        const arrowhead = el.parentElement?.localName === 'g' ? el.parentElement.querySelector(':scope > path[fill="none"]') : null;
        if (arrowhead) skip.add(arrowhead);
        shapes.push({ ...base, type: arrowhead ? 'arrow' : 'line', x: attr(el, 'x1'), y: attr(el, 'y1'), w: attr(el, 'x2') - attr(el, 'x1'), h: attr(el, 'y2') - attr(el, 'y1'), fill: 'none' });
      }
      if (tag === 'text') shapes.push({ ...base, type: 'text', x: attr(el, 'x'), y: attr(el, 'y'), text: el.textContent || '', fontSize: attr(el, 'font-size', 32) });
      if (tag === 'polyline' || tag === 'polygon') {
        const values = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        const points = []; for (let i = 0; i + 1 < values.length; i += 2) if (Number.isFinite(values[i]) && Number.isFinite(values[i + 1])) points.push([values[i], values[i + 1]]);
        if (points.length) { const [x, y] = translation(el); shapes.push({ ...base, type: 'pen', x, y, points, fill: 'none' }); }
      }
      if (tag === 'path') { const [x, y] = translation(el); shapes.push({ ...base, type: 'path', x, y, d: el.getAttribute('d') || '', fill: el.getAttribute('fill') || 'none' }); }
      if (tag === 'image') {
        const src = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src))
          shapes.push({ ...base, type: 'image', x: attr(el, 'x'), y: attr(el, 'y'), w: attr(el, 'width', 100), h: attr(el, 'height', 100), src });
      }
    }
    return normalize({ width, height, shapes });
  }
  function fromOdg(text) {
    if (typeof DOMParser === 'undefined') throw new Error('ODG import requires a browser');
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'document-content') throw new Error('Invalid ODG drawing XML');
    const draw = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
    const svgNs = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
    const styleNs = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
    const foNs = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
    const px = value => {
      const match = /^\s*([-+]?\d*\.?\d+)\s*(cm|mm|in|pt|pc|px)?\s*$/i.exec(value || '');
      if (!match) return 0;
      return Number(match[1]) * ({ cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 }[match[2]?.toLowerCase() || 'px']);
    };
    const page = xml.getElementsByTagNameNS(draw, 'page')[0];
    if (!page) throw new Error('ODG drawing has no page');
    const styles = new Map();
    for (const item of xml.getElementsByTagNameNS(styleNs, 'style')) {
      const key = item.getAttributeNS(styleNs, 'name');
      const props = item.getElementsByTagNameNS(styleNs, 'graphic-properties')[0];
      if (key && props) styles.set(key, props);
    }
    const shapes = [];
    for (const el of page.children) {
      if (el.namespaceURI !== draw) continue;
      const type = el.localName;
      if (!['rect', 'ellipse', 'circle', 'line', 'connector'].includes(type)) throw new Error(`ODG shape “${type}” is not supported yet`);
      const props = styles.get(el.getAttributeNS(draw, 'style-name'));
      const fill = props?.getAttributeNS(draw, 'fill') === 'none' ? 'none' : props?.getAttributeNS(draw, 'fill-color') || '#b8c0cb';
      const stroke = props?.getAttributeNS(draw, 'stroke') === 'none' ? 'none' : props?.getAttributeNS(svgNs, 'stroke-color') || '#24272d';
      const strokeWidth = px(props?.getAttributeNS(svgNs, 'stroke-width')) || 2;
      const base = { id: id(), fill, stroke, strokeWidth };
      const attr = key => px(el.getAttributeNS(svgNs, key));
      if (type === 'line' || type === 'connector') shapes.push({ ...base, type: 'line', x: attr('x1'), y: attr('y1'), w: attr('x2') - attr('x1'), h: attr('y2') - attr('y1'), fill: 'none' });
      else shapes.push({ ...base, type: type === 'rect' ? 'rect' : 'ellipse', x: attr('x'), y: attr('y'), w: attr('width'), h: attr('height') });
      const text = Array.from(el.getElementsByTagName('*')).filter(node => node.localName === 'p').map(node => node.textContent.trim()).filter(Boolean).join('\n');
      if (text) shapes.push({ id: id(), type: 'text', x: attr('x') + 8, y: attr('y') + 36, text, fontSize: px(props?.getAttributeNS(foNs, 'font-size')) || 28, fill: stroke === 'none' ? '#24272d' : stroke });
    }
    const width = Math.max(1200, ...shapes.map(s => s.x + (s.w || 0) + 40));
    const height = Math.max(800, ...shapes.map(s => s.y + (s.h || 0) + 40));
    return normalize({ width, height, shapes });
  }
  return { blank, normalize, body, svg, fromSvg, fromOdg, id };
});
