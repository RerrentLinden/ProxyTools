"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { runScript } = require("./helpers/surge-harness");

const SCRIPT = path.join(__dirname, "../surge-modules/scripts/v2ex.js");
const ORIGIN = "https://www.v2ex.com";
const DAILY = ORIGIN + "/mission/daily";
const COOKIE = "A2=synthetic-account-secret; PB3_SESSION=synthetic-session-secret";
const USER_AGENT = "Synthetic browser agent/1.0";
const CREDENTIALS = { origin: ORIGIN, cookie: COOKIE, userAgent: USER_AGENT };
const DONE = '<html><a href="/signout?once=123">登出</a><div>每日登录奖励已领取</div></html>';
const LOGIN = '<html><form action="/signin"><input type="password" name="synthetic"></form></html>';
const CHALLENGE = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script></html>';

function pending(once = "918273") {
  return '<html><a href="/signout?once=123">登出</a><h1>每日登录奖励 20260906</h1>' +
    '<div>已连续登录 15 天</div><input type="button" onclick="location.href = ' +
    "'/mission/daily/redeem?once=" + once + "';\" value=\"领取 X 铜币\"></html>";
}

function store() {
  return { V2EX_CHECKIN: JSON.stringify(CREDENTIALS), unrelated: "保留" };
}

function output(result) {
  return JSON.stringify({ logs: result.logs, notifications: result.notifications });
}

function checkResult(result) {
  assert.equal(result.doneCount, 1);
  assert.doesNotMatch(output(result), /synthetic-account-secret|synthetic-session-secret|once=[0-9]+/);
  for (const request of result.requests) {
    assert.equal(request.method, "get");
    assert.equal(request.headers.Cookie, COOKIE);
    assert.equal(request.headers["User-Agent"], USER_AGENT);
    assert.equal(request["auto-redirect"], false);
    assert.equal(request["auto-cookie"], false);
    assert.ok(request.timeout > 0 && request.timeout <= 10, "HTTP 超时使用秒且上限为 10");
  }
}

test("直接从已确认任务页显示金币银币铜币，不额外请求余额接口", async () => {
  const balance = '<a href="/balance" class="balance_area">1 <img alt="G" />57 <img alt="S" />47 <img alt="B" /></a>';
  const result = await runScript(SCRIPT, { store: store(), http: () => ({ body: DONE + balance }) });
  checkResult(result);
  assert.match(output(result), /当前余额：1 金币，57 银币，47 铜币/);
  assert.equal(result.requests.length, 1);
});

test("领取成功使用最后一次核验页的新余额", async () => {
  const oldBalance = '<a href="/balance" class="balance_area">10 <img alt="B" /></a>';
  const newBalance = '<a href="/balance" class="balance_area">20 <img alt="B" /></a>';
  const result = await runScript(SCRIPT, {
    store: store(),
    http: (_method, _request, index) => ({ body: index === 0 ? pending() + oldBalance : index === 1 ? DONE : DONE + newBalance }),
  });
  checkResult(result);
  assert.match(output(result), /签到成功/);
  assert.match(output(result), /当前余额：20 铜币/);
  assert.doesNotMatch(output(result), /当前余额：10 铜币/);
  assert.equal(result.requests.length, 3);
});

test("V2EX 真正的零余额与缺失余额区分显示", async () => {
  for (const [page, expected] of [
    [DONE + '<a class="balance_area" href="/balance">0 <img alt="B" /></a>', /当前余额：0 铜币/],
    [DONE, /当前余额：查询失败/],
  ]) {
    const result = await runScript(SCRIPT, { store: store(), http: () => ({ body: page }) });
    checkResult(result);
    assert.match(output(result), expected);
  }
});

test("通知 API 抛出异常仍只结束一次，已领取结果不受影响且不泄露底层错误", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: () => ({ body: DONE }),
    notificationError: COOKIE,
  });
  assert.equal(result.requests.length, 1);
  assert.match(output(result), /今日已签到/);
  assert.equal(result.notifications.length, 0);
  checkResult(result);
});

test("捕获普通 GET 请求的 Cookie 和对应 User-Agent，保留其他存储", async () => {
  const initial = { unrelated: "保留" };
  const result = await runScript(SCRIPT, {
    store: initial,
    request: {
      url: DAILY + "?source=test",
      method: "GET",
      headers: { cOoKiE: COOKIE, "uSeR-aGeNt": USER_AGENT },
    },
  });
  assert.deepEqual(JSON.parse(result.store.V2EX_CHECKIN), CREDENTIALS);
  assert.equal(result.store.unrelated, "保留");
  assert.equal(result.requests.length, 0);
  assert.match(output(result), /Cookie 更新成功/);
  checkResult(result);
});

