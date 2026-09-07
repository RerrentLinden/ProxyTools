/*
 * V2EX 每日登录奖励：原创、无外部依赖的 Surge Mac 脚本。
 * 凭据仅存于 V2EX_CHECKIN；只支持捕获来源内的 HTTPS 请求。
 * 不缓存 once，不自动重试领取，领取后必须重新验证任务页。
 */
(function () {
  "use strict";

  const STORE_KEY = "V2EX_CHECKIN";
  const DEFAULT_ORIGIN = "https://www.v2ex.com";
  const TOTAL_TIMEOUT_MS = 45000;
  let finished = false;
  let origin = DEFAULT_ORIGIN;
  let requestCount = 0;
  const startedAt = Date.now();

  function finish(subtitle, body) {
    if (finished) return;
    finished = true;
    try {
      if (subtitle) {
        const status = subtitle + " · 账号 1";
        console.log("V2EX：" + status + "\n" + body);
        $notification.post("V2EX", status, body, {
          url: origin + "/mission/daily",
        });
      }
    } catch (_) {
      console.log("V2EX：通知发送失败，请查看脚本执行日志。");
    } finally {
      $done({});
    }
  }

  function failure(message) {
    const error = new Error(message);
    error.safeMessage = message;
    return error;
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(function (item) {
      return item.toLowerCase() === name.toLowerCase();
    });
    return key && typeof headers[key] === "string" ? headers[key] : "";
  }

  // JavaScriptCore 无需浏览器 URL / DOM API；只接受这两个明确的站点源。
  function siteUrl(value) {
    if (typeof value !== "string" || /[\s\\\u0000-\u001f]/.test(value)) return null;
    const match = /^https:\/\/(www\.v2ex\.com|v2ex\.com)(\/[^#]*)?(?:#.*)?$/i.exec(value);
    if (!match) return null;
    return { origin: "https://" + match[1].toLowerCase(), path: match[2] || "/" };
  }

  function sameOriginUrl(value) {
    if (typeof value !== "string") return null;
    const absolute = value.charAt(0) === "/" && value.charAt(1) !== "/"
      ? origin + value : value;
    const parsed = siteUrl(absolute);
    return parsed && parsed.origin === origin ? parsed : null;
  }

  function validCredential(value) {
    return value && (value.origin === DEFAULT_ORIGIN || value.origin === "https://v2ex.com") &&
      typeof value.cookie === "string" && value.cookie.length > 0 &&
      /(?:^|;\s*)A2=[^;\s]+/.test(value.cookie) &&
      typeof value.userAgent === "string" && value.userAgent.length > 0 &&
      !/[\r\n]/.test(value.cookie + value.userAgent);
  }

  function capture() {
    const parsed = siteUrl($request.url);
    if (!parsed || !/^\/(?:mission\/daily|settings)\/?(?:\?|$)/.test(parsed.path) ||
        ($request.method && $request.method.toUpperCase() !== "GET")) {
      finish();
      return;
    }
    const credentials = {
      origin: parsed.origin,
      cookie: header($request.headers, "Cookie"),
      userAgent: header($request.headers, "User-Agent"),
    };
    if (!validCredential(credentials)) {
      finish();
      return;
    }
    origin = parsed.origin;
    const encoded = JSON.stringify(credentials);
    if ($persistentStore.read(STORE_KEY) === encoded) {
      finish();
    } else if ($persistentStore.write(encoded, STORE_KEY)) {
      finish("Cookie 更新成功", "后续签到将使用最新登录信息");
    } else {
      finish("Cookie 更新失败", "原因：Surge 未能保存登录信息，请重新打开任务页");
    }
  }

  function decodeEntities(value) {
    return value.replace(/&(?:amp|quot|apos|lt|gt|#(?:x[0-9a-f]+|[0-9]+));/gi, function (entity) {
      const names = { "&amp;": "&", "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">" };
      const lower = entity.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(names, lower)) return names[lower];
      const hex = lower.charAt(2) === "x";
      const code = parseInt(lower.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
  }

  function visibleHtml(body) {
    return body.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  }

  function balanceText(body) {
    const area = /<a\b[^>]*\bclass=["'][^"']*\bbalance_area\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(visibleHtml(body));
    if (!area) return "当前余额：查询失败";
    const content = area[1].replace(/&nbsp;|&#160;/gi, " ");
    const pattern = /(-?[\d,]+)\s*<img\b([^>]+)>/gi;
    const units = { G: "金币", S: "银币", B: "铜币" };
    const parts = [];
    const seen = {};
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const alt = /\balt=["']([GSB])["']/i.exec(match[2]);
      const unit = alt && alt[1].toUpperCase();
      if (!unit || seen[unit] || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(match[1])) return "当前余额：查询失败";
      const value = Number(match[1].replace(/,/g, ""));
      if (!Number.isSafeInteger(value)) return "当前余额：查询失败";
      seen[unit] = true;
      parts.push(value + " " + units[unit]);
    }
    return parts.length ? "当前余额：" + parts.join("，") : "当前余额：查询失败";
  }

  function pageState(body) {
    if (typeof body !== "string" || !/<(?:html|div|form|input|a|title)\b/i.test(body)) return "invalid";
    if (/cf-chl-|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|验证您是真人|正在验证您的浏览器|checking your browser/i.test(body)) {
      return "challenge";
    }
    const content = visibleHtml(body);
    const text = decodeEntities(content.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    if (/每日登录奖励已领取|每日登入獎勵已領取|你已经领取过今天的登录奖励|你已經領取過今天的登入獎勵/.test(text)) return "done";
    if (/<form\b[^>]*action\s*=\s*["'](?:https:\/\/(?:www\.)?v2ex\.com)?\/signin(?:[?"'])/i.test(content) ||
        /<input\b[^>]*type\s*=\s*["']password["']/i.test(content) ||
        /(?:你需要|请先|需要先|請先)(?:登录|登入)/.test(text)) return "login";
    if (/href\s*=\s*["']\/signin["']/i.test(content) &&
        !/href\s*=\s*["']\/signout(?:[?"'])/i.test(content)) return "login";
    return "pending";
  }

  function claimUrl(body) {
    const tags = visibleHtml(body).match(/<(?:a|input|button)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const attributes = {};
      const matcher = /\b(href|onclick)\s*=\s*("[^"]*"|'[^']*')/gi;
      let match;
      while ((match = matcher.exec(tag)) !== null) {
        attributes[match[1].toLowerCase()] = decodeEntities(match[2].slice(1, -1));
      }
      const urls = [];
      if (attributes.href) urls.push(attributes.href);
      if (attributes.onclick) {
        const assignment = /(?:\bwindow\.)?\blocation(?:\.href)?\s*=\s*(['"])([^'"]+)\1/.exec(attributes.onclick);
        const assignCall = /(?:\bwindow\.)?\blocation\.(?:assign|replace)\(\s*(['"])([^'"]+)\1\s*\)/.exec(attributes.onclick);
        if (assignment) urls.push(assignment[2]);
        else if (assignCall) urls.push(assignCall[2]);
      }
      for (const url of urls) {
        const parsed = sameOriginUrl(url);
        if (!parsed || !/^\/mission\/daily\/redeem\?/.test(parsed.path)) continue;
        const query = parsed.path.slice(parsed.path.indexOf("?") + 1).split("&");
        const once = query.filter(function (part) { return part.split("=")[0] === "once"; });
        if (once.length === 1 && /^once=\d+$/.test(once[0])) return parsed.origin + parsed.path;
      }
    }
    return null;
  }

  function get(url, credentials) {
    return new Promise(function (resolve, reject) {
      if (finished) return;
      const parsed = sameOriginUrl(url);
      if (!parsed) { reject(failure("站点返回跨源地址，已停止请求以保护登录凭据。")); return; }
      if (++requestCount > 7) { reject(failure("请求次数超过限制，已停止执行。")); return; }
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) { reject(failure("执行超时，请检查网络后重新运行。")); return; }
      $httpClient.get({
        url: parsed.origin + parsed.path,
        headers: {
          Cookie: credentials.cookie,
          "User-Agent": credentials.userAgent,
          Referer: origin + "/mission/daily",
          Accept: "text/html,application/xhtml+xml",
          "Cache-Control": "no-cache",
        },
        timeout: Math.min(10, Math.max(1, Math.ceil(remaining / 1000))),
        "auto-redirect": false,
        "auto-cookie": false,
      }, function (error, response, body) {
        if (finished) return;
        if (error) { reject(failure("网络请求失败或超时；未自动重试领取，请重新检查任务页。")); return; }
        const status = Number(response && response.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          reject(failure("服务器未返回有效 HTTP 状态。"));
          return;
        }
        resolve({ status: status, headers: (response && response.headers) || {}, body: body });
      });
    });
  }

  async function fetchPage(url, credentials) {
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await get(url, credentials);
      if ([301, 302, 303, 307, 308].indexOf(response.status) !== -1) {
        const target = sameOriginUrl(header(response.headers, "Location"));
        if (!target) throw failure("服务器返回跨源或无效重定向，已停止请求以保护登录凭据。");
        if (/^\/signin(?:[/?]|$)/.test(target.path)) throw failure("尚未登录或登录已失效，请在浏览器登录后重新打开任务页。");
        // 重定向只允许回到任务页，绝不跟随重定向再次发出领取请求。
        if (!/^\/mission\/daily\/?(?:\?|$)/.test(target.path)) throw failure("服务器重定向至非任务页，未继续领取。");
        if (redirects === 2) throw failure("服务器重定向次数过多，已停止执行。");
        url = target.origin + target.path;
        continue;
      }
      if (pageState(response.body) === "challenge") throw failure("站点验证拦截了 Surge 请求，请在浏览器检查验证状态；本次未确认签到。");
      if (response.status === 401 || pageState(response.body) === "login") throw failure("尚未登录或登录已失效，请在浏览器登录后重新打开任务页。");
      if (response.status !== 200) throw failure("服务器返回 HTTP " + response.status + "，未确认签到。");
      return response.body;
    }
  }

  async function checkin() {
    let credentials;
    try { credentials = JSON.parse($persistentStore.read(STORE_KEY) || "null"); } catch (_) { /* 由统一校验报告 */ }
    if (!validCredential(credentials)) throw failure("缺少有效凭据，请在已登录的浏览器打开 V2EX 日常任务页以捕获 Cookie 和 User-Agent。");
    origin = credentials.origin;
    const dailyUrl = origin + "/mission/daily";
    const page = await fetchPage(dailyUrl, credentials);
    const state = pageState(page);
    if (state === "done") { finish("今日已签到", balanceText(page)); return; }
    if (state === "invalid") throw failure("任务页响应格式异常，未发出领取请求。");
    const redeemUrl = claimUrl(page);
    if (!redeemUrl) throw failure("未找到有效的每日奖励领取令牌，未发出领取请求；请检查任务页。");
    await fetchPage(redeemUrl, credentials);
    const verified = await fetchPage(dailyUrl, credentials);
    if (pageState(verified) !== "done") throw failure("领取后任务页未确认奖励已领取；本次结果未确认，未重复领取。");
    finish("签到成功", balanceText(verified));
  }

  if (typeof $request !== "undefined" && $request) {
    try { capture(); } catch (_) { finish("Cookie 更新失败", "原因：无法保存登录信息，请重新打开日常任务页"); }
    return;
  }
  setTimeout(function () {
    finish("签到失败", "原因：执行超时，未确认本次结果");
  }, TOTAL_TIMEOUT_MS);
  checkin().catch(function (error) {
    finish("签到失败", "原因：" + (error && error.safeMessage ? error.safeMessage : "脚本执行异常，请检查任务页"));
  });
})();
