'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const geo = require('./geo');
const { normalizeRules, rulesForEvent, groupConfig } = require('./rules');

function now() { return Date.now(); }

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function validLngLat(p) {
  return Array.isArray(p) && p.length === 2 &&
    Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])) &&
    Number(p[0]) > 70 && Number(p[0]) < 140 &&
    Number(p[1]) > 3 && Number(p[1]) < 55;
}

function validWgs(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
    Number(lng) > 70 && Number(lng) < 140 && Number(lat) > 3 && Number(lat) < 55;
}

function distanceM(a, b) {
  return geo.distanceLngLat(a, b);
}

function pathDistance(points) {
  return geo.pathLength(points);
}

function routeIdentity(routeKey, groupKey) {
  return { routeKey: String(routeKey || 'default'), groupKey: groupKey ? String(groupKey) : null };
}

/* Select the most specific active route for a participant. */
function selectCourse(eventId, groupKey, routeKey, courseId) {
  if (courseId) return db.get('SELECT * FROM courses WHERE id=? AND event_id=?', [courseId, eventId]);
  const identity = routeIdentity(routeKey, null);
  const rows = db.all(
    `SELECT * FROM courses
       WHERE event_id=? AND is_active=1
       ORDER BY version DESC`, [eventId]
  );
  const exactKey = routeKey || null;
  let best = null;
  let score = -1;
  rows.forEach((row) => {
    const sameRoute = exactKey ? (row.route_key || 'default') === exactKey : true;
    if (!sameRoute) return;
    const sameGroup = row.group_key && groupKey && row.group_key === groupKey;
    const generic = !row.group_key;
    let s = generic ? 1 : 0;
    if (sameGroup) s = 3;
    else if (row.group_key && row.group_key !== groupKey) return;
    if (exactKey && (row.route_key || 'default') === exactKey) s += 2;
    if (s > score) { score = s; best = row; }
  });
  if (best) return best;
  // If a group-specific route was not found, fall back to the event default.
  const e = db.get('SELECT default_route_key FROM events WHERE id=?', [eventId]);
  const fallbackKey = (e && e.default_route_key) || 'default';
  return db.get(
    `SELECT * FROM courses WHERE event_id=? AND is_active=1
       AND (route_key=? OR route_key IS NULL)
       AND (group_key=? OR group_key IS NULL)
       ORDER BY CASE WHEN group_key=? THEN 0 ELSE 1 END, version DESC LIMIT 1`,
    [eventId, fallbackKey, groupKey || '', groupKey || '']
  );
}

function courseCheckpoints(courseId) {
  return db.all('SELECT * FROM checkpoints WHERE course_id=? ORDER BY order_index ASC, id ASC', [courseId]);
}

function parseCoursePoints(course) {
  const points = parseJson(course && course.points_json, []);
  return Array.isArray(points) ? points.filter(validLngLat).map((p) => [Number(p[0]), Number(p[1])]) : [];
}

function coursePublic(course, event, checkpoints) {
  if (!course) return null;
  return {
    version: 1,
    eventId: event ? event.code : null,
    name: course.name || (event && event.name) || '',
    updatedAt: course.updated_at || course.created_at,
    updatedBy: course.created_by ? 'admin' : '',
    campus: {
      name: event && event.campus_name,
      center: event ? [event.campus_lng, event.campus_lat] : null,
      zoom: event ? event.campus_zoom : 16
    },
    route: {
      points: parseCoursePoints(course),
      start: course.start_lng != null ? [course.start_lng, course.start_lat] : null,
      finish: course.finish_lng != null ? [course.finish_lng, course.finish_lat] : null,
      closed: !!course.closed,
      startRadius: course.start_radius_m || null,
      finishRadius: course.finish_radius_m || null,
      routeKey: course.route_key || 'default',
      groupKey: course.group_key || null
    },
    checkpoints: (checkpoints || []).map((cp) => ({
      id: cp.code,
      name: cp.name,
      order: cp.order_index,
      lnglat: [cp.lng, cp.lat],
      radius: cp.radius_m,
      required: !!cp.required,
      rewardPoints: cp.reward_points || 0,
      methods: cp.methods_json ? parseJson(cp.methods_json, ['gps']) : ['gps']
    })),
    meta: {
      distance: course.distance_m || 0,
      source: course.source || 'manual',
      routeKey: course.route_key || 'default',
      groupKey: course.group_key || null
    },
    crs: course.crs || 'gcj02',
    status: course.status || 'draft',
    surveyedAt: course.surveyed_at || 0,
    publishedAt: course.published_at || 0,
    lockedAt: course.locked_at || 0,
    locked: !!course.locked_at,
    _server: { courseId: course.id, version: course.version, createdAt: course.created_at }
  };
}

