/*
 * po0 防火墙自动加白
 * 兼容：Surge / Stash / Shadowrocket / Loon / Quantumult X
 * （Egern 运行模型不同，用独立的 egern/po0-firewall-whitelist.js）
 *
 * POST /api/firewall/<token>/add  把"当前请求源 IP"加入白名单，并回显
 *   {enabled, whitelist:[{ip,slot}], limit, currentIp}。token 走 URL 路径，无需
 *   Authorization 头。服务端对已在白名单的 IP 做幂等处理（重复请求不
 *   重复占坑、不推进淘汰队列），因此这里每次直接无脑请求。
 * 白名单写满后按写入时间先进先出自动淘汰最旧 IP；API 无删除接口。
 *
 * 策略：
 * - 每次直接 POST 上报当前出口 IP；Surge 模块按当前网络选择槽位。
 * - 网络槽位参数：cellular_slot、wired_slot、unknown_slot，以及
 *   ssid_slots="Home WiFi=0|Office=1"。指定网络槽位优先于 token@N。
 * - 默认 slotless 写入：按 updated_at 触发 LRU 淘汰；Surge 版本由切网事件
 *   与面板刷新触发，不再包含 cron。
 * - 可选固定槽位：token 后加 @N（如 pgnfw_xxx@0）→ POST .../add?slot=N，
 *   把本机 IP 钉在槽位 N，**永不被 LRU 淘汰**。槽位写入语义：
 *     · 本机 IP 已在该槽位 → 刷新 updated_at；
 *     · 槽位有旧 IP → 行级顶替，旧 IP 丢弃；
 *     · 本机 IP 已 slotless → 删 slotless 行升级到该槽位；
 *     · 本机 IP 已占用**别的**槽位 → 403 冲突，需先去 UI 删旧槽位（脚本会报 ❌）。
 * - 蜂窝（主接口 pdp_ip*）写入的 IP 做 📶 标记，面板同时显示网络类型。
 *
 * token 来源（优先级从高到低）：
 * 1. argument: tokens=<pgnfw_xxx>[@槽位],<pgnfw_yyy>（Surge/Loon/Stash 模块参数）
 * 2. 持久化存储 key "po0fw_tokens"（Quantumult X 等不支持参数的客户端，
 *    可用 BoxJs 或一次性脚本写入）
 * 3. 下面的 INLINE_TOKENS 常量（自己维护脚本副本时直接填这里）
 */

var INLINE_TOKENS = "";

var API_BASE = "https://124.221.69.228/api/firewall/"; // + <token> + "/add"
var STORE_PREFIX = "po0_fw_";
var TOKENS_KEY = "po0fw_tokens";
var HIST_WINDOW_MS = 24 * 3600 * 1000; // 📶 标记的记账窗口
var NOTIFICATIONS_ENABLED = true;

/* ---------- 环境兼容层 ---------- */

var isQX = typeof $task !== "undefined";
var isSurgeLike = typeof $httpClient !== "undefined"; // Surge/Stash/Shadowrocket/Loon

function storeRead(key) {
  if (isQX) return $prefs.valueForKey(key);
  if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
  return null;
}

function storeWrite(value, key) {
  if (isQX) return $prefs.setValueForKey(value, key);
  if (typeof $persistentStore !== "undefined") return $persistentStore.write(value, key);
  return false;
}

function notify(title, subtitle, body) {
  if (!NOTIFICATIONS_ENABLED) return;
  if (isQX) $notify(title, subtitle, body);
  else if (typeof $notification !== "undefined") $notification.post(title, subtitle, body);
}

function httpRequest(method, opts) {
  return new Promise(function (resolve) {
    if (isQX) {
      opts.method = method;
      $task.fetch(opts).then(
        function (resp) {
          resolve({ body: resp.body, status: resp.statusCode });
        },
        function (err) {
          resolve({ error: String((err && err.error) || err) });
        }
      );
    } else if (isSurgeLike) {
      var fn = method === "POST" ? $httpClient.post : $httpClient.get;
      fn(opts, function (error, response, body) {
        if (error) resolve({ error: String(error) });
        else resolve({ body: body, status: response && (response.status || response.statusCode) });
      });
    } else {
      resolve({ error: "unsupported client" });
    }
  });
}

