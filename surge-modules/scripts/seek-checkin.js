/*
 * DeepFlood / NodeSeek 每日签到，原生 Surge Mac 脚本。
 * 接口及旧存储字段参考 Sliverkiss 的 NodeSeek、RerrentLinden 的 DeepFlood 脚本。
 * 此实现不依赖上游 Env、BoxJS 或其他运行时脚本。来源详见 ../SOURCES.md。
 */

(function () {
  "use strict";

  const sites = {
    deepflood: { name: "DeepFlood", host: "www.deepflood.com", key: "deepflood_data" },
    nodeseek: { name: "NodeSeek", host: "www.nodeseek.com", key: "nodeseek_data" }
  };
  const startedAt = Date.now();
  const totalBudgetMs = 150000;
  let site;
  let finished = false;

  function fail(message) {
    const error = new Error(message);
    error.isCheckinError = true;
    return error;
  }

  function report(subtitle, message) {
    const name = site ? site.name : "Seek 签到";
    console.log(name + "：" + subtitle + "；" + message);
    $notification.post(name, subtitle, message);
  }

  function finish() {
    if (!finished) {
      finished = true;
      $done({});
    }
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(function (key) {
      return key.toLowerCase() === name.toLowerCase();
    });
    return key ? String(headers[key]) : "";
  }

  function parseParameters(text) {
    const parameters = Object.create(null);
    for (const pair of String(text || "").split("&")) {
      if (!pair) continue;
      const index = pair.indexOf("=");
      if (index < 1) throw fail("参数格式错误，请检查模块参数。");
      let key;
      let value;
      try {
        key = decodeURIComponent(pair.slice(0, index));
        value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, " "));
      } catch (_) {
        throw fail("参数编码无效，请检查模块参数。");
      }
      if (Object.prototype.hasOwnProperty.call(parameters, key)) throw fail("参数重复，请检查模块参数。");
      parameters[key] = value;
    }
    return parameters;
  }

  function readAccounts() {
    const raw = $persistentStore.read(site.key);
    if (!raw) return [];
    let accounts;
    try { accounts = JSON.parse(raw); } catch (_) { throw fail("账号存储格式损坏；原始数据已保留。"); }
    if (!Array.isArray(accounts)) throw fail("账号存储必须为数组；原始数据已保留。");
    return accounts;
  }

  function isId(value) {
    return /^(?:[1-9]\d*)$/.test(String(value));
  }

  function validHeader(value) {
    return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
  }

  function classifyResponse(response, body) {
    const status = Number(response && (response.status || response.statusCode));
    const text = typeof body === "string" ? body : JSON.stringify(body || {});
    if (/cf-chl-|challenge-platform|<title[^>]*>\s*(?:just a moment|安全验证|人机验证)|验证您是人类|please complete the (?:captcha|security verification)/i.test(text)) {
      throw fail("站点验证拦截；请在浏览器完成站点验证后重试。");
    }
    if (status === 401) throw fail("登录失效，请重新打开个人账号设置获取凭据。");
    if (status >= 300 && status < 400) {
      const location = header(response.headers, "location");
      if (/\/(?:login|signin)(?:[/?#]|$)/i.test(location)) throw fail("登录失效，请重新获取凭据。");
      throw fail("收到重定向，已停止请求，未转发登录凭据。");
    }
    if (status === 403) throw fail("站点拒绝访问（HTTP 403），请检查站点验证和账号状态。");
    if (status === 429) throw fail("请求频率受限（HTTP 429），本次不重试。");
    if (status !== 200) throw fail("站点请求失败（HTTP " + (Number.isFinite(status) ? status : "未知") + "）。");
    let data;
    try { data = typeof body === "string" ? JSON.parse(body) : body; } catch (_) {
      if (/<(?:form|input)\b[^>]*(?:login|password)|<title>[^<]*(?:登录|login)/i.test(text)) {
        throw fail("登录失效，站点返回了登录页面。");
      }
      throw fail("响应格式异常，预期 JSON 却收到其他内容。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("响应格式异常，缺少业务数据。");
    const message = typeof data.message === "string" ? data.message : "";
    if (/captcha|安全验证|人机验证|challenge required/i.test(message)) throw fail("站点验证拦截，请在浏览器完成验证后重试。");
    if (/未登录|请.{0,4}登录|需(?:要)?登录|登录后|登录.{0,4}(?:失效|过期)|not\s+(?:logged|login)|unauthenticated|unauthorized|(?:invalid|expired).{0,12}(?:cookie|token|session)|(?:cookie|token|session).{0,12}(?:invalid|expired|过期|失效)/i.test(message)) {
      throw fail("登录失效，请重新打开个人账号设置获取凭据。");
    }
    return data;
  }

  function requestApi(account, method, path) {
    const remaining = totalBudgetMs - (Date.now() - startedAt);
    if (remaining < 1000) return Promise.reject(fail("已达到总运行时限，未发起更多签到请求。"));
    const timeout = Math.min(12, Math.floor(remaining / 1000));
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
        else {
          try { resolve(classifyResponse(response, body)); } catch (caught) { reject(caught); }
        }
      }
      const origin = "https://" + site.host;
      // 与官网 fetch(url, {method: 'POST'}) 保持一致：不添加正文或表单头。
      const headers = {
        Cookie: account.token,
        "User-Agent": account.userAgent,
        Referer: origin + "/board",
        Accept: "*/*",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty"
      };
      try {
        $httpClient[method]({
          url: origin + path,
          headers: headers,
          timeout: timeout,
          "auto-cookie": false,
          "auto-redirect": false
        }, function (error, response, body) {
          settle(error ? fail("网络请求失败；本次不自动重试。") : null, response, body);
        });
      } catch (_) {
        settle(fail("网络请求无法发起，请检查 Surge 脚本环境。"));
      }
    });
  }

  function readTodayRecord(data, account) {
    if (!Object.prototype.hasOwnProperty.call(data, "record") || !Array.isArray(data.list) ||
        !Number.isSafeInteger(data.order) || !Number.isSafeInteger(data.total) || data.total < 0 || data.success === false) {
      throw fail("签到状态响应格式异常，未发起领奖请求。");
    }
    if (data.record === null) return null;
    const record = data.record;
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        !Number.isSafeInteger(record.id) || record.id <= 0 ||
        !Number.isSafeInteger(record.day_id) || record.day_id <= 0 ||
        !Number.isSafeInteger(record.member_id) || String(record.member_id) !== String(account.userId) ||
        !Number.isSafeInteger(record.gain) || record.gain < 0 ||
        typeof record.created_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.created_at) ||
        !Number.isFinite(Date.parse(record.created_at))) {
      throw fail("今日签到记录不完整或账号不一致，未发起领奖请求。");
    }
    // record 的今日语义由服务器 board 接口定义，不将 day_id 换算为本机日期。
    return record;
  }

  function capture() {
    if (String($request.method || "GET").toUpperCase() !== "GET") return;
    const match = /^https:\/\/([^/?#]+)\/api\/account\/getInfo\/([1-9]\d*)\?([^#]*)$/.exec($request.url || "");
    if (!match || match[1] !== site.host) return;
    const query = parseParameters(match[3]);
    // 当前站点个人设置页发出 phone=1 请求；普通资料卡不能证明登录身份。
    if (query.phone !== "1") return;
    const referer = header($request.headers, "referer");
    // Surge 实际接收的 Referer 可能是本站 Service Worker，而非页面的 /setting。
    const captureReferer = new RegExp("^https://" + site.host.replace(/\./g, "\\.") +
      "/(?:setting/?(?:[?#].*)?|sw\\.js\\?v=\\d+(?:\\.\\d+)*)$");
    if (!captureReferer.test(referer)) return;
    const cookie = header($request.headers, "cookie");
    if (!validHeader(cookie)) throw fail("请求中缺少有效 Cookie，请先登录网站。");
    if (typeof $response === "undefined") throw fail("捕获需要账号信息响应，请检查模块类型。");
    const data = classifyResponse($response, $response.body);
    const detail = data.detail;
    if (data.success !== true || !detail || !Object.prototype.hasOwnProperty.call(detail, "phone") || !isId(detail.member_id) ||
        String(detail.member_id) !== match[2] || typeof detail.member_name !== "string" || !detail.member_name.trim()) {
      throw fail("账号信息不完整或身份不一致，已保留旧凭据。");
    }
    const userAgent = header($request.headers, "user-agent");
    if (!validHeader(userAgent)) throw fail("请求缺少浏览器 User-Agent，请刷新个人账号设置；旧凭据已保留。");
    const accounts = readAccounts();
    const index = accounts.findIndex(function (account) { return account && String(account.userId) === String(detail.member_id); });
    const previous = index >= 0 && accounts[index] && typeof accounts[index] === "object" ? accounts[index] : {};
    const updated = Object.assign({}, previous, {
      userId: detail.member_id, userName: detail.member_name, token: cookie,
      userAgent: userAgent
    });
    if (JSON.stringify(previous) === JSON.stringify(updated)) return;
    if (index >= 0) accounts[index] = updated;
    else accounts.push(updated);
    if (!$persistentStore.write(JSON.stringify(accounts), site.key)) throw fail("凭据保存失败，请检查 Surge 持久化存储。");
    report("凭据已更新", "已保存当前账号的 Cookie；现有其他账号和附加字段保持不变。");
  }

  async function checkin(parameters) {
    let mode = parameters.mode;
    if (mode === undefined) {
      const legacy = $persistentStore.read(parameters.site + "_default");
      if (legacy && legacy !== "true" && legacy !== "false") throw fail("旧签到模式无效，请在模块参数明确选择 fixed 或 random。");
      mode = legacy === "true" ? "random" : "fixed";
    }
    if (mode !== "fixed" && mode !== "random") throw fail("mode 仅支持 fixed（固定奖励）或 random（随机奖励）。");
    const accounts = readAccounts();
    if (!accounts.length) throw fail("缺少账号，请在已登录浏览器打开个人账号设置获取凭据。");
    for (let index = 0; index < accounts.length; index++) {
      if (Date.now() - startedAt >= totalBudgetMs - 1000) {
        report("达到运行时限", "剩余 " + (accounts.length - index) + " 个账号未执行，请稍后重试。");
        break;
      }
      const label = "账号 " + (index + 1);
      const account = accounts[index];
      try {
        if (!account || !isId(account.userId) || !validHeader(account.token)) throw fail("账号记录缺少有效身份或 Cookie，请重新捕获。");
        if (!validHeader(account.userAgent)) throw fail("缺少浏览器 User-Agent，请重新打开个人账号设置获取；旧 Cookie 已保留。");
        const board = await requestApi(account, "get", "/api/attendance/board?page=1");
        const record = readTodayRecord(board, account);
        if (record !== null) {
          report(label + "：今日已签到", "服务器今日记录确认已领取 " + record.gain + " 个鸡腿。");
          continue;
        }
        const data = await requestApi(account, "post", "/api/attendance?random=" + (mode === "random" ? "true" : "false"));
        const message = typeof data.message === "string" ? data.message : "";
        if (/(?:今日|今天).{0,12}已.{0,8}签|已经签|已签到|重复签到|already.{0,20}(?:check|sign|attend)/i.test(message)) {
          report(label + "：今日已签到", "服务器确认今日奖励已领取。");
        } else if (data.success === true && (
          /^今天的签到收益是\d+个鸡腿[。！!]?$/u.test(message) ||
          /签到成功|成功签到|获得.{0,12}(?:鸡腿|硬币|积分)|check.?in.{0,10}success|success.{0,10}check.?in/i.test(message) ||
          (Number.isSafeInteger(data.gain) && data.gain >= 0 && Number.isSafeInteger(data.current) && data.current >= 0))) {
          report(label + "：签到成功", "服务器确认奖励领取成功；模式：" + (mode === "random" ? "随机" : "固定") + "。");
        } else if (data.success === false) {
          throw fail("服务器未确认签到成功，请在网站检查账号状态。");
        } else {
          throw fail("响应格式异常，缺少明确的签到业务结果。");
        }
      } catch (error) {
        report(label + "：签到失败", error && error.isCheckinError ? error.message : "脚本执行异常；凭据未写入日志。");
      }
    }
  }

  (async function () {
    const parameters = parseParameters(typeof $argument === "string" ? $argument : "");
    if (!Object.prototype.hasOwnProperty.call(sites, parameters.site)) throw fail("site 仅支持 deepflood 或 nodeseek。");
    site = sites[parameters.site];
    if (typeof $request !== "undefined") capture();
    else await checkin(parameters);
  })().catch(function (error) {
    report("执行失败", error && error.isCheckinError ? error.message : "脚本执行异常；凭据未写入日志。");
  }).finally(finish);
})();
