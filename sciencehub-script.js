/*
 * 科研通每日签到，原生 Surge Mac 脚本。
 * 接口与 sciencehubCookie 旧字段参考本仓库 sciencehub-script.js、imoki/sign_script。
 * 重新实现请求、浏览器 Cookie 捕获与业务判定，无外部运行时依赖。
 */
(function () {
  "use strict";

  const name = "科研通";
  const origin = "https://www.ablesci.com";
  const identityName = "_identity-frontend";
  const cookieKey = "sciencehubCookie";
  const headerKey = "sciencehubCookieHeader";
  const userAgentKey = "sciencehubUserAgent";
  const requestTimeoutSeconds = 12;
  let finished = false;

  function fail(message) {
    const error = new Error(message);
    error.isCheckinError = true;
    return error;
  }

  function report(subtitle, body) {
    const status = subtitle + " · 账号 1";
    console.log(name + "：" + status + "\n" + body);
    try { $notification.post(name, status, body); }
    catch (_) { console.log(name + "：通知发送失败"); }
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(function (key) {
      return key.toLowerCase() === name.toLowerCase();
    });
    return key ? String(headers[key]) : "";
  }

  function validHeader(value) {
    return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
  }

  function identityFromCookie(cookie) {
    const match = /(?:^|;\s*)_identity-frontend=([^;]*)/.exec(cookie || "");
    if (!match || !match[1] || /^(?:deleted|null|undefined)$/i.test(match[1])) return "";
    return match[1];
  }

  function inspectResponse(response, body) {
    const status = Number(response && (response.status || response.statusCode));
    const text = typeof body === "string" ? body : JSON.stringify(body || {});
    if (/cf-chl-|challenge-platform|<title[^>]*>\s*(?:just a moment|安全验证|人机验证)|验证您是人类|please complete the (?:captcha|security verification)/i.test(text)) {
      throw fail("站点验证拦截，请在浏览器完成验证后重试。");
    }
    if (status === 401) throw fail("登录失效，请重新登录科研通并打开主页。");
    if (status >= 300 && status < 400) {
      const location = header(response.headers, "location");
      if (/\/(?:login|signin)|\/(?:site|user)\/login/i.test(location)) throw fail("登录失效，站点要求重新登录。");
      throw fail("收到重定向，已停止请求，未转发登录凭据。");
    }
    if (status === 403) throw fail("站点拒绝访问（HTTP 403），请检查站点验证和账号状态。");
    if (status === 429) throw fail("请求频率受限（HTTP 429），本次不重试。");
    if (status !== 200) throw fail("站点请求失败（HTTP " + (Number.isFinite(status) ? status : "未知") + "）。");
    return text;
  }

  function capture() {
    if (String($request.method || "GET").toUpperCase() !== "GET") return;
    if (!/^https:\/\/www\.ablesci\.com\/(?:\?[^#]*|user(?:\/[^?#]*)?(?:\?[^#]*)?)?$/.test($request.url || "")) return;
    const cookie = header($request.headers, "cookie");
    const identity = identityFromCookie(cookie);
    if (!validHeader(cookie) || !identity) return;
    if (typeof $response === "undefined") throw fail("捕获需要网页响应，请检查模块类型。");
    const body = inspectResponse($response, $response.body);
    // 已登录主页也可能包含隐藏登录组件；只拒绝明确的登录页标题。
    if (/<title>\s*(?:登录|用户登录|login|sign in)/i.test(body)) throw fail("当前页面需要重新登录，已保留旧凭据。");
    const previous = $persistentStore.read(cookieKey);
    const previousHeader = $persistentStore.read(headerKey);
    const userAgent = header($request.headers, "user-agent");
    // 保留旧入口所需的裸 identity 值，完整 Cookie 和浏览器 UA 另存。
    if (previous !== identity && !$persistentStore.write(identity, cookieKey)) throw fail("凭据保存失败，请检查 Surge 持久化存储。");
    if (previousHeader !== cookie && !$persistentStore.write(cookie, headerKey)) throw fail("完整 Cookie 保存失败，请重新打开主页。");
    if (validHeader(userAgent) && $persistentStore.read(userAgentKey) !== userAgent && !$persistentStore.write(userAgent, userAgentKey)) {
      throw fail("浏览器信息保存失败，请重新打开主页。");
    }
    if (previous !== identity || previousHeader !== cookie) report("Cookie 更新成功", "后续签到将使用最新登录信息");
  }

  function readCookie() {
    const stored = $persistentStore.read(cookieKey);
    if (!validHeader(stored)) throw fail("缺少 Cookie，请在已登录浏览器打开科研通主页。");
    // 旧版保存裸 identity；也接受已迁移为完整 Cookie 的同名值。
    const identity = identityFromCookie(stored) || (stored.indexOf(";") < 0 && stored.indexOf(identityName + "=") !== 0 ? stored : "");
    if (!identity || /^(?:deleted|null|undefined)$/i.test(identity)) throw fail("Cookie 格式无效，请重新打开科研通主页获取。");
    const full = $persistentStore.read(headerKey);
    if (validHeader(full) && identityFromCookie(full) === identity) return full;
    if (identityFromCookie(stored)) return stored;
    return identityName + "=" + identity;
  }

  function requestPage(cookie, path) {
    const timeout = path === "/" ? 8 : requestTimeoutSeconds;
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        settle(fail("网络请求超时；本次不自动重试。"));
      }, timeout * 1000);
      function settle(error, response, body) {
        if (settled) return;
        settled = true;
        if (typeof clearTimeout === "function") clearTimeout(timer);
        if (error) reject(error);
        else resolve({ response: response, body: body });
      }
      const headers = {
        Cookie: cookie,
        Accept: path === "/" ? "text/html" : "application/json, */*",
        Referer: origin + "/"
      };
      if (path !== "/") headers["X-Requested-With"] = "XMLHttpRequest";
      const userAgent = $persistentStore.read(userAgentKey);
      if (validHeader(userAgent)) headers["User-Agent"] = userAgent;
      try {
        $httpClient.get({ url: origin + path, headers: headers, timeout: timeout, "auto-redirect": false, "auto-cookie": false }, function (error, response, body) {
          settle(error ? fail("网络请求失败；签到结果未知，本次不自动重试。") : null, response, body);
        });
      } catch (_) {
        settle(fail("网络请求无法发起，请检查 Surge 脚本环境。"));
      }
    });
  }

  async function balanceText(cookie) {
    try {
      const result = await requestPage(cookie, "/");
      const page = inspectResponse(result.response, result.body);
      const match = /<cite\b[^>]*\bid=["']user-point-now["'][^>]*>\s*(-?[\d,]+)\s*<\/cite>/i.exec(page);
      if (!match || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(match[1])) throw fail("积分余额格式异常。");
      const points = Number(match[1].replace(/,/g, ""));
      if (!Number.isSafeInteger(points)) throw fail("积分余额无效。");
      return "当前余额：" + points + " 积分";
    } catch (_) {
      return "当前余额：查询失败";
    }
  }

  async function checkin() {
    const cookie = readCookie();
    const result = await requestPage(cookie, "/user/sign");
    const body = inspectResponse(result.response, result.body);
    let data;
    try { data = JSON.parse(body); } catch (_) {
      if (/<(?:form|input)\b[^>]*(?:login|password)|<title>[^<]*(?:登录|login)/i.test(body)) throw fail("登录失效，站点返回了登录页面。");
      throw fail("响应格式异常，预期 JSON 却收到其他内容。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("响应格式异常，缺少业务数据。");
    const message = typeof data.msg === "string" ? data.msg : "";
    if (/captcha|安全验证|人机验证|challenge required/i.test(message)) throw fail("站点验证拦截，请在浏览器完成验证后重试。");
    if (/未登录|请.{0,4}登录|需(?:要)?登录|登录后|登录.{0,4}(?:失效|过期)|not\s+(?:logged|login)|unauthenticated|unauthorized|(?:invalid|expired).{0,12}(?:cookie|token|session)|(?:cookie|token|session).{0,12}(?:invalid|expired|过期|失效)/i.test(message)) {
      throw fail("登录失效，请重新登录科研通并打开主页。");
    }
    if (data.code === 1 && /(?:今日|今天).{0,12}已(?:于\s*\[?\d{2}:\d{2}:\d{2}\]?\s*|.{0,8})签|已经签|已签到|重复签到|already.{0,20}(?:check|sign)/i.test(message)) {
      report("今日已签到", await balanceText(cookie));
    } else if (data.code === 0) {
      const detail = data.data;
      if (!detail || !/^(?:0|[1-9]\d*)$/.test(String(detail.signpoint)) ||
          !/^[1-9]\d*$/.test(String(detail.signcount)) ||
          !Number.isSafeInteger(Number(detail.signpoint)) || !Number.isSafeInteger(Number(detail.signcount))) {
        throw fail("响应格式异常，签到结果缺少有效的积分或连续签到天数。");
      }
      report("签到成功", await balanceText(cookie) + "\n本次获得：" + Number(detail.signpoint) + " 积分\n连续签到：" + Number(detail.signcount) + " 天");
    } else {
      throw fail("服务器未确认签到成功，请在网站检查账号状态。");
    }
  }

  (async function () {
    if (typeof $request !== "undefined") capture();
    else await checkin();
  })().catch(function (error) {
    report(typeof $request !== "undefined" ? "Cookie 更新失败" : "签到失败", "原因：" + (error && error.isCheckinError ? error.message : "脚本执行异常"));
  }).finally(function () {
    if (!finished) {
      finished = true;
      $done({});
    }
  });
})();
