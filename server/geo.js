'use strict';

/*
 * Server-side geospatial primitives.
 *
 * Coordinates are explicit at every boundary:
 *   - GPS input: WGS-84 [lat, lng]
 *   - map/course storage: GCJ-02 [lng, lat]
 *
 * The server recomputes the GCJ-02 display coordinate from the raw GPS
 * coordinate.  Client supplied display coordinates are never authoritative.
 */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;
const R = 6378137;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function wgs2gcj(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

function gcj2wgs(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (outOfChina(lat, lng)) return [lat, lng];
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 12; i++) {
    const g = wgs2gcj(wLat, wLng);
    const dLat = g[0] - lat;
    const dLng = g[1] - lng;
    wLat -= dLat; wLng -= dLng;
    if (Math.abs(dLat) < 1e-10 && Math.abs(dLng) < 1e-10) break;
  }
  return [wLat, wLng];
}

function haversine(a, b) {
  const rad = PI / 180;
  const dLat = (Number(b[0]) - Number(a[0])) * rad;
  const dLng = (Number(b[1]) - Number(a[1])) * rad;
  const mLat = ((Number(a[0]) + Number(b[0])) / 2) * rad;
  const x = dLng * Math.cos(mLat);
  return Math.sqrt(x * x + dLat * dLat) * R;
}

function distanceLngLat(a, b) {
  return haversine([a[1], a[0]], [b[1], b[0]]);
}

/* Point and path coordinates are [lng, lat]. */
function distToSegment(point, a, b) {
  const rad = PI / 180;
  const lat = Number(point[1]);
  const kx = Math.cos(lat * rad) * 111320;
  const ky = 110540;
  const px = Number(point[0]) * kx;
  const py = Number(point[1]) * ky;
  const ax = Number(a[0]) * kx;
  const ay = Number(a[1]) * ky;
  const bx = Number(b[0]) * kx;
  const by = Number(b[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPath(point, path) {
  if (!Array.isArray(path) || path.length < 2) return { dist: Infinity, segIndex: -1 };
  let best = { dist: Infinity, segIndex: -1 };
  for (let i = 1; i < path.length; i++) {
    const d = distToSegment(point, path[i - 1], path[i]);
    if (d < best.dist) best = { dist: d, segIndex: i - 1 };
  }
  return best;
}

function pathLength(path) {
  if (!Array.isArray(path)) return 0;
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += distanceLngLat(path[i - 1], path[i]);
  return sum;
}

module.exports = {
  wgs2gcj,
  gcj2wgs,
  haversine,
  distanceLngLat,
  distToSegment,
  distToPath,
  pathLength,
  outOfChina
};
