/*
 * Boil の IP 管理模块
 *
 * 官方 API：
 * - POST https://ippanel.boil.network/api/v1/getIP
 * - POST https://ippanel.boil.network/api/v1/changeIP/
 * - Header: Authorization: Bearer <token>
 *
 * 仅由 Surge generic 信息面板手动触发。模块没有定时任务或网络事件。
 *
 * 换 IP 是官方让路由器 WAN 线路重连／重拨，VPS 会短暂断网（官方机制）。
 * 更换流程：先查询旧 IP → 只提交一次 changeIP → 在 confirm_seconds 秒内轮询 getIP 确认。
 * 本地记录（$persistentStore）只保存 IP、时间戳与 Token 指纹，用于冷却和防重复提交；
 * 不保存 Token。
 */

var API_ORIGIN = "https://ippanel.boil.network";
var STATE_KEY = "boil_ip_manager_state_v1";
var GET_IP_PATH = "/api/v1/getIP";
var CHANGE_IP_PATH = "/api/v1/changeIP/";

var REQUEST_TIMEOUT_SECONDS = 15;
var POLL_TIMEOUT_SECONDS = 10;
var MAX_CONFIRM_SECONDS = 240;
var POLL_OFFSETS = [10, 20, 30, 45, 60, 80, 100, 120, 150, 180, 210, 240];
var REQUESTING_LOCK_SECONDS = 60;
var PENDING_GRACE_SECONDS = 30;
var UNCLEAR_MIN_LOCK_SECONDS = 300;
// 本地拦截最多信任 nextAllowedAt 到多久以后；更远的值视为异常（服务端故障或误解析），不锁死本地。
var MAX_LOCAL_COOLDOWN_SECONDS = 24 * 60 * 60;
var RECORD_COMPARE_SECONDS = 24 * 60 * 60;
var RECONNECT_HINT_SECONDS = 5 * 60;

var RETRY_LATER_PATTERN = /內部錯誤|内部错误|稍後再試|稍后再试/;
var RATE_LIMIT_PATTERN = /頻率限制|频率限制/;
var TOKEN_INVALID_PATTERN = /用戶與機器不匹配|用户与机器不匹配/;
var DEDUCTED_PATTERN =
  /當日更換IP次數已用完|当日更换IP次数已用完|當前機器不允許更換IP|当前机器不允许更换IP/;

var TOKEN_INVALID_HINT =
  "API Token 已失效（用戶與機器不匹配）。请到 ippanel.boil.network 重新获取 Token 并更新模块参数。";
var DEDUCTED_HINT = "官方规定本次调用已扣 1 次 API，请勿重复点击。";
var NOT_REQUESTED_LINE = "未请求 API，不扣次数";
var QUERY_LATER_LINE = "请勿立即重试；稍后点「Boil IP 查询」确认";

var BUSY_REASONS = {
  requesting: "上一次更换仍在提交中",
  pending: "上一次更换仍在确认新 IP",
  unclear: "上一次提交结果不明确，处于保护期",
  changed: "上一次更换刚确认完成，处于保护期",
};
var COMPARABLE_STATUSES = { pending: true, unclear: true, unchanged: true };

var finished = false;
var storeWriteFailed = false;

/* ---------- 参数 ---------- */

function decodeArgument(value, name) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new Error("参数 " + name + " 包含无效的 URL 编码");
  }
}

function getArguments() {
  var result = {};
  if (typeof $argument === "undefined" || $argument === null) return result;

  if (typeof $argument === "object") {
    Object.keys($argument).forEach(function (key) {
      result[key] = String($argument[key] === undefined ? "" : $argument[key]);
    });
    return result;
  }

  var text = String($argument).trim();
  if (!text) return result;
  if (/^["'].*["']$/.test(text)) text = text.slice(1, -1);

  text.split("&").forEach(function (pair) {
    var separator = pair.indexOf("=");
    if (separator <= 0) return;
    var key = pair.slice(0, separator);
    result[key] = decodeArgument(pair.slice(separator + 1), key);
  });
  return result;
}

function parseBoolean(value, name, defaultValue) {
  var text = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  if (!text) return defaultValue;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(name + " 必须是 true 或 false");
}

function parseConfirmSeconds(value) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text)) {
    throw new Error("confirm_seconds 必须是 0–" + MAX_CONFIRM_SECONDS + " 之间的整数");
  }
  var seconds = Number(text);
  return seconds > MAX_CONFIRM_SECONDS ? MAX_CONFIRM_SECONDS : seconds;
}