test("相同凭据重复捕获不重复通知", async () => {
  const result = await runScript(SCRIPT, {
    store: store(),
    request: { url: DAILY, headers: { Cookie: COOKIE, "User-Agent": USER_AGENT } },
  });
  assert.equal(result.notifications.length, 0);
  checkResult(result);
});

for (const [name, request] of [
  ["外部域名", { url: "https://v2ex.com.attacker.invalid/mission/daily" }],
  ["非 HTTPS", { url: "http://www.v2ex.com/mission/daily" }],
  ["非目标路径", { url: ORIGIN + "/t/1234" }],
  ["领取请求", { url: ORIGIN + "/mission/daily/redeem?once=123" }],
  ["非 GET", { url: DAILY, method: "POST" }],
  ["匿名 Cookie", { url: DAILY, headers: { Cookie: "theme=dark", "User-Agent": USER_AGENT } }],
  ["缺少 User-Agent", { url: DAILY, headers: { Cookie: COOKIE } }],
  ["空 A2", { url: DAILY, headers: { Cookie: "A2=; PB3_SESSION=test", "User-Agent": USER_AGENT } }],
]) {
  test("捕获忽略" + name + "且不覆盖已存凭据", async () => {
    const existing = store();
    const result = await runScript(SCRIPT, {
      store: existing,
      request: { headers: { Cookie: COOKIE, "User-Agent": USER_AGENT }, ...request },
    });
    assert.deepEqual(result.store, store());
    assert.equal(result.notifications.length, 0);
    assert.equal(result.requests.length, 0);
    checkResult(result);
  });
}

test("缺少凭据时不访问服务器", async () => {
  const result = await runScript(SCRIPT);
  assert.equal(result.requests.length, 0);
  assert.match(output(result), /缺少有效凭据/);
  checkResult(result);
});

for (const invalid of ["not-json", "null", '{"origin":"https://evil.invalid","cookie":"A2=test","userAgent":"test"}']) {
  test("拒绝损坏或跨源的存储凭据：" + invalid.slice(0, 12), async () => {
    const result = await runScript(SCRIPT, { store: { V2EX_CHECKIN: invalid } });
    assert.equal(result.requests.length, 0);
    assert.match(output(result), /缺少有效凭据/);
    checkResult(result);
  });
}

test("服务器已完成时只查询一次且不领取", async () => {
  const result = await runScript(SCRIPT, { store: store(), http: () => ({ body: DONE }) });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, DAILY);
  assert.match(output(result), /今日已签到/);
  checkResult(result);
});

test("从真实 onclick 结构提取新的 once，领取后再次读取任务页", async () => {
  const responses = [pending("112233"), DONE, DONE];
  const result = await runScript(SCRIPT, {
    store: store(),
    http: (_method, _options, index) => ({ body: responses[index] }),
  });
  assert.deepEqual(result.requests.map((item) => item.url), [
    DAILY, ORIGIN + "/mission/daily/redeem?once=112233", DAILY,
  ]);
  assert.equal(result.store.V2EX_CHECKIN, JSON.stringify(CREDENTIALS), "临时 once 不进入持久化存储");
  assert.match(output(result), /签到成功/);
  assert.doesNotMatch(output(result), /112233/);
  checkResult(result);
});

test("支持 HTML 实体编码的 onclick 和查询参数", async () => {
  const encoded = '<html><input onclick="location.href = &#39;/mission/daily/redeem?once=456789&amp;lang=zh&#39;" /></html>';
  const result = await runScript(SCRIPT, {
    store: store(), http: (_method, _options, index) => ({ body: index === 0 ? encoded : DONE }),
  });
  assert.equal(result.requests[1].url, ORIGIN + "/mission/daily/redeem?once=456789&lang=zh");
  assert.match(output(result), /签到成功/);
  checkResult(result);
});

test("支持同源绝对 href", async () => {
  const page = '<html><a href="https://www.v2ex.com/mission/daily/redeem?once=3456">领取奖励</a></html>';
  const result = await runScript(SCRIPT, {
    store: store(), http: (_method, _options, index) => ({ body: index === 0 ? page : DONE }),
  });
  assert.equal(result.requests[1].url, ORIGIN + "/mission/daily/redeem?once=3456");
  assert.match(output(result), /签到成功/);
  checkResult(result);
});

