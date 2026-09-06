"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runScript } = require("./helpers/surge-harness");
const script = path.join(__dirname, "../surge-modules/scripts/sciencehub.js");
const identity = "synthetic-science-identity";
const fullCookie = "PHPSESSID=synthetic-session; _identity-frontend=" + identity + "; _csrf-frontend=synthetic-csrf";

function output(result) {
  assert.equal(result.doneCount, 1);
  const text = JSON.stringify([result.logs, result.notifications]);
  for (const secret of [identity, "synthetic-session", "synthetic-csrf"]) assert.ok(!text.includes(secret));
  return text;
}

function cron(response, extra = {}) {
  return runScript(script, { store: { sciencehubCookie: identity }, http: () => response, ...extra });
}

function captureOptions(extra = {}) {
  return {
    request: { method: "GET", url: "https://www.ablesci.com/", headers: { cOoKiE: fullCookie, "User-AGENT": "SyntheticBrowser/1" } },
    response: { status: 200, headers: {}, body: '<html><title>科研通</title><cite id="sign-count">10</cite></html>' },
    ...extra,
  };
}

test("Surge 不提供 clearTimeout 时网络成功和失败都结束一次", async () => {
  for (const [response, expected] of [
    [{ body: { code: 0, data: { signpoint: 10, signcount: 3 } } }, /签到成功/],
    [{ error: identity }, /网络请求失败/],
  ]) {
    const result = await cron(response, { omitClearTimeout: true });
    assert.match(output(result), expected);
    assert.equal(result.requests.length, 1);
  }
});

test("正常主页请求捕获 Cookie，无需响应 Set-Cookie，并保留旧 identity 格式", async () => {
  const store = { unrelated: "preserved" };
  const result = await runScript(script, captureOptions({ store }));
  assert.match(output(result), /凭据已保存/);
  assert.equal(store.sciencehubCookie, identity);
  assert.equal(store.sciencehubCookieHeader, fullCookie);
  assert.equal(store.sciencehubUserAgent, "SyntheticBrowser/1");
  assert.equal(store.unrelated, "preserved");
  assert.equal(result.requests.length, 0);
});

test("相同 Cookie 重复浏览主页不产生重复通知", async () => {
  const store = { sciencehubCookie: identity, sciencehubCookieHeader: fullCookie, sciencehubUserAgent: "SyntheticBrowser/1" };
  const result = await runScript(script, captureOptions({ store }));
  output(result);
  assert.equal(result.notifications.length, 0);
});

test("错误域名、缺失 identity、登录页与验证拦截都保留旧凭据", async () => {
  const base = captureOptions();
  const cases = [
    { request: { ...base.request, url: "https://www.ablesci.com.evil.test/" } },
    { request: { ...base.request, headers: { Cookie: "PHPSESSID=anonymous" } } },
    { request: { ...base.request, headers: { Cookie: "_identity-frontend=deleted" } } },
    { request: { ...base.request, method: "OPTIONS" } },
    { response: { status: 200, body: "<title>用户登录 - 科研通</title>" } },
    { response: { status: 200, body: "<title>Just a moment...</title>" } },
    { response: { status: 403, body: "Forbidden" } },
  ];
  for (const change of cases) {
    const store = { sciencehubCookie: "old-identity", sciencehubCookieHeader: "_identity-frontend=old-identity" };
    const before = JSON.stringify(store);
    const result = await runScript(script, { ...base, ...change, store });
    output(result);
    assert.equal(JSON.stringify(store), before);
  }
});

test("旧裸值凭据可直接签到，HTTP 超时单位为秒且关闭自动重定向", async () => {
  const result = await cron({ body: { code: 0, data: { signpoint: 10, signcount: 3 } } });
  assert.match(output(result), /签到成功/);
  assert.match(output(result), /获得 10 积分/);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0];
  assert.equal(request.method, "get");
  assert.equal(request.url, "https://www.ablesci.com/user/sign");
  assert.equal(request.headers.Cookie, "_identity-frontend=" + identity);
  assert.equal(request.timeout, 12);
  assert.equal(request["auto-redirect"], false);
});