/* ---------- 结束与通知 ---------- */

function makePanel(title, lines, style, icon, iconColor) {
  return {
    title: title,
    content: lines.join("\n"),
    style: style,
    icon: icon,
    iconColor: iconColor,
  };
}

function errorPanel(title, lines) {
  return makePanel(title, lines, "error", "exclamationmark.triangle.fill", "#FF3B30");
}

function alertPanel(title, lines) {
  return makePanel(title, lines, "alert", "exclamationmark.triangle.fill", "#FF9500");
}

function guardPanel(lines) {
  return makePanel("Boil IP 更换未提交", lines, "info", "clock", "#8E8E93");
}

function logMessage(message) {
  if (typeof console !== "undefined" && console && typeof console.log === "function") {
    console.log("[Boil IP] " + message);
  }
}

// 每次运行只允许一次 $done；通知异常也必须到达 $done。
function finish(panel, shouldNotify) {
  if (finished) return;
  finished = true;

  var content = panel.content;
  if (storeWriteFailed) content += "\n（本地记录写入失败）";
  var output = {
    title: panel.title,
    content: content,
    style: panel.style,
  };
  if (panel.icon) output.icon = panel.icon;
  if (panel.iconColor) output["icon-color"] = panel.iconColor;

  try {
    if (shouldNotify && typeof $notification !== "undefined") {
      $notification.post(panel.title, "", content);
    }
  } catch (error) {
    logMessage("通知发送失败：" + errorText(error));
  } finally {
    $done(output);
  }
}

function errorText(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

function guarded(fn) {
  return function () {
    try {
      fn.apply(null, arguments);
    } catch (error) {
      finish(errorPanel("Boil IP 脚本错误", [errorText(error)]), false);
    }
  };
}

/* ---------- 时间 ---------- */

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toSeconds(value) {
  if (value === undefined || value === null || value === "") return 0;
  var timestamp = Number(value);
  if (!isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp >= 1000000000000) timestamp /= 1000;
  return Math.floor(timestamp);
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function formatTime(seconds) {
  var date = new Date(seconds * 1000);
  return (
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes()) +
    ":" +
    pad2(date.getSeconds())
  );
}

/* ---------- 本地记录 ---------- */

// djb2 指纹（32 位无符号，8 位十六进制），只用于区分 Token，不能还原 Token。
function tokenFingerprint(token) {
  var hash = 5381;
  for (var i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function hasStore() {
  return typeof $persistentStore !== "undefined" && $persistentStore !== null;
}

function readRawState() {
  if (!hasStore()) return null;
  try {
    var raw = $persistentStore.read(STATE_KEY);
    return typeof raw === "string" ? raw : null;
  } catch (error) {
    return null;
  }
}

function writeRawState(raw) {
  if (!hasStore()) return;
  var ok;
  try {
    ok = $persistentStore.write(raw, STATE_KEY);
  } catch (error) {
    ok = false;
  }
  if (ok === false) storeWriteFailed = true;
}

function writeState(record) {
  writeRawState(JSON.stringify(record));
}

function restoreRawState(raw) {
  writeRawState(raw || "");
}

function tryParseJson(text) {
  try {
    return JSON.parse(text || "");
  } catch (error) {
    return null;
  }
}

function createRecord(fingerprint) {
  return {
    v: 1,
    token: fingerprint,
    status: "",
    oldIp: "",
    newIp: "",
    startedAt: 0,
    requestedAt: 0,
    checkedAt: 0,
    nextAllowedAt: 0,
    busyUntil: 0,
    usesLeft: null,
  };
}

function toCount(value) {
  if (value === undefined || value === null || value === "") return null;
  var count = Number(value);
  return isFinite(count) && count >= 0 ? count : null;
}

function parseState(raw, fingerprint) {
  if (!raw) return null;
  var parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || parsed.token !== fingerprint) {
    return null;
  }
  var record = createRecord(fingerprint);
  record.status = typeof parsed.status === "string" ? parsed.status : "";
  record.oldIp = typeof parsed.oldIp === "string" ? parsed.oldIp : "";
  record.newIp = typeof parsed.newIp === "string" ? parsed.newIp : "";
  record.startedAt = toSeconds(parsed.startedAt);
  record.requestedAt = toSeconds(parsed.requestedAt);
  record.checkedAt = toSeconds(parsed.checkedAt);
  record.nextAllowedAt = toSeconds(parsed.nextAllowedAt);
  record.busyUntil = toSeconds(parsed.busyUntil);
  record.usesLeft = toCount(parsed.usesLeft);
  return record;
}

function copyRecord(record) {
  var copy = {};
  Object.keys(record).forEach(function (key) {
    copy[key] = record[key];
  });
  return copy;
}

/* ---------- API ---------- */

function apiErrorMessage(status, body) {
  var parsed = null;
  try {
    parsed = JSON.parse(body || "");
  } catch (error) {}

  if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
    return parsed.error.trim();
  }
  if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message.trim();
  }
  if (body && String(body).trim()) {
    return "HTTP " + status + "：" + String(body).trim().slice(0, 160);
  }
  return "HTTP " + status + "：API 未返回错误详情";
}