for (const [name, body, expected] of [
  ["未登录", LOGIN, /尚未登录或登录已失效/],
  ["验证拦截", CHALLENGE, /站点验证拦截/],
  ["非 HTML", "{\"ok\":true}", /响应格式异常/],
  ["缺少令牌", '<html><div>已连续登录 15 天</div></html>', /未找到有效.*令牌/],
  ["重复 once 参数", '<html><a href="/mission/daily/redeem?once=123&once=456">领取</a></html>', /未找到有效.*令牌/],
  ["外部领取地址", '<html><input onclick="location.href=\'https://evil.invalid/mission/daily/redeem?once=1\'" /></html>', /未找到有效.*令牌/],
  ["协议相对地址", '<html><a href="//evil.invalid/mission/daily/redeem?once=1">领取</a></html>', /未找到有效.*令牌/],
  ["注释中的领取链接", '<html><!-- <a href="/mission/daily/redeem?once=1">领取</a> --></html>', /未找到有效.*令牌/],
]) {
  test(name + "不会当作签到成功", async () => {
    const result = await runScript(SCRIPT, { store: store(), http: () => ({ body }) });
    assert.equal(result.requests.length, 1);
    assert.match(output(result), expected);
    assert.doesNotMatch(output(result), /签到成功|今日已签到/);
    checkResult(result);
  });
}

test("领取返回 200 仍必须核验；未完成时不重复领取", async () => {
  const result = await runScript(SCRIPT, { store: store(), http: () => ({ body: pending() }) });
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests.filter((item) => item.url.includes("/redeem?")).length, 1);
  assert.match(output(result), /领取后任务页未确认/);
  assert.doesNotMatch(output(result), /签到成功|今日已签到/);
  checkResult(result);
});

test("领取响应声称成功但重新查询仍未完成时拒绝成功", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: (_method, _options, index) => ({ body: index === 1 ? DONE : pending() }),
  });
  assert.equal(result.requests.length, 3);
  assert.match(output(result), /领取后任务页未确认/);
  assert.doesNotMatch(output(result), /签到成功/);
  checkResult(result);
});

test("顺序重复运行根据服务端已领取状态跳过领取", async () => {
  let claimed = false;
  let claims = 0;
  const http = (_method, options) => {
    if (options.url.includes("/redeem?")) { claims++; claimed = true; }
    return { body: claimed ? DONE : pending() };
  };
  const credentials = store();
  const first = await runScript(SCRIPT, { store: credentials, http });
  const second = await runScript(SCRIPT, { store: credentials, http });
  assert.equal(claims, 1);
  assert.match(output(first), /签到成功/);
  assert.match(output(second), /今日已签到/);
  assert.equal(second.requests.length, 1);
  checkResult(first);
  checkResult(second);
});

for (const [name, target, expected] of [
  ["跨源重定向", "https://evil.invalid/mission/daily", /跨源或无效重定向/],
  ["登录重定向", "/signin?next=/mission/daily", /尚未登录或登录已失效/],
  ["再次领取重定向", "/mission/daily/redeem?once=9999", /非任务页/],
]) {
  test("拒绝" + name + "且不转发 Cookie", async () => {
    const result = await runScript(SCRIPT, {
      store: store(), http: () => ({ status: 302, headers: { location: target } }),
    });
    assert.equal(result.requests.length, 1);
    assert.match(output(result), expected);
    checkResult(result);
  });
}

test("领取后的同源任务页重定向可处理，仍独立核验任务页", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: (_method, _options, index) => {
      if (index === 0) return { body: pending() };
      if (index === 1) return { status: 302, headers: { Location: "/mission/daily" } };
      return { body: DONE };
    },
  });
  assert.equal(result.requests.length, 4);
  assert.equal(result.requests.filter((item) => item.url.includes("/redeem?")).length, 1);
  assert.match(output(result), /签到成功/);
  checkResult(result);
});

test("重定向循环有次数上限", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: () => ({ status: 302, headers: { Location: DAILY } }),
  });
  assert.equal(result.requests.length, 3);
  assert.match(output(result), /重定向次数过多/);
  checkResult(result);
});

for (const status of [401, 403, 429, 500]) {
  test("HTTP " + status + " 不冒充成功", async () => {
    const result = await runScript(SCRIPT, { store: store(), http: () => ({ status, body: "失败" }) });
    assert.equal(result.requests.length, 1);
    assert.doesNotMatch(output(result), /签到成功|今日已签到/);
    assert.match(output(result), status === 401 ? /尚未登录/ : new RegExp("HTTP " + status));
    checkResult(result);
  });
}

test("网络错误和超时不泄露底层错误中的 Cookie 或 once", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: () => ({ error: "timeout: " + COOKIE + " once=918273" }),
  });
  assert.equal(result.requests.length, 1);
  assert.match(output(result), /网络请求失败或超时/);
  checkResult(result);
});

test("领取超时只发出一次领取请求且不声称完成", async () => {
  const result = await runScript(SCRIPT, {
    store: store(), http: (_method, _options, index) => index === 0 ? { body: pending() } : { error: "timeout" },
  });
  assert.equal(result.requests.length, 2);
  assert.match(output(result), /未自动重试领取/);
  assert.doesNotMatch(output(result), /签到成功/);
  checkResult(result);
});
