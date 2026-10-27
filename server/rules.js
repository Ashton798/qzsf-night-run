'use strict';

/*
 * All operational thresholds live here and are persisted as event.rules_json.
 * These are starting values only; the administrator must calibrate them with
 * real Android/iPhone measurements before an event.  No threshold is a
 * qualification decision by itself: anomalies remain reviewable evidence.
 */
const DEFAULT_RULES = Object.freeze({
  uploadIntervalSec: 10,
  warningDistanceM: 25,
  alertDistanceM: 50,
  accuracyFactor: 1.0,
  unreliableAccuracyM: 60,
  maxAccuracyM: 120,
  minConsecutive: 3,
  minDurationSec: 8,
  maxSpeedMps: 12,
  maxGapSec: 45,
  startRadiusM: 80,
  finishRadiusM: 80,
  checkpointDefaultRadiusM: 30,
  checkpointAccuracyFactor: 1.0,
  checkpointMaxAgeSec: 45,
  requireOrderedCheckpoints: true,
  requireFinish: true,
  allowQrCheckin: false,
  allowManualCheckin: true,
  allowQrCheckpoint: false,
  allowManualCheckpoint: true,
  rewardPointsDefault: 0
});

const NUMBER_LIMITS = {
  uploadIntervalSec: [3, 60],
  warningDistanceM: [1, 500],
  alertDistanceM: [2, 1000],
  accuracyFactor: [0, 5],
  unreliableAccuracyM: [5, 500],
  maxAccuracyM: [10, 1000],
  minConsecutive: [1, 20],
  minDurationSec: [0, 300],
  maxSpeedMps: [1, 50],
  maxGapSec: [10, 3600],
  startRadiusM: [5, 500],
  finishRadiusM: [5, 500],
  checkpointDefaultRadiusM: [5, 500],
  checkpointAccuracyFactor: [0, 5],
  checkpointMaxAgeSec: [5, 300],
  rewardPointsDefault: [0, 1000]
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseRules(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function normalizeRules(value) {
  const input = parseRules(value);
  const out = {};
  Object.keys(DEFAULT_RULES).forEach((key) => {
    const fallback = DEFAULT_RULES[key];
    if (typeof fallback === 'boolean') out[key] = input[key] === undefined ? fallback : !!input[key];
    else {
      const lim = NUMBER_LIMITS[key];
      out[key] = lim ? clampNumber(input[key], lim[0], lim[1], fallback) :
        (Number.isFinite(Number(input[key])) ? Number(input[key]) : fallback);
    }
  });
  // A 50m alert threshold below the warning threshold is nonsensical.
  out.alertDistanceM = Math.max(out.warningDistanceM, out.alertDistanceM);
  out.maxAccuracyM = Math.max(out.unreliableAccuracyM, out.maxAccuracyM);
  return out;
}

function parseGroups(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function rulesForEvent(event, groupKey) {
  const base = normalizeRules(event && event.rules_json);
  const groups = parseGroups(event && event.groups_json);
  const group = (groupKey && groups[groupKey]) || {};
  return normalizeRules(Object.assign({}, base, group.rules || {}));
}

function groupConfig(event, groupKey) {
  const groups = parseGroups(event && event.groups_json);
  return (groupKey && groups[groupKey]) || null;
}

module.exports = {
  DEFAULT_RULES,
  normalizeRules,
  parseRules,
  parseGroups,
  rulesForEvent,
  groupConfig
};