function validateCourse(course) {
  const errors = [];
  if (!course || typeof course !== 'object') return ['数据为空'];
  if (course.crs && String(course.crs).toLowerCase() !== 'gcj02') {
    errors.push('路线坐标必须明确使用 GCJ-02；请先转换后再保存');
  }
  const r = course.route || {};
  if (!Array.isArray(r.points) || r.points.length < 2) errors.push('比赛路线至少需要 2 个途经点');
  else r.points.forEach((p, i) => { if (!validLngLat(p)) errors.push(`第 ${i + 1} 个途经点坐标无效`); });
  if (!validLngLat(r.start)) errors.push('未设置起点');
  if (!validLngLat(r.finish)) errors.push('未设置终点');
  const cps = Array.isArray(course.checkpoints) ? course.checkpoints : [];
  if (cps.length > 100) errors.push('打卡点最多 100 个');
  const ids = new Set();
  const orders = new Set();
  cps.forEach((cp, i) => {
    const code = String(cp.id || `CP${i + 1}`).trim();
    if (!/^[-A-Za-z0-9_]{1,32}$/.test(code)) errors.push(`第 ${i + 1} 个打卡点编号无效`);
    if (ids.has(code)) errors.push(`打卡点编号重复：${code}`); ids.add(code);
    const order = Number(cp.order || i + 1);
    if (!Number.isInteger(order) || order < 1 || order > 999) errors.push(`第 ${i + 1} 个打卡点顺序无效`);
    if (orders.has(order)) errors.push(`打卡点顺序重复：${order}`); orders.add(order);
    if (!cp.name || String(cp.name).trim().length < 1) errors.push(`第 ${i + 1} 个打卡点缺少名称`);
    if (!validLngLat(cp.lnglat)) errors.push(`第 ${i + 1} 个打卡点坐标无效`);
    const radius = Number(cp.radius);
    if (!Number.isFinite(radius) || radius < 5 || radius > 500) errors.push(`第 ${i + 1} 个打卡半径应在 5–500 米之间`);
    if (cp.rewardPoints != null && (!Number.isFinite(Number(cp.rewardPoints)) || Number(cp.rewardPoints) < 0 || Number(cp.rewardPoints) > 1000)) {
      errors.push(`第 ${i + 1} 个奖励积分无效`);
    }
  });
  const routeKey = String((course.route && course.route.routeKey) || course.routeKey || 'default');
  if (!/^[-A-Za-z0-9_]{1,64}$/.test(routeKey)) errors.push('路线键无效');
  if (course.groupKey != null && !/^[-A-Za-z0-9_]{1,64}$/.test(String(course.groupKey))) errors.push('组别路线键无效');
  return errors;
}

