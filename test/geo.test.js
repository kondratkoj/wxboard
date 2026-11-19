const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../lib/geo');

const DFW = { lat: 32.8968, lon: -97.038 };
const AUS = { lat: 30.1945, lon: -97.6699 };

test('distNm DFW-AUS is about 165 nm', () => {
  const d = geo.distNm(DFW, AUS);
  assert.ok(d > 160 && d < 170, String(d));
});

test('shapeDistToPoint: circle mode is distance to the nearest airport', () => {
  const shape = { points: [DFW, AUS], route: false };
  assert.ok(geo.shapeDistToPoint(shape, DFW) < 0.01);
  // Midpoint is ~80 nm from both airports in circle mode...
  const mid = { lat: (DFW.lat + AUS.lat) / 2, lon: (DFW.lon + AUS.lon) / 2 };
  assert.ok(geo.shapeDistToPoint(shape, mid) > 75);
  // ...but on the corridor in route mode.
  assert.ok(geo.shapeDistToPoint({ points: [DFW, AUS], route: true }, mid) < 1);
});

test('shapeDistToGeometry: 0 inside a polygon, positive outside', () => {
  const shape = { points: [DFW], route: false };
  const box = (lat, lon, h) => ({ type: 'Polygon', coordinates: [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]] });
  assert.equal(geo.shapeDistToGeometry(shape, box(DFW.lat, DFW.lon, 0.5)), 0);
  const far = geo.shapeDistToGeometry(shape, box(DFW.lat + 3, DFW.lon, 0.5));
  assert.ok(far > 140 && far < 160, String(far)); // 2.5 degrees of latitude = 150 nm
});

test('shapeDistToGeometry handles points, lines and collections', () => {
  const shape = { points: [DFW], route: false };
  const pt = { type: 'Point', coordinates: [DFW.lon, DFW.lat + 1] };
  assert.ok(Math.abs(geo.shapeDistToGeometry(shape, pt) - 60) < 0.5);
  const coll = { type: 'GeometryCollection', geometries: [pt, { type: 'LineString', coordinates: [[DFW.lon - 1, DFW.lat], [DFW.lon + 1, DFW.lat]] }] };
  assert.ok(geo.shapeDistToGeometry(shape, coll) < 0.01);
  assert.equal(geo.shapeDistToGeometry(shape, null), Infinity);
});

test('shapeBbox pads by the radius', () => {
  const b = geo.shapeBbox({ points: [DFW] }, 60);
  assert.ok(Math.abs(b.maxLat - (DFW.lat + 1)) < 0.01);
  assert.ok(b.minLon < DFW.lon - 1); // longitude degrees are shorter than 60 nm at this latitude
});