// 归一化响应：transient 表示“请求可能未被处理或结果不明”（网络错误、5xx、非 JSON、內部錯誤）。
function interpretResponse(error, response, body) {
  if (error) {
    return { transient: true, message: "网络请求失败：" + String(error) };
  }

  var status = Number(response && (response.status || response.statusCode));
  if (!isFinite(status)) {
    return { transient: true, message: "API 响应缺少 HTTP 状态码" };
  }

  var parsed = tryParseJson(body);
  if (status < 200 || status >= 300) {
    var message = apiErrorMessage(status, body);
    return {
      status: status,
      transient: status >= 500 || parsed === null || RETRY_LATER_PATTERN.test(message),
      message: message,
    };
  }

  if (parsed === null) {
    return { status: status, transient: true, message: "API 返回的不是有效 JSON" };
  }

  var dataMessage = "";
  if (typeof parsed.error === "string" && parsed.error.trim()) dataMessage = parsed.error.trim();
  else if (typeof parsed.message === "string" && parsed.message.trim()) {
    dataMessage = parsed.message.trim();
  }
  return { status: status, transient: false, data: parsed, message: dataMessage };
}

function callApi(path, token, timeoutSeconds, callback) {
  $httpClient.post(
    {
      url: API_ORIGIN + path,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      body: "",
      timeout: timeoutSeconds,
    },
    guarded(function (error, response, body) {
      callback(interpretResponse(error, response, body));
    })
  );
}

function extractIp(outcome) {
  var data = outcome.data;
  if (data && data.ok === true && typeof data.ip === "string" && data.ip.trim()) {
    return data.ip.trim();
  }
  return null;
}

function ipFailureReason(outcome) {
  if (outcome.data && outcome.data.ok === true) return "API 未返回有效 IP";
  return outcome.message || "API 未返回有效 IP";
}

function withTokenHint(lines, message) {
  if (TOKEN_INVALID_PATTERN.test(message)) lines.push(TOKEN_INVALID_HINT);
  return lines;
}

function extractTimestamp(message) {
  var match = /(?:^|\D)(\d{13}|\d{10})(?!\d)/.exec(message);
  return match ? toSeconds(match[1]) : 0;
}

function classifyChange(outcome) {
  if (outcome.data && outcome.data.ok === true) return { kind: "accepted", data: outcome.data };

  var message = outcome.message || "API 未确认更换请求";
  if (outcome.transient) return { kind: "unclear", message: message };
  if (RATE_LIMIT_PATTERN.test(message)) {
    return { kind: "rate_limited", message: message, nextAllowedAt: extractTimestamp(message) };
  }
  if (TOKEN_INVALID_PATTERN.test(message)) return { kind: "token_invalid", message: message };
  if (DEDUCTED_PATTERN.test(message)) return { kind: "deducted", message: message };
  return { kind: "failed", message: message };
}

/* ---------- 查询 ---------- */

function runQuery(settings) {
  callApi(GET_IP_PATH, settings.token, REQUEST_TIMEOUT_SECONDS, function (outcome) {
    var ip = extractIp(outcome);
    if (!ip) {
      var reason = ipFailureReason(outcome);
      finish(errorPanel("Boil IP 查询失败", withTokenHint([reason], reason)), false);
      return;
    }

    var lines = ["当前 IP", ip];
    var now = nowSeconds();
    var record = parseState(readRawState(), tokenFingerprint(settings.token));
    if (
      record &&
      COMPARABLE_STATUSES[record.status] &&
      record.oldIp &&
      record.requestedAt > 0 &&
      now - record.requestedAt <= RECORD_COMPARE_SECONDS
    ) {
      if (ip !== record.oldIp) {
        // 查询流程不改 busyUntil，避免与仍在确认的更换流程互相干扰。
        record.status = "changed";
        record.newIp = ip;
        record.checkedAt = now;
        writeState(record);
        lines.push("已从 " + record.oldIp + " 更换（" + formatTime(record.requestedAt) + " 提交）");
      } else {
        var elapsed = Math.max(0, now - record.requestedAt);
        lines.push("仍为更换前 IP（提交后 " + Math.floor(elapsed / 60) + " 分钟）");
        if (elapsed < RECONNECT_HINT_SECONDS) lines.push("可能仍在重连，稍后再查");
      }
    }
    if (record && record.nextAllowedAt > now) {
      lines.push("下次可更换：" + formatTime(record.nextAllowedAt));
    }

    finish(makePanel("Boil IP 查询", lines, "good", "network", "#34C759"), false);
  });
}