/* Normalize one client point. Client display coordinates are only a hint. */
function normalizePoint(input, options = {}) {
  const pt = input && typeof input === 'object' ? input : {};
  const flags = [];
  const crs = String(pt.crs || (pt.rawLat != null || pt.rawLng != null ? 'wgs84' : 'gcj02')).toLowerCase();
  let rawLat = Number(pt.rawLat);
  let rawLng = Number(pt.rawLng);
  let lng;
  let lat;
  let coordinateVerified = 0;

  if (validWgs(rawLat, rawLng)) {
    const converted = geo.wgs2gcj(rawLat, rawLng);
    lat = converted[0]; lng = converted[1];
    coordinateVerified = 1;
    if (validLngLat([pt.lng, pt.lat])) {
      const mismatch = distanceM([lng, lat], [Number(pt.lng), Number(pt.lat)]);
      if (mismatch > 120) flags.push('coordinate_mismatch');
    }
  } else if (crs === 'gcj02' && validLngLat([pt.lng, pt.lat])) {
    lng = Number(pt.lng); lat = Number(pt.lat);
    const raw = geo.gcj2wgs(lat, lng);
    rawLat = raw[0]; rawLng = raw[1];
    flags.push('legacy_display_coordinate');
  } else {
    return { ok: false, flags: ['invalid_coordinate'], error: '缺少有效的 WGS84 原始坐标' };
  }

  if (!validLngLat([lng, lat])) return { ok: false, flags: ['invalid_coordinate'], error: '坐标超出有效范围' };
  const accuracy = pt.accuracy == null ? NaN : Number(pt.accuracy);
  const acc = Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 5000 ? accuracy : null;
  const clientTsNum = Number(pt.ts != null ? pt.ts : pt.clientTs);
  const clientTs = Number.isFinite(clientTsNum) && clientTsNum > 0 ? Math.round(clientTsNum) : null;
  const source = String(pt.source || 'gps').toLowerCase();
  if (!['gps', 'network', 'fused', 'simulation', 'legacy'].includes(source)) flags.push('unknown_source');
  if (source === 'simulation' && !options.allowSimulation) flags.push('simulation_not_allowed');
  return {
    ok: true,
    lng, lat, rawLng, rawLat, crs: 'gcj02', rawCrs: 'wgs84',
    accuracy: acc,
    speed: Number.isFinite(Number(pt.speed)) && Number(pt.speed) >= 0 ? Number(pt.speed) : null,
    heading: Number.isFinite(Number(pt.heading)) ? Number(pt.heading) : null,
    altitude: Number.isFinite(Number(pt.altitude)) ? Number(pt.altitude) : null,
    clientTs,
    source,
    coordinateVerified,
    flags
  };
}

function addAnomaly(run, type, severity, detail, point, eventId, ts) {
  const stamp = ts || now();
  const fingerprint = `${run.id}:${type}:${Math.floor(stamp / 30000)}`;
  const exists = db.get(
    'SELECT id FROM anomalies WHERE run_id=? AND type=? AND fingerprint=?',
    [run.id, type, fingerprint]
  );
  if (exists) return null;
  const ins = db.run(
    `INSERT INTO anomalies
      (run_id, participant_id, event_id, type, severity, detail_json, lng, lat, ts, reviewed, created_at, fingerprint)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
    [run.id, run.participant_id, eventId, type, severity,
      detail ? JSON.stringify(detail).slice(0, 12000) : null,
      point ? point.lng : null, point ? point.lat : null, stamp, stamp, fingerprint]
  );
  return { id: Number(ins.lastInsertRowid), type, severity, detail: detail || null, ts: stamp };
}

function requiredCheckpoints(courseId) {
  return courseCheckpoints(courseId).filter((cp) => !!cp.required).sort((a, b) => a.order_index - b.order_index);
}

function validHitRows(runId) {
  return db.all(
    `SELECT h.*, c.order_index, c.code, c.name, c.required, c.reward_points
       FROM cp_hits h JOIN checkpoints c ON c.id=h.checkpoint_id
      WHERE h.run_id=? AND h.valid=1 ORDER BY c.order_index ASC`, [runId]
  );
}

function nextRequiredCheckpoint(run) {
  const cps = requiredCheckpoints(run.course_id);
  const hits = new Set(db.all('SELECT checkpoint_id FROM cp_hits WHERE run_id=? AND valid=1', [run.id]).map((x) => x.checkpoint_id));
  return cps.find((cp) => !hits.has(cp.id)) || null;
}

function latestAcceptedPoint(runId) {
  return db.get(
    `SELECT * FROM track_points WHERE run_id=? AND accepted=1 ORDER BY server_ts DESC, seq DESC LIMIT 1`, [runId]
  );
}

function summarizeRun(run) {
  const points = db.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN accepted=1 THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN accepted=0 THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN is_backfill=1 THEN 1 ELSE 0 END) AS backfill,
           AVG(CASE WHEN accuracy_m IS NOT NULL THEN accuracy_m END) AS avg_accuracy,
           MAX(accuracy_m) AS max_accuracy
      FROM track_points WHERE run_id=?`, [run.id]);
  const anomaly = db.all('SELECT type, severity, COUNT(*) AS n FROM anomalies WHERE run_id=? GROUP BY type, severity', [run.id]);
  const quality = {
    totalPoints: Number(points.total || 0),
    acceptedPoints: Number(points.accepted || 0),
    rejectedPoints: Number(points.rejected || 0),
    backfillPoints: Number(points.backfill || 0),
    avgAccuracy: points.avg_accuracy == null ? null : Math.round(points.avg_accuracy * 10) / 10,
    maxAccuracy: points.max_accuracy == null ? null : Math.round(points.max_accuracy * 10) / 10,
    anomalies: anomaly
  };
  db.run('UPDATE runs SET quality_json=? WHERE id=?', [JSON.stringify(quality), run.id]);
  return quality;
}

