/* 真实定位 + 轨迹采集
 *
 * 坐标系策略（本阶段核心）：
 *   每条采样点同时保留两套坐标
 *     raw     —— GPS 原始 WGS84（永不修改，用于 GPX 导出和复核）
 *     display —— 转换后的 GCJ02（用于高德地图绘制）
 *   数据自带 crs 标记，避免重复转换。
 *
 * 过滤策略：
 *   只做"是否可信"的判断和标记，不做平滑或伪造。
 *   被过滤的点仍然保留在 rawSamples 里，供管理员复核。
 */
(function () {
  'use strict';

  var U = window.U;
  var Coord = window.Coord;

  var S = {
    status: 'idle',
    message: '',
    last: null,          // 最近一次定位（含 raw + display）
    track: [],           // 有效点（含 raw + display）
    rawSamples: [],      // 全部原始采样（含被拒的），用于诊断与复核
    distance: 0,         // 有效轨迹累计距离（米，GCJ02 空间计算）
    watchId: null,
    paused: false,
    visible: true,
    lastFixAt: 0,
    startedAt: 0,
    sampleCount: 0,
    rejectedCount: 0,
    onUpdate: null,
    onStatus: null,
    onTrackPoint: null,
    staleTimer: null,
    options: {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  };

  var LOW_ACC = 30;        // 精度差于此值（米）视为低精度
  var BAD_ACC = 100;       // 差于此值基本不可用
  var MAX_JUMP_SPEED = 12; // m/s，超过视为跳点（约 43 km/h）
  var STALE_MS = 15000;    // 超时未更新视为中断

  var MSG = {
    idle: '未开启定位',
    requesting: '正在请求定位权限…',
    ok: '定位正常',
    denied: '定位权限被拒绝',
    timeout: '定位超时',
    unavailable: '设备无法定位',
    insecure: '非 HTTPS 环境，浏览器已禁用定位',
    lowacc: '定位精度较差',
    lost: '定位信号丢失',
    paused: '定位已暂停'
  };

  function setStatus(st, msg) {
    if (S.status === st && !msg) return;
    S.status = st;
    S.message = msg || MSG[st] || st;
    if (S.onStatus) S.onStatus(snapshot());
  }

  function snapshot() {
    return {
      status: S.status,
      message: S.message,
      last: S.last,
      distance: S.distance,
      points: S.track.length,
      raw: S.rawSamples.length,
      rejected: S.rejectedCount,
      paused: S.paused,
      visible: S.visible,
      samples: S.sampleCount,
      startedAt: S.startedAt
    };
  }

  /* ---------- 页面可见性 / 锁屏 / 断网 ---------- */
  function bindVisibility() {
    document.addEventListener('visibilitychange', function () {
      S.visible = !document.hidden;
      if (document.hidden) {
        if (S.status === 'ok' || S.status === 'lowacc') {
          setStatus('lost', '页面已切到后台，浏览器会暂停定位（返回后自动恢复）');
        }
      } else if (S.watchId != null) {
        setStatus('requesting', '正在恢复定位…');
        setTimeout(function () {
          if (S.watchId != null && Date.now() - S.lastFixAt > STALE_MS) {
            setStatus('lost', '返回页面后仍未收到新定位，请检查权限或 GPS 信号');
          }
        }, 8000);
      }
      if (S.onUpdate) S.onUpdate(snapshot());
    });

    window.addEventListener('offline', function () {
      setStatus('lost', '网络已断开，定位仍可继续（浏览器原生 GPS 不依赖网络），但轨迹无法上传');
    });
    window.addEventListener('online', function () {
      if (S.watchId != null) setStatus('requesting', '网络已恢复');
    });
  }

  /* ---------- 异常点判定（只标记，不删除） ---------- */
  function evaluatePoint(raw) {
    // raw: { lat, lng, accuracy, ts, speed }
    var prev = S.track[S.track.length - 1];
    var flags = [];

    if (raw.accuracy == null || raw.accuracy > BAD_ACC) {
      flags.push('accuracy_poor');
    }

    var still = false;
    if (prev) {
      var dt = (raw.ts - prev.raw.ts) / 1000;
      var d = Coord.haversine([prev.raw.lat, prev.raw.lng], [raw.lat, raw.lng]);
      var speed = dt > 0 ? d / dt : Infinity;

      // 位移小于精度圈：视为"静止"，不算异常，只是不记录为轨迹点
      var jitterRadius = Math.max(raw.accuracy || 0, prev.raw.accuracy || 0);
      if (d < jitterRadius * 0.5 && dt < 10) still = true;

      // 速度异常（跳点）
      if (dt > 0 && speed > MAX_JUMP_SPEED && d > 30) flags.push('jump');

      // 时间倒流
      if (dt < 0) flags.push('time_reverse');
    }

    // 只有真正可疑的才标记
    var trusted = flags.indexOf('accuracy_poor') < 0 &&
                  flags.indexOf('jump') < 0 &&
                  flags.indexOf('time_reverse') < 0;

    return { flags: flags, trusted: trusted, still: still };
  }

  /* ---------- 写入一个采样 ---------- */
  function pushSample(coords, ts) {
    // 1. 原始记录（WGS84，永不修改）
    var raw = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy,
      altitude: coords.altitude,
      altitudeAccuracy: coords.altitudeAccuracy,
      heading: coords.heading,
      speed: coords.speed,
      ts: ts,
      crs: 'wgs84'
    };

    // 2. 坐标系转换（只转一次，转换结果另存）
    var g = Coord.wgs2gcj(raw.lat, raw.lng);
    var sample = {
      raw: raw,
      display: { lat: g[0], lng: g[1], crs: 'gcj02' },
      accuracy: raw.accuracy,
      ts: ts
    };

    var verdict = evaluatePoint(raw);
    sample.flags = verdict.flags;
    sample.trusted = verdict.trusted;
    sample.still = verdict.still;

    S.rawSamples.push(sample);
    S.sampleCount++;

    // 3. 只把可信点加入有效轨迹
    if (S.paused || !verdict.trusted) {
      if (!verdict.trusted) S.rejectedCount++;
      return sample;
    }

    var prev = S.track[S.track.length - 1];
    if (prev) {
      var d = Coord.haversine(
        [prev.display.lat, prev.display.lng],
        [sample.display.lat, sample.display.lng]
      );
      // 位移过小（< 2m）不重复记录，避免轨迹点过密
      if (d < 2) return sample;
      S.distance += d;
    }
    S.track.push(sample);
    if (S.onTrackPoint) S.onTrackPoint(sample, S.track.length);
    return sample;
  }

  /* ---------- 开始 ---------- */
  function start(opts) {
    if (S.watchId != null) return Promise.resolve(snapshot());
    if (opts) Object.assign(S.options, opts);

    if (!window.isSecureContext) {
      setStatus('insecure', '非 HTTPS 环境，浏览器已禁用定位。请用 https:// 或 localhost 访问');
      return Promise.resolve(snapshot());
    }
    if (!navigator.geolocation) {
      setStatus('unavailable', '当前浏览器不支持定位 API');
      return Promise.resolve(snapshot());
    }

    setStatus('requesting');
    S.paused = false;
    if (!S.startedAt) S.startedAt = Date.now();

    var o = {
      enableHighAccuracy: S.options.enableHighAccuracy,
      maximumAge: S.options.maximumAge,
      timeout: S.options.timeout
    };

    // 单点请求：更快暴露权限错误
    navigator.geolocation.getCurrentPosition(onPos, onErr, o);

    S.watchId = navigator.geolocation.watchPosition(onPos, onErr, o);

    if (!S.staleTimer) {
      S.staleTimer = setInterval(function () {
        if (S.watchId == null || S.paused || !S.visible) return;
        if (S.status === 'ok' || S.status === 'lowacc') {
          if (S.lastFixAt && Date.now() - S.lastFixAt > STALE_MS) {
            setStatus('lost', '已有 ' + Math.round((Date.now() - S.lastFixAt) / 1000) + ' 秒未收到定位');
            if (S.onUpdate) S.onUpdate(snapshot());
          }
        }
      }, 3000);
    }

    return Promise.resolve(snapshot());
  }

  function onPos(pos) {
    var c = pos.coords;
    var ts = pos.timestamp || Date.now();

    S.lastFixAt = Date.now();
    var sample = pushSample(c, ts);

    S.last = {
      lat: sample.raw.lat, lng: sample.raw.lng,
      accuracy: sample.raw.accuracy,
      altitude: sample.raw.altitude,
      speed: sample.raw.speed,
      heading: sample.raw.heading,
      ts: ts,
      crs: 'wgs84',
      // 高德地图用这套
      gcj: [sample.display.lng, sample.display.lat],
      gcjLat: sample.display.lat,
      gcjLng: sample.display.lng,
      flags: sample.flags,
      trusted: sample.trusted,
      still: sample.still
    };

    window.dispatchEvent(new CustomEvent('night:gps', {detail:S.last}));
    if (sample.raw.accuracy > LOW_ACC) {
      setStatus('lowacc', '定位精度 ' + Math.round(sample.raw.accuracy) + ' 米');
    } else {
      setStatus('ok');
    }
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  function onErr(err) {
    var code = err && err.code;
    if (code === 1) setStatus('denied', '定位权限被拒绝，请在浏览器设置中允许本站访问位置');
    else if (code === 2) setStatus('unavailable', '设备无法获取位置（GPS 不可用或未开启）');
    else if (code === 3) setStatus('timeout', '定位超时，请到室外开阔处或稍后重试');
    else setStatus('unavailable', (err && err.message) || '定位失败');
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  function pause() {
    S.paused = true;
    setStatus('paused');
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  function resume() {
    S.paused = false;
    setStatus('requesting', '正在恢复定位…');
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  function stop() {
    if (S.watchId != null) {
      navigator.geolocation.clearWatch(S.watchId);
      S.watchId = null;
    }
    if (S.staleTimer) { clearInterval(S.staleTimer); S.staleTimer = null; }
    S.paused = false;
    setStatus('idle');
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  function reset() {
    S.track = [];
    S.rawSamples = [];
    S.distance = 0;
    S.last = null;
    S.sampleCount = 0;
    S.rejectedCount = 0;
    S.startedAt = 0;
    if (S.onUpdate) S.onUpdate(snapshot());
  }

  /* ---------- 导出 ---------- */

  /* 导出为带坐标系标记的 JSON */
  function exportJSON(meta) {
    return {
      format: 'qzsf-gps-track',
      version: 1,
      exportedAt: new Date().toISOString(),
      meta: meta || {},
      // 原始数据：WGS84，保留全部采样（含被拒的）
      rawSamples: S.rawSamples.map(function (s) {
        return {
          lat: s.raw.lat, lng: s.raw.lng, crs: 'wgs84',
          accuracy: s.raw.accuracy, speed: s.raw.speed,
          heading: s.raw.heading, altitude: s.raw.altitude,
          ts: s.raw.ts, flags: s.flags, trusted: s.trusted
        };
      }),
      // 有效轨迹：两套坐标都在
      track: S.track.map(function (s) {
        return {
          raw: { lat: s.raw.lat, lng: s.raw.lng, crs: 'wgs84' },
          display: { lat: s.display.lat, lng: s.display.lng, crs: 'gcj02' },
          accuracy: s.accuracy, ts: s.ts
        };
      }),
      stats: {
        distance: S.distance,
        total: S.rawSamples.length,
        accepted: S.track.length,
        rejected: S.rejectedCount
      }
    };
  }

  /* 导出 GPX：GPX 标准要求 WGS84，所以用 raw 坐标 */
  function exportGPX(name) {
    var pts = S.track.length ? S.track : S.rawSamples;
    var body = pts.map(function (s) {
      var r = s.raw;
      var t = new Date(r.ts).toISOString();
      var ext = '';
      if (r.accuracy != null) ext = '<accuracy>' + r.accuracy.toFixed(1) + '</accuracy>';
      if (r.speed != null && r.speed >= 0) ext += '<speed>' + r.speed.toFixed(2) + '</speed>';
      return '      <trkpt lat="' + r.lat.toFixed(8) + '" lon="' + r.lng.toFixed(8) + '">' +
        '<time>' + t + '</time>' +
        (ext ? '<extensions><gpxtpx:TrackPointExtension>' + ext + '</gpxtpx:TrackPointExtension></extensions>' : '') +
        '</trkpt>';
    }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="qzsf-orienteering" ' +
      'xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n' +
      '  <metadata><name>' + (name || 'GPS采集') + '</name>' +
      '<time>' + new Date().toISOString() + '</time></metadata>\n' +
      '  <trk><name>' + (name || 'GPS采集') + '</name><trkseg>\n' + body + '\n  </trkseg></trk>\n</gpx>';
  }

  bindVisibility();

  var Geo = {
    S: S,
    start: start, stop: stop, pause: pause, resume: resume, reset: reset,
    snapshot: snapshot,
    isActive: function () { return S.watchId != null; },
    exportJSON: exportJSON,
    exportGPX: exportGPX,
    MSG: MSG
  };

  ['onUpdate', 'onStatus', 'onTrackPoint'].forEach(function (k) {
    Object.defineProperty(Geo, k, {
      get: function () { return S[k]; },
      set: function (v) { S[k] = v; }
    });
  });

  window.Geo = Geo;
})();
