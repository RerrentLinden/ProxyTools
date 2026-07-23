/*
 * Boil の IP 管理模块
 *
 * 官方 API：
 * - POST https://ippanel.boil.network/api/v1/getIP
 * - POST https://ippanel.boil.network/api/v1/changeIP/
 * - Header: Authorization: Bearer <token>
 *
 * 仅由 Surge generic 信息面板手动触发。模块没有定时任务或网络事件。
 */

var API_ORIGIN = "https://ippanel.boil.network";

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

function panelDone(title, content, style, icon, iconColor) {
  var output = {
    title: title,
    content: content,
    style: style,
  };
  if (icon) output.icon = icon;
  if (iconColor) output["icon-color"] = iconColor;
  $done(output);
}

function notify(enabled, title, body) {
  if (!enabled || typeof $notification === "undefined") return;
  $notification.post(title, "", body);
}

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

function parseJson(body) {
  try {
    return JSON.parse(body || "");
  } catch (error) {
    throw new Error("API 返回的不是有效 JSON");
  }
}

function formatTimestamp(value) {
  var timestamp = Number(value);
  if (!isFinite(timestamp) || timestamp <= 0) return String(value);
  if (timestamp < 1000000000000) timestamp *= 1000;
  return new Date(timestamp).toLocaleString();
}

function request(action, token, callback) {
  var path = action === "query" ? "/api/v1/getIP" : "/api/v1/changeIP/";
  $httpClient.post(
    {
      url: API_ORIGIN + path,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      body: "",
      timeout: 15,
    },
    function (error, response, body) {
      if (error) {
        callback(new Error("网络请求失败：" + String(error)));
        return;
      }

      var status = Number(response && (response.status || response.statusCode));
      if (!isFinite(status)) {
        callback(new Error("API 响应缺少 HTTP 状态码"));
        return;
      }
      if (status < 200 || status >= 300) {
        callback(new Error(apiErrorMessage(status, body)));
        return;
      }

      try {
        callback(null, parseJson(body));
      } catch (parseError) {
        callback(parseError);
      }
    }
  );
}

function handleQuery(data) {
  if (!data || data.ok !== true || typeof data.ip !== "string" || !data.ip.trim()) {
    throw new Error("API 未返回有效 IP");
  }
  panelDone("Boil IP 查询", "当前 IP\n" + data.ip.trim(), "good", "network", "#34C759");
}

function handleChange(data, notificationsEnabled) {
  if (!data || data.ok !== true) {
    throw new Error(
      data && (data.error || data.message) ? String(data.error || data.message) : "API 未确认更换请求"
    );
  }

  var lines = ["更换请求已接受"];
  if (data.message) lines.push(String(data.message));
  if (data.uses_left !== undefined && data.uses_left !== null) {
    lines.push("剩余 API 次数：" + data.uses_left);
  }
  if (data.next_allowed_at !== undefined && data.next_allowed_at !== null) {
    lines.push("下次可用：" + formatTimestamp(data.next_allowed_at));
  }
  lines.push("接口为异步执行；此结果不代表新 IP 已经生效。");

  var content = lines.join("\n");
  notify(notificationsEnabled, "Boil IP 更换", content);
  panelDone("Boil IP 更换", content, "good", "arrow.triangle.2.circlepath", "#FF9500");
}

function main() {
  var args;
  try {
    args = getArguments();
    var action = String(args.action || "").trim().toLowerCase();
    if (action !== "query" && action !== "change") {
      throw new Error("action 必须是 query 或 change");
    }

    var enabled = parseBoolean(args.enabled, "enabled", false);
    var notificationsEnabled = parseBoolean(args.notify, "notify", true);
    if (!enabled) {
      var label = action === "query" ? "查询" : "更换 IP";
      panelDone(
        "Boil IP " + label,
        label + "开关已关闭，未请求 API。",
        "info",
        "lock.fill",
        "#8E8E93"
      );
      return;
    }

    var token = String(args.api_token || "").trim();
    if (!token) throw new Error("请先在模块参数中填写 API Token");

    request(action, token, function (error, data) {
      if (error) {
        var title = action === "query" ? "Boil IP 查询失败" : "Boil IP 更换失败";
        notify(action === "change" && notificationsEnabled, title, error.message);
        panelDone(title, error.message, "error", "exclamationmark.triangle.fill", "#FF3B30");
        return;
      }

      try {
        if (action === "query") handleQuery(data);
        else handleChange(data, notificationsEnabled);
      } catch (handleError) {
        var failureTitle = action === "query" ? "Boil IP 查询失败" : "Boil IP 更换失败";
        notify(action === "change" && notificationsEnabled, failureTitle, handleError.message);
        panelDone(
          failureTitle,
          handleError.message,
          "error",
          "exclamationmark.triangle.fill",
          "#FF3B30"
        );
      }
    });
  } catch (error) {
    panelDone(
      "Boil IP 配置错误",
      error.message,
      "error",
      "exclamationmark.triangle.fill",
      "#FF3B30"
    );
  }
}

main();