function decodeArgument(value, name) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    throw new Error("参数 " + name + " 包含无效的 URL 编码");
  }
}

function getArguments() {
  var result = {};
  if (typeof $argument === "undefined" || $argument === null) return result;
  // Loon 插件 argument=[{tokens}] 会注入对象形态
  if (typeof $argument === "object") {
    Object.keys($argument).forEach(function (key) {
      result[key] = String($argument[key] === undefined ? "" : $argument[key]);
    });
    return result;
  }
  if (typeof $argument === "string" && $argument.length > 0) {
    // Shadowrocket 等客户端可能把配置里的外层引号原样传入，先剥掉
    if (/^["'].*["']$/.test($argument)) $argument = $argument.slice(1, -1);
    // Loon 也可能注入 JSON 字符串
    if ($argument.charAt(0) === "{") {
      try {
        var parsed = JSON.parse($argument);
        Object.keys(parsed).forEach(function (key) {
          result[key] = String(parsed[key] === undefined ? "" : parsed[key]);
        });
        return result;
      } catch (e) {
        throw new Error("脚本参数不是有效 JSON");
      }
    }
    // Surge/Stash 风格 key=value&...
    var pairs = $argument.split("&");
    for (var i = 0; i < pairs.length; i++) {
      var idx = pairs[i].indexOf("=");
      if (idx <= 0) continue;
      var key = pairs[i].slice(0, idx);
      var value = pairs[i].slice(idx + 1);
      // ssid_slots 要先按未编码的 | 和 = 分段，才能让 SSID 用 %26/%7C/%3D 表示保留字符。
      result[key] = key === "ssid_slots" ? value : decodeArgument(value, key);
    }
    // 直接把整串当 token 填的兜底（如 Loon argument="pgnfw_..."）
    if (Object.keys(result).length === 0 && $argument.indexOf("pgnfw_") === 0) {
      result.tokens = $argument;
    }
  }
  return result;
}

function detectNetwork() {
  try {
    var iface =
      ($network.v4 && $network.v4.primaryInterface) ||
      ($network.v6 && $network.v6.primaryInterface) ||
      "";
    var ssid = ($network.wifi && $network.wifi.ssid) || "";
    if (iface.indexOf("pdp_ip") === 0) {
      return { kind: "cellular", key: "cellular", label: "蜂窝网络", cellular: true };
    }
    if (ssid) {
      return { kind: "wifi", key: "wifi:" + ssid, label: "Wi-Fi " + ssid, ssid: ssid, cellular: false };
    }
    if (iface) {
      return { kind: "wired", key: "wired", label: "有线网络", cellular: false };
    }
  } catch (e) {
    // 其它客户端可能不支持 $network，统一走陌生网络配置。
  }
  return { kind: "unknown", key: "unknown", label: "陌生网络", cellular: false };
}

function parseSlot(value, name) {
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) throw new Error(name + " 必须是非负整数");
  var slot = Number(text);
  if (!isFinite(slot) || slot > 2147483647) throw new Error(name + " 超出有效范围");
  return slot;
}

function parseBoolean(value, name, defaultValue) {
  var text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (text === "") return defaultValue;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(name + " 必须是 true 或 false");
}

function parseSsidSlots(value) {
  var map = {};
  var text = String(value || "").trim();
  if (!text) return map;
  text.split("|").forEach(function (entry) {
    var item = entry.trim();
    if (!item) return;
    var separator = item.lastIndexOf("=");
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error("ssid_slots 条目必须使用 SSID=槽位：" + item);
    }
    var ssid = decodeArgument(item.slice(0, separator).trim(), "ssid_slots");
    if (!ssid) throw new Error("ssid_slots 不能包含空 SSID");
    if (Object.prototype.hasOwnProperty.call(map, ssid)) {
      throw new Error("ssid_slots 包含重复 SSID：" + ssid);
    }
    map[ssid] = parseSlot(item.slice(separator + 1), "SSID " + ssid + " 的槽位");
  });
  return map;
}