/* ---------- 更换 ---------- */

// 拦截只信任 24 小时内的 nextAllowedAt；更远的值不参与拦截（展示行仍可显示官方时间）。
function trustedNextAllowedAt(record, now) {
  if (record.nextAllowedAt - now > MAX_LOCAL_COOLDOWN_SECONDS) return 0;
  return record.nextAllowedAt;
}

function guardLines(record, now) {
  if (!record) return null;
  var nextAllowedAt = trustedNextAllowedAt(record, now);
  if (record.busyUntil > now) {
    var until = Math.max(record.busyUntil, nextAllowedAt);
    return [
      BUSY_REASONS[record.status] || "上一次更换仍在处理中",
      formatTime(until) + " 后可再试",
      NOT_REQUESTED_LINE,
    ];
  }
  if (nextAllowedAt > now) {
    return ["冷却中，下次可更换：" + formatTime(nextAllowedAt), NOT_REQUESTED_LINE];
  }
  return null;
}

function appendQuota(lines, record) {
  if (record.usesLeft !== null) lines.push("剩余 API 次数：" + record.usesLeft);
  if (record.nextAllowedAt > 0) lines.push("下次可更换：" + formatTime(record.nextAllowedAt));
  return lines;
}

function appendUnclearInfo(lines, attempt) {
  if (attempt.record.status !== "unclear") return lines;
  lines.push("提交回应：" + attempt.unclearReason + "；未重复提交");
  lines.push("保护期至：" + formatTime(attempt.record.busyUntil) + "，之前点击会在本地拦截");
  return lines;
}

function runChange(settings) {
  var fingerprint = tokenFingerprint(settings.token);
  var previousRaw = readRawState();
  var previous = parseState(previousRaw, fingerprint);
  var now = nowSeconds();

  var blocked = guardLines(previous, now);
  if (blocked) {
    finish(guardPanel(blocked), false);
    return;
  }

  var record = createRecord(fingerprint);
  record.status = "requesting";
  record.startedAt = now;
  record.busyUntil = now + REQUESTING_LOCK_SECONDS;
  writeState(record);

  var context = {
    settings: settings,
    fingerprint: fingerprint,
    previous: previous,
    previousRaw: previousRaw,
    record: record,
  };

  callApi(GET_IP_PATH, settings.token, REQUEST_TIMEOUT_SECONDS, function (outcome) {
    var oldIp = extractIp(outcome);
    if (!oldIp) {
      restoreRawState(previousRaw);
      var reason = ipFailureReason(outcome);
      var lines = withTokenHint(["查询当前 IP 失败：" + reason], reason);
      lines.push("未提交更换");
      finish(errorPanel("Boil IP 更换未提交", lines), settings.notify);
      return;
    }
    record.oldIp = oldIp;
    submitChange(context);
  });
}

function submitChange(context) {
  var settings = context.settings;
  var record = context.record;

  // changeIP 每次运行只提交一次；结果不明确时只确认、不重试。
  callApi(CHANGE_IP_PATH, settings.token, REQUEST_TIMEOUT_SECONDS, function (outcome) {
    var result = classifyChange(outcome);
    var requestedAtMs = Date.now();
    var requestedAt = Math.floor(requestedAtMs / 1000);

    if (result.kind === "accepted") {
      record.status = "pending";
      record.requestedAt = requestedAt;
      record.usesLeft = toCount(result.data.uses_left);
      record.nextAllowedAt = toSeconds(result.data.next_allowed_at);
      record.busyUntil = requestedAt + settings.confirmSeconds + PENDING_GRACE_SECONDS;
    } else if (result.kind === "unclear") {
      record.status = "unclear";
      record.requestedAt = requestedAt;
      record.busyUntil =
        requestedAt +
        Math.max(UNCLEAR_MIN_LOCK_SECONDS, settings.confirmSeconds + PENDING_GRACE_SECONDS);
    } else {
      finishRejected(context, result);
      return;
    }
    writeState(record);

    var attempt = {
      settings: settings,
      record: record,
      requestedAtMs: requestedAtMs,
      unclearReason: result.kind === "unclear" ? result.message : "",
      offsets: pollOffsets(settings.confirmSeconds),
      index: 0,
      observedOld: false,
      lastError: "",
    };

    if (settings.confirmSeconds === 0) {
      finishSubmitted(attempt);
      return;
    }
    scheduleNextPoll(attempt);
  });
}

