// Geometry helpers. All distances in nautical miles.
// Hazard polygons are compared against an "area shape": a set of points
// (single airports) or a polyline (route), plus a radius / corridor half-width.

const R_NM = 3440.065;
const toRad = (d) => (d * Math.PI) / 180;

function distNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Local flat projection (fine for regional distances).
function makeProjector(lat0, lon0) {
  const k = 60 * Math.cos(toRad(lat0));
  return (p) => ({ x: (p.lon - lon0) * k, y: (p.lat - lat0) * 60 });
}

function ptSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o3 !== 0;
}

function segSegDist(a, b, c, d) {
  if (segsIntersect(a, b, c, d)) return 0;
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// GeoJSON coords are [lon, lat]. Guard against swapped axis order.
function toLL(c) {
  let lon = Number(c[0]), lat = Number(c[1]);
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lon, lat] = [lat, lon];
  return { lat, lon };
}

// Normalise a GeoJSON geometry into { rings: [[ll..]], lines: [[ll..]], points: [ll] }
function explode(geom) {
  const out = { rings: [], lines: [], points: [] };
  if (!geom) return out;
  if (geom.type !== 'GeometryCollection' && !geom.coordinates) return out;
  const c = geom.coordinates;
  switch (geom.type) {
    case 'Point': out.points.push(toLL(c)); break;
    case 'MultiPoint': c.forEach((p) => out.points.push(toLL(p))); break;
    case 'LineString': out.lines.push(c.map(toLL)); break;
    case 'MultiLineString': c.forEach((l) => out.lines.push(l.map(toLL))); break;
    case 'Polygon': c.forEach((r) => out.rings.push(r.map(toLL))); break;
    case 'MultiPolygon': c.forEach((poly) => poly.forEach((r) => out.rings.push(r.map(toLL)))); break;
    case 'GeometryCollection':
      (geom.geometries || []).forEach((g) => {
        const e = explode(g);
        out.rings.push(...e.rings); out.lines.push(...e.lines); out.points.push(...e.points);
      });
      break;
  }
  return out;
}

// shape: { points: [{lat,lon}], route: bool }
function shapeSegments(shape, proj) {
  const pts = shape.points.map(proj);
  if (shape.route && pts.length > 1) {
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
    return segs;
  }
  return pts.map((p) => [p, p]);
}

function shapeCenter(shape) {
  const n = shape.points.length;
  return {
    lat: shape.points.reduce((s, p) => s + p.lat, 0) / n,
    lon: shape.points.reduce((s, p) => s + p.lon, 0) / n,
  };
}

// Projection and segments depend only on the shape, so work them out once per shape object.
// (A brief measures hundreds of stations and hazards against the same shape.)
const prepared = new WeakMap();
function prepare(shape) {
  let p = prepared.get(shape);
  if (!p) {
    const c = shapeCenter(shape);
    const proj = makeProjector(c.lat, c.lon);
    p = { proj, segs: shapeSegments(shape, proj) };
    prepared.set(shape, p);
  }
  return p;
}

// Minimum distance (nm) from the area shape to a point.
function shapeDistToPoint(shape, ll) {
  const { proj, segs } = prepare(shape);
  const p = proj(ll);
  let best = Infinity;
  for (const [a, b] of segs) best = Math.min(best, ptSegDist(p, a, b));
  return best;
}

// Minimum distance (nm) from the area shape to any GeoJSON geometry. 0 = overlaps.
function shapeDistToGeometry(shape, geom) {
  const g = explode(geom);
  const { proj, segs } = prepare(shape);
  let best = Infinity;

  for (const ringLL of g.rings) {
    const ring = ringLL.map(proj);
    for (const [a, b] of segs) {
      if (pointInRing(a, ring) || pointInRing(b, ring)) return 0;
    }
    for (let i = 0; i < ring.length - 1; i++) {
      for (const [a, b] of segs) best = Math.min(best, segSegDist(a, b, ring[i], ring[i + 1]));
    }
  }
  for (const lineLL of g.lines) {
    const line = lineLL.map(proj);
    for (let i = 0; i < line.length - 1; i++) {
      for (const [a, b] of segs) best = Math.min(best, segSegDist(a, b, line[i], line[i + 1]));
    }
    if (line.length === 1) for (const [a, b] of segs) best = Math.min(best, ptSegDist(line[0], a, b));
  }
  for (const ptLL of g.points) {
    const p = proj(ptLL);
    for (const [a, b] of segs) best = Math.min(best, ptSegDist(p, a, b));
  }
  return best;
}

// Bounding box around the shape, padded by radius nm.
function shapeBbox(shape, radiusNm) {
  const lats = shape.points.map((p) => p.lat);
  const lons = shape.points.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = radiusNm / 60;
  const dLon = radiusNm / (60 * Math.max(0.2, Math.cos(toRad(midLat))));
  const r = (n) => Math.round(n * 100) / 100;
  return {
    minLat: r(Math.min(...lats) - dLat),
    minLon: r(Math.min(...lons) - dLon),
    maxLat: r(Math.max(...lats) + dLat),
    maxLon: r(Math.max(...lons) + dLon),
  };
}

module.exports = { distNm, shapeDistToPoint, shapeDistToGeometry, shapeBbox, shapeCenter, explode };