function parseSlotConfig(args) {
  return {
    cellular: parseSlot(args.cellular_slot, "cellular_slot"),
    wired: parseSlot(args.wired_slot, "wired_slot"),
    unknown: parseSlot(args.unknown_slot, "unknown_slot"),
    ssids: parseSsidSlots(args.ssid_slots),
  };
}

function selectNetworkSlot(network, config) {
  if (network.kind === "cellular") return config.cellular;
  if (network.kind === "wired") return config.wired;
  if (network.kind === "wifi") {
    if (Object.prototype.hasOwnProperty.call(config.ssids, network.ssid)) {
      return config.ssids[network.ssid];
    }
    return config.unknown;
  }
  return config.unknown;
}

function finish(title, content, allOk) {
  if (isQX) {
    $done();
    return;
  }
  $done({
    title: title,
    content: content,
    icon: allOk ? "checkmark.shield" : "exclamationmark.shield",
    "icon-color": allOk ? "#34C759" : "#FF3B30",
  });
}

/* ---------- 业务逻辑 ---------- */

function readHistory(key) {
  try {
    var h = JSON.parse(storeRead(key) || "[]");
    var cutoff = Date.now() - HIST_WINDOW_MS;
    return h.filter(function (e) {
      return e.ts > cutoff;
    });
  } catch (e) {
    return [];
  }
}

function apiCall(token, slot) {
  // token 走 URL 路径，命中 /add 即把当前出口 IP 加白；带 slot 则钉固定槽位
  var url = API_BASE + encodeURIComponent(token) + "/add";
  if (slot !== null && slot !== undefined && slot !== "") {
    url += "?slot=" + encodeURIComponent(slot);
  }
  return httpRequest("POST", {
    url: url,
    headers: { "Content-Type": "application/json" },
    body: "",
    timeout: 15,
  }).then(function (r) {
    if (r.error) return { error: r.error };
    var data = null;
    try {
      data = JSON.parse(r.body);
    } catch (e) {}
    // 带槽位写入且本机 IP 已占用别的槽位 → 服务端 403 冲突，需去 UI 删旧槽位
    if (r.status === 403) {
      return {
        error: "槽位冲突：本机 IP 已在其它槽位，请先去 UI 删除",
        conflict: true,
        currentIp: data && data.currentIp,
      };
    }
    if (!data) return { error: "响应异常: " + String(r.body).slice(0, 80) };
    // whitelist 元素为 {ip, slot} 对象（旧版曾是纯 IP 字符串）：记下 ip→slot 再摊平成 IP 数组
    var raw = Array.isArray(data.whitelist) ? data.whitelist : [];
    data.slotOf = {};
    raw.forEach(function (e) {
      if (e && typeof e === "object" && e.slot !== null && e.slot !== undefined) {
        data.slotOf[e.ip] = e.slot;
      }
    });
    data.whitelist = raw.map(function (e) {
      return e && typeof e === "object" ? e.ip : e;
    });
    data.applied = data.enabled === true && data.whitelist.indexOf(data.currentIp) !== -1;
    return data;
  });
}

function ensureWhitelisted(item, index, networkSlot, network) {
  var kvState = STORE_PREFIX + index;
  var kvHist = STORE_PREFIX + "hist_" + index;
  var slot = networkSlot !== null ? networkSlot : item.slot;
  var ctx = { kvState: kvState, kvHist: kvHist, slot: slot, networkKey: network.key };

  // 服务端对重复 IP 幂等，直接请求 /add 即可，无需先查
  return apiCall(item.token, slot).then(function (st) {
    if (st.applied) {
      var hist = readHistory(kvHist);
      var last = hist.length ? hist[hist.length - 1] : null;
      if (!last || last.ip !== st.currentIp) {
        hist.push({ ip: st.currentIp, src: network.cellular ? "cell" : "fixed", ts: Date.now() });
        storeWrite(JSON.stringify(hist.slice(-10)), kvHist);
      }
    }
    ctx.st = st;
    return ctx;
  });
}