function finishRejected(context, result) {
  var lines;
  if (result.kind === "rate_limited" && result.nextAllowedAt > 0) {
    var cooled = context.previous ? copyRecord(context.previous) : createRecord(context.fingerprint);
    if (!context.previous) {
      cooled.status = "unchanged";
      cooled.oldIp = context.record.oldIp;
      cooled.startedAt = context.record.startedAt;
    }
    cooled.nextAllowedAt = result.nextAllowedAt;
    cooled.busyUntil = 0;
    writeState(cooled);
    lines = [
      result.message,
      "官方规定本次调用已扣 1 次 API",
      "下次可更换：" + formatTime(result.nextAllowedAt) + "，之前点击会在本地拦截",
    ];
  } else {
    restoreRawState(context.previousRaw);
    if (result.kind === "token_invalid") lines = [TOKEN_INVALID_HINT];
    else if (result.kind === "rate_limited" || result.kind === "deducted") {
      lines = [result.message, DEDUCTED_HINT];
    } else lines = [result.message];
  }
  finish(errorPanel("Boil IP 更换失败", lines), context.settings.notify);
}

function finishSubmitted(attempt) {
  var record = attempt.record;
  var lines;
  if (record.status === "unclear") {
    lines = [
      "旧 IP：" + record.oldIp,
      "若官方已执行更换，VPS 会短暂断网",
      "1–3 分钟后点「Boil IP 查询」确认是否已变化",
    ];
    appendQuota(lines, record);
    appendUnclearInfo(lines, attempt);
    finish(alertPanel("Boil IP 结果不明确", lines), attempt.settings.notify);
    return;
  }

  lines = [
    "旧 IP：" + record.oldIp,
    "官方正在重连线路，VPS 会短暂断网",
    "1–3 分钟后点「Boil IP 查询」确认是否已变化",
  ];
  appendQuota(lines, record);
  finish(
    makePanel("Boil IP 更换已提交", lines, "good", "arrow.triangle.2.circlepath", "#FF9500"),
    attempt.settings.notify
  );
}

function pollOffsets(confirmSeconds) {
  var offsets = POLL_OFFSETS.filter(function (offset) {
    return offset <= confirmSeconds;
  });
  if (confirmSeconds > 0 && (!offsets.length || offsets[offsets.length - 1] < confirmSeconds)) {
    offsets.push(confirmSeconds);
  }
  return offsets;
}

// 只用 setTimeout（JSC 没有 clearTimeout）；上一次查询超时导致迟到时，下一次立即执行。
function scheduleNextPoll(attempt) {
  if (attempt.index >= attempt.offsets.length) {
    finishUnconfirmed(attempt);
    return;
  }
  var dueMs = attempt.requestedAtMs + attempt.offsets[attempt.index] * 1000;
  attempt.index += 1;
  setTimeout(
    guarded(function () {
      pollOnce(attempt);
    }),
    Math.max(0, dueMs - Date.now())
  );
}

function pollOnce(attempt) {
  callApi(GET_IP_PATH, attempt.settings.token, POLL_TIMEOUT_SECONDS, function (outcome) {
    var ip = extractIp(outcome);
    if (ip) {
      if (ip !== attempt.record.oldIp) {
        finishChanged(attempt, ip);
        return;
      }
      attempt.observedOld = true;
    } else if (outcome.transient || outcome.data !== undefined) {
      attempt.lastError = ipFailureReason(outcome);
    } else {
      finishPollFailed(attempt, ipFailureReason(outcome));
      return;
    }
    scheduleNextPoll(attempt);
  });
}

function elapsedSeconds(attempt) {
  return Math.max(0, Math.round((Date.now() - attempt.requestedAtMs) / 1000));
}