test("新捕获的完整 Cookie 与 UA 用于 Surge 原生签到", async () => {
  const result = await cron({ body: { code: 0, data: { signpoint: "10", signcount: "3" } } }, {
    store: { sciencehubCookie: identity, sciencehubCookieHeader: fullCookie, sciencehubUserAgent: "SyntheticBrowser/1" },
  });
  assert.match(output(result), /签到成功/);
  assert.equal(result.requests[0].headers.Cookie, fullCookie);
  assert.equal(result.requests[0].headers["User-Agent"], "SyntheticBrowser/1");
});

test("完整 Cookie 必须与旧 identity 一致，避免使用另一账号的会话", async () => {
  const result = await cron({ body: { code: 1, msg: "今天已签到" } }, {
    store: { sciencehubCookie: identity, sciencehubCookieHeader: "PHPSESSID=other; _identity-frontend=other-identity" },
  });
  output(result);
  assert.equal(result.requests[0].headers.Cookie, "_identity-frontend=" + identity);
});

test("code 1 只有明确已签到文案才判定重复，不把业务错误或未登录视为完成", async () => {
  for (const [msg, expected] of [["您今天已经签到过了", /今日已签到/], ["签到失败，您今天已于 [00:04:58] 签到。", /今日已签到/], ["请先登录", /登录失效/], ["请求异常", /未确认签到成功/]]) {
    const result = await cron({ status: 200, body: { code: 1, msg } });
    assert.match(output(result), expected);
    assert.equal(result.requests.length, 1);
  }
});

test("空 JSON、缺少积分字段、异常天数与 HTML 不被当作签到成功", async () => {
  for (const body of [{}, { code: 0 }, { code: 0, data: {} }, { code: 0, data: { signpoint: null, signcount: 2 } }, { code: 0, data: { signpoint: false, signcount: true } }, { code: 0, data: { signpoint: 1, signcount: 0 } }, "<html>普通页面</html>", "null"]) {
    const result = await cron({ status: 200, body });
    const text = output(result);
    assert.match(text, /执行失败/);
    assert.equal(result.requests.length, 1);
  }
});

test("缺少 Cookie 或包含换行的凭据不发起请求", async () => {
  for (const store of [{}, { sciencehubCookie: "" }, { sciencehubCookie: "deleted" }, { sciencehubCookie: "bad\r\nheader" }]) {
    const result = await runScript(script, { store });
    assert.match(output(result), /执行失败/);
    assert.equal(result.requests.length, 0);
  }
});

test("网络、HTTP、登录和站点验证错误明确分类，不泄露响应里的凭据", async () => {
  const cases = [
    [{ error: "request failed " + identity }, /网络请求失败/],
    [{ status: 401, body: "" }, /登录失效/],
    [{ status: 403, body: "Forbidden" }, /拒绝访问/],
    [{ status: 429, body: "" }, /频率受限/],
    [{ status: 503, body: "" }, /HTTP 503/],
    [{ status: 302, headers: { LoCaTiOn: "/user/login" } }, /登录失效/],
    [{ status: 302, headers: { Location: "https://evil.test/" } }, /未转发登录凭据/],
    [{ status: 200, body: "<title>登录 - 科研通</title>" }, /登录失效/],
    [{ status: 200, body: "<title>Just a moment...</title>" }, /验证拦截/],
    [{ status: 200, body: { code: 2, msg: identity } }, /未确认签到成功/],
  ];
  for (const [response, expected] of cases) {
    const result = await cron(response);
    assert.match(output(result), expected);
    assert.equal(result.requests.length, 1);
    assert.equal(result.store.sciencehubCookie, identity);
  }
});

test("HTTP 客户端不回调时仍在秒级期限结束一次", { timeout: 15000 }, async () => {
  const result = await cron(null, { http: () => new Promise(() => {}), timeoutMs: 14000 });
  assert.match(output(result), /网络请求超时/);
  assert.equal(result.requests.length, 1);
});