// 每 token 一行：不含 token，只含白名单/坑位信息；蜂窝加的 IP 标 📶
function describe(index, ctx) {
  var st = ctx.st;
  var pin = ctx.slot !== null && ctx.slot !== undefined && ctx.slot !== "" ? " 📌" + ctx.slot : "";
  var head = "#" + (index + 1) + pin + " ";
  if (st.error) return head + "❌ " + st.error;
  if (st.enabled === false) return head + "⚠️ 防火墙未启用";
  if (!st.applied) return head + "❌ 加白未生效 " + st.whitelist.length + "/" + st.limit;

  var hist = readHistory(ctx.kvHist);
  var cellIps = {};
  hist.forEach(function (e) {
    if (e.src === "cell") cellIps[e.ip] = true;
  });
  var slotOf = st.slotOf || {};
  var ips = st.whitelist
    .map(function (ip) {
      var slotTag = slotOf[ip] !== undefined ? " 📌" + slotOf[ip] : "";
      return ip + slotTag + (cellIps[ip] ? " 📶" : "") + (ip === st.currentIp ? " ←" : "");
    })
    .join("\n    ");
  return head + "✅ " + st.whitelist.length + "/" + st.limit + "\n    " + ips;
}

function parseTokens(value) {
  return String(value || "")
    .split(/[,|;、\s]+/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.indexOf("pgnfw_") === 0;
    })
    .map(function (s) {
      var at = s.lastIndexOf("@");
      if (at === -1) return { token: s, slot: null };
      return { token: s.slice(0, at), slot: parseSlot(s.slice(at + 1), "token 兜底槽位") };
    });
}

var args = {};
var slotConfig = null;
var network = null;
var networkSlot = null;
var tokens = [];
var configError = null;

try {
  args = getArguments();
  NOTIFICATIONS_ENABLED = parseBoolean(args.notify, "notify", true);
  slotConfig = parseSlotConfig(args);
  network = detectNetwork();
  networkSlot = selectNetworkSlot(network, slotConfig);
  tokens = parseTokens(args.tokens || storeRead(TOKENS_KEY) || INLINE_TOKENS || "");
} catch (e) {
  configError = String((e && e.message) || e);
}

if (configError) {
  notify("po0 防火墙加白", "参数错误", configError);
  finish("po0 加白：参数错误", configError, false);
} else if (tokens.length === 0) {
  notify(
    "po0 防火墙加白",
    "未配置 token",
    "模块参数 tokens / 存储 key po0fw_tokens / 脚本内 INLINE_TOKENS 三选一填入 pgnfw_ token"
  );
  finish("po0 加白：未配置 token", "请填入 pgnfw_ token，多个用 | 分割", false);
} else {
  Promise.all(
    tokens.map(function (t, i) {
      return ensureWhitelisted(t, i, networkSlot, network);
    })
  ).then(function (results) {
    var okCount = 0;
    var exitIp = "?";
    var lines = [];
    var changed = false;

    for (var i = 0; i < results.length; i++) {
      var st = results[i].st;
      if (st.applied) okCount++;
      if (st.currentIp) exitIp = st.currentIp;
      lines.push(describe(i, results[i]));

      var state =
        (st.currentIp || "?") +
        "|" +
        (st.applied ? "1" : "0") +
        "|" +
        (results[i].slot === null ? "slotless" : results[i].slot) +
        "|" +
        results[i].networkKey;
      if (storeRead(results[i].kvState) !== state) {
        storeWrite(state, results[i].kvState);
        changed = true;
      }
    }

    var allOk = okCount === results.length;
    var title =
      "po0 加白 " +
      okCount +
      "/" +
      results.length +
      " · " +
      network.label +
      " · 出口 " +
      exitIp +
      (network.cellular ? " 📶" : "");
    var content = lines.join("\n");

    // 仅在网络、出口 IP、槽位或加白状态较上次变化时通知。
    if (changed) {
      notify("po0 防火墙加白", title, content);
    }
    finish(title, content, allOk);
  });
}