function finishChanged(attempt, newIp) {
  var record = attempt.record;
  var wasUnclear = record.status === "unclear";
  record.status = "changed";
  record.newIp = newIp;
  record.checkedAt = nowSeconds();
  // 提交被接受时 nextAllowedAt 已知，之后只受它约束；提交结果不明确时官方冷却未知，
  // 而更换确实发生了，保留原保护期，避免立即再点触发官方頻率限制（仍扣 1 次）。
  if (!wasUnclear) record.busyUntil = 0;
  writeState(record);

  var lines = [
    "旧 IP：" + record.oldIp,
    "新 IP：" + newIp,
    "确认耗时：" + elapsedSeconds(attempt) + " 秒",
  ];
  if (wasUnclear) {
    lines.push("（提交回应不明确，但已确认 IP 变化）");
    lines.push(
      "官方冷却时间未知，" + formatTime(record.busyUntil) + " 前的点击会在本地拦截"
    );
  }
  appendQuota(lines, record);
  finish(
    makePanel("Boil IP 已更换", lines, "good", "checkmark.circle.fill", "#34C759"),
    attempt.settings.notify
  );
}

function finishUnconfirmed(attempt) {
  var record = attempt.record;
  var unclear = record.status === "unclear";
  var elapsed = elapsedSeconds(attempt);
  var lines;

  record.checkedAt = nowSeconds();
  if (attempt.observedOld) {
    if (!unclear) {
      record.status = "unchanged";
      record.busyUntil = 0;
    }
    lines = [
      elapsed + " 秒内仍为旧 IP：" + record.oldIp,
      "可能是官方重拨后分回同一 IP，或仍在重连",
    ];
  } else {
    // 窗口内一次都没查到 IP：保持 pending／unclear，由 busyUntil 自动解除。
    lines = [
      elapsed + " 秒内未能查询到当前 IP：" + attempt.lastError,
      "旧 IP：" + record.oldIp + "；官方可能仍在重连",
    ];
  }
  writeState(record);

  lines.push(QUERY_LATER_LINE);
  appendQuota(lines, record);
  appendUnclearInfo(lines, attempt);
  var title = attempt.observedOld && !unclear ? "Boil IP 未变化" : "Boil IP 结果不明确";
  finish(alertPanel(title, lines), attempt.settings.notify);
}

function finishPollFailed(attempt, reason) {
  var record = attempt.record;
  record.checkedAt = nowSeconds();
  writeState(record);

  var lines = [
    (record.status === "unclear" ? "提交结果不明确" : "更换已提交") + "，旧 IP：" + record.oldIp,
    "确认新 IP 时查询失败：" + reason,
  ];
  withTokenHint(lines, reason);
  lines.push("已停止确认，未重复提交；稍后点「Boil IP 查询」确认");
  appendQuota(lines, record);
  appendUnclearInfo(lines, attempt);
  finish(errorPanel("Boil IP 确认失败", lines), attempt.settings.notify);
}

/* ---------- 入口 ---------- */

function isAutoTrigger() {
  return typeof $trigger !== "undefined" && $trigger === "auto-interval";
}

function main() {
  var settings;
  try {
    var args = getArguments();
    var action = String(args.action || "").trim().toLowerCase();
    if (action !== "query" && action !== "change") {
      throw new Error("action 必须是 query 或 change");
    }
    settings = {
      action: action,
      enabled: parseBoolean(args.enabled, "enabled", false),
      notify: parseBoolean(args.notify, "notify", true),
      confirmSeconds: parseConfirmSeconds(args.confirm_seconds),
      token: String(args.api_token || "").trim(),
    };
  } catch (error) {
    finish(errorPanel("Boil IP 配置错误", [errorText(error)]), false);
    return;
  }

  var label = settings.action === "query" ? "查询" : "更换 IP";
  if (!settings.enabled) {
    finish(
      makePanel("Boil IP " + label, [label + "开关已关闭，未请求 API。"], "info", "lock.fill", "#8E8E93"),
      false
    );
    return;
  }

  if (settings.action === "change" && isAutoTrigger()) {
    finish(
      makePanel(
        "Boil IP " + label,
        ["更换 IP 只能手动点击触发；未请求 API。"],
        "info",
        "hand.raised.fill",
        "#8E8E93"
      ),
      false
    );
    return;
  }

  if (!settings.token) {
    finish(errorPanel("Boil IP 配置错误", ["请先在模块参数中填写 API Token"]), false);
    return;
  }

  if (settings.action === "query") runQuery(settings);
  else runChange(settings);
}

guarded(main)();
