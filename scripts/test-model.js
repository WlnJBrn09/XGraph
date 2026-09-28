'use strict';
const assert = require('node:assert/strict');
const M = require('../static/model.js');
const doc = M.normalize({ width: 800, height: 600, shapes: [
  { type: 'rect', x: 10, y: 20, w: 100, h: 50, fill: 'url(javascript:alert(1))', text: '<script>' },
  { type: 'text', x: 50, y: 70, text: '<script>alert(1)</script>', fill: '#222222' },
  { type: 'path', d: 'M 1 2 L 3 4', x: 0, y: 0 },
] });
assert.equal(doc.shapes.length, 3);
assert.equal(doc.shapes[0].fill, '#b8c0cb');
const svg = M.svg(doc);
assert.match(svg, /viewBox="0 0 800 600"/);
assert.ok(svg.includes('&lt;script&gt;'));
assert.ok(!svg.includes('<script>'));
assert.match(svg, /<path/);
const arrow = M.normalize({ width: 500, height: 300, grid: true, shapes: [{ type: 'arrow', x: 10, y: 20, w: 100, h: 30 }] });
assert.match(M.svg(arrow), /<line/);
assert.match(M.svg(arrow), /<path/);
assert.match(M.body(arrow, true), /xgraph-grid/);
assert.ok(!M.svg(arrow).includes('xgraph-grid'));
assert.throws(() => M.normalize(null), /Invalid/);
console.log('XGraph model checks passed');