/* Process a batch inside a transaction. */
function processTrackBatch(run, event, body, options = {}) {
  const course = db.get('SELECT * FROM courses WHERE id=?', [run.course_id]);
  const route = parseCoursePoints(course);
  const rules = rulesForEvent(event, options.groupKey);
  const input = Array.isArray(body.points) ? body.points.slice(0, 200) : [];
  const result = { accepted: 0, rejected: 0, duplicate: 0, anomalies: [], points: [], lastSeq: run.last_seq == null ? -1 : run.last_seq };
  let state = Object.assign({}, run);
  let previous = state.last_lng != null && state.last_lat != null ? {
    lng: state.last_lng, lat: state.last_lat, serverTs: state.last_point_at,
    clientTs: state.last_client_ts, accuracy: state.last_accuracy
  } : null;
  const batchId = String(body.batchId || crypto.randomBytes(8).toString('hex')).slice(0, 64);
  const allowSimulation = !!options.allowSimulation;

  input.forEach((rawInput, index) => {
    const rawSeq = rawInput && typeof rawInput === 'object' ? rawInput.seq : null;
    const seq = Number.isInteger(Number(rawSeq)) ? Number(rawSeq) : (state.last_seq + 1);
    result.lastSeq = Math.max(result.lastSeq, seq);
    if (seq < 0) { result.rejected++; return; }
    const duplicate = db.get('SELECT id FROM track_points WHERE run_id=? AND seq=?', [run.id, seq]);
    if (duplicate) { result.duplicate++; return; }
    if (seq <= (state.last_seq == null ? -1 : state.last_seq)) {
      const an = addAnomaly(state, 'out_of_order', 'info', { seq, lastSeq: state.last_seq }, null, event.id);
      if (an) result.anomalies.push(an);
      result.rejected++;
      return;
    }

    const p = normalizePoint(rawInput, { allowSimulation });
    const serverTs = now();
    if (!p.ok) {
      db.run(`INSERT INTO track_points
        (run_id,participant_id,event_id,seq,lng,lat,raw_lng,raw_lat,crs,accuracy_m,speed,heading,altitude,client_ts,server_ts,source,accepted,reliable,coordinate_verified,is_backfill,validation_flags,batch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,?)`,
        [run.id, run.participant_id, run.event_id, seq, 0, 0, null, null, 'gcj02', null, null, null, null,
          null, serverTs, 'unknown', JSON.stringify(p.flags || ['invalid_coordinate']), batchId]);
      const an = addAnomaly(state, 'invalid_coordinate', 'warn', { seq, error: p.error, flags: p.flags }, null, event.id, serverTs);
      if (an) result.anomalies.push(an);
      result.rejected++;
      state.last_seq = seq;
      return;
    }

    const flags = p.flags.slice();
    const isBackfill = !!body.backfill || !!(p.clientTs && serverTs - p.clientTs > Math.max(15000, rules.uploadIntervalSec * 2000));
    let reliable = p.accuracy != null && p.accuracy <= rules.unreliableAccuracyM;
    if (!p.clientTs || p.clientTs > serverTs + 30000 || p.clientTs < run.started_at - 30000) flags.push('invalid_timestamp');
    if (p.accuracy == null) flags.push('accuracy_missing');
    if (!reliable) flags.push('accuracy_poor');
    let accepted = reliable && flags.indexOf('invalid_timestamp') < 0 && flags.indexOf('coordinate_mismatch') < 0 && flags.indexOf('simulation_not_allowed') < 0;
    let derivedSpeed = p.speed;
    let distance = null;
    let dt = null;
    if (previous) {
      distance = distanceM([previous.lng, previous.lat], [p.lng, p.lat]);
      const candidateDt = p.clientTs && previous.clientTs ? (p.clientTs - previous.clientTs) / 1000 :
        (serverTs - (previous.serverTs || serverTs)) / 1000;
      dt = candidateDt;
      if (candidateDt <= 0) flags.push('time_reverse');
      if (candidateDt > 0) derivedSpeed = distance / candidateDt;
      if (derivedSpeed != null && derivedSpeed > rules.maxSpeedMps) {
        flags.push('speed_anomaly');
        accepted = false;
      }
      if (candidateDt > rules.maxGapSec) {
        const an = addAnomaly(state, 'gps_lost', 'warn', { gapSec: Math.round(candidateDt), maxGapSec: rules.maxGapSec }, previous, event.id, serverTs);
        if (an) result.anomalies.push(an);
        state.lost_at = serverTs;
      }
    }
    if (flags.indexOf('time_reverse') >= 0) accepted = false;
    if (flags.indexOf('simulation_not_allowed') >= 0) accepted = false;
    const routeResult = route.length >= 2 ? geo.distToPath([p.lng, p.lat], route) : { dist: null, segIndex: -1 };
    const routeDistance = routeResult.dist == null ? null : routeResult.dist;
    if (routeDistance == null) flags.push('route_unavailable');

    if (flags.indexOf('accuracy_poor') >= 0) {
      const an = addAnomaly(state, 'accuracy_poor', 'info', { accuracy: p.accuracy, max: rules.maxAccuracyM, seq }, p, event.id, serverTs);
      if (an) result.anomalies.push(an);
    }
    if (flags.indexOf('speed_anomaly') >= 0) {
      const an = addAnomaly(state, 'speed_anomaly', 'warn', { speed: derivedSpeed, maxSpeed: rules.maxSpeedMps, distance, dt }, p, event.id, serverTs);
      if (an) result.anomalies.push(an);
    }
    if (flags.indexOf('coordinate_mismatch') >= 0) {
      const an = addAnomaly(state, 'coordinate_mismatch', 'warn', { seq }, p, event.id, serverTs);
      if (an) result.anomalies.push(an);
    }

    let offState = state.off_route_streak || 0;
    let offStarted = state.off_route_started_at || 0;
    if (accepted && reliable && routeDistance != null) {
      const warnThreshold = rules.warningDistanceM + (p.accuracy || 0) * rules.accuracyFactor;
      const criticalThreshold = rules.alertDistanceM + (p.accuracy || 0) * rules.accuracyFactor;
      if (routeDistance > warnThreshold) {
        offState += 1;
        if (!offStarted) offStarted = p.clientTs;
        const duration = p.clientTs - offStarted;
        if (offState >= rules.minConsecutive && duration >= rules.minDurationSec * 1000) {
          const severity = routeDistance > criticalThreshold ? 'critical' : 'warn';
          const type = severity === 'critical' ? 'off_route_critical' : 'off_route';
          const an = addAnomaly(state, type, severity, {
            distanceM: Math.round(routeDistance), accuracyM: p.accuracy,
            thresholdM: Math.round(severity === 'critical' ? criticalThreshold : warnThreshold),
            durationMs: duration, consecutive: offState, segIndex: routeResult.segIndex
          }, p, event.id, serverTs);
          if (an) result.anomalies.push(an);
          if (severity === 'critical') state.critical_count = (state.critical_count || 0) + (an ? 1 : 0);
          else state.warning_count = (state.warning_count || 0) + (an ? 1 : 0);
          state.off_route_cnt = (state.off_route_cnt || 0) + (an ? 1 : 0);
        }
      } else {
        if (offState >= rules.minConsecutive && offStarted) {
          const an = addAnomaly(state, 'route_recovered', 'info', { durationMs: serverTs - offStarted }, p, event.id, serverTs);
          if (an) result.anomalies.push(an);
        }
        offState = 0; offStarted = 0;
      }
    }

    db.run(`INSERT INTO track_points
      (run_id,participant_id,event_id,seq,lng,lat,raw_lng,raw_lat,crs,accuracy_m,speed,heading,altitude,client_ts,server_ts,source,accepted,reliable,coordinate_verified,is_backfill,validation_flags,route_distance_m,batch_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [run.id, run.participant_id, run.event_id, seq, p.lng, p.lat, p.rawLng, p.rawLat, 'gcj02', p.accuracy,
        derivedSpeed, p.heading, p.altitude, p.clientTs, serverTs, p.source, accepted ? 1 : 0, reliable ? 1 : 0,
        p.coordinateVerified ? 1 : 0, isBackfill ? 1 : 0, flags.length ? JSON.stringify(flags) : null, routeDistance, batchId]);

    if (accepted) {
      result.accepted++;
      state.accepted_points = (state.accepted_points || 0) + 1;
      if (isBackfill) state.backfill_points = (state.backfill_points || 0) + 1;
      if (distance != null && distance < 10000 && previous && dt > 0) state.distance_m = (state.distance_m || 0) + distance;
      if (derivedSpeed != null && Number.isFinite(derivedSpeed)) {
        state.max_speed = state.max_speed == null ? derivedSpeed : Math.max(state.max_speed, derivedSpeed);
        const n = state.accepted_points || 1;
        state.avg_speed = state.avg_speed == null ? derivedSpeed : state.avg_speed + (derivedSpeed - state.avg_speed) / n;
      }
      state.last_lng = p.lng; state.last_lat = p.lat; state.last_accuracy = p.accuracy;
      state.last_point_at = p.clientTs; state.last_client_ts = p.clientTs;
      state.last_route_distance = routeDistance;
      state.off_route_streak = offState; state.off_route_started_at = offStarted;
      previous = { lng: p.lng, lat: p.lat, serverTs, clientTs: p.clientTs, accuracy: p.accuracy };
    } else {
      result.rejected++;
      state.rejected_points = (state.rejected_points || 0) + 1;
    }
    state.last_seq = seq;
    result.points.push({ seq, accepted, reliable, flags, routeDistance, serverTs });
  });

  db.run(`UPDATE runs SET
    last_seq=?, last_point_at=?, last_client_ts=?, last_lng=?, last_lat=?, last_accuracy=?,
    last_route_distance=?, off_route_cnt=?, warning_count=?, critical_count=?, lost_at=?,
    distance_m=?, max_speed=?, avg_speed=?, accepted_points=?, rejected_points=?, backfill_points=?,
    off_route_streak=?, off_route_started_at=?, updated_at=? WHERE id=?`,
  [state.last_seq == null ? -1 : state.last_seq, state.last_point_at, state.last_client_ts || null,
    state.last_lng, state.last_lat, state.last_accuracy, state.last_route_distance,
    state.off_route_cnt || 0, state.warning_count || 0, state.critical_count || 0, state.lost_at || null,
    state.distance_m || 0, state.max_speed, state.avg_speed, state.accepted_points || 0,
    state.rejected_points || 0, state.backfill_points || 0, state.off_route_streak || 0,
    state.off_route_started_at || null, now(), run.id]);

  return result;
}

function runPublic(run, quality) {
  if (!run) return null;
  return {
    id: run.id,
    participantId: run.participant_id,
    courseId: run.course_id,
    routeKey: run.route_key || null,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    elapsedMs: run.elapsed_ms,
    distance: Math.round(run.distance_m || 0),
    cpDone: run.cp_done || 0,
    cpTotal: run.cp_total || 0,
    completed: !!run.completed,
    status: run.status,
    mode: run.mode,
    finishValid: !!run.finish_valid,
    finishDistance: run.finish_dist_m,
    rewardPoints: run.reward_points || 0,
    warningCount: run.warning_count || 0,
    criticalCount: run.critical_count || 0,
    acceptedPoints: run.accepted_points || 0,
    rejectedPoints: run.rejected_points || 0,
    backfillPoints: run.backfill_points || 0,
    reviewStatus: run.review_status || 'pending',
    quality: quality || parseJson(run.quality_json, null)
  };
}

module.exports = {
  validLngLat,
  validWgs,
  distanceM,
  pathDistance,
  routeIdentity,
  selectCourse,
  courseCheckpoints,
  requiredCheckpoints,
  parseCoursePoints,
  coursePublic,
  validateCourse,
  normalizePoint,
  addAnomaly,
  nextRequiredCheckpoint,
  validHitRows,
  latestAcceptedPoint,
  summarizeRun,
  processTrackBatch,
  runPublic,
  rulesForEvent,
  groupConfig,
  normalizeRules,
  parseJson,
  now
};
