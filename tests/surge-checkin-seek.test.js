"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runScript } = require("./helpers/surge-harness");
const script = path.join(__dirname, "../surge-modules/scripts/seek-checkin.js");
const token = "session=synthetic-seek-secret; cf_clearance=synthetic-clearance";
const account = {
  userId: 123, userName: "测试账号", token,
  userAgent: "SyntheticBrowser/1",
};

function output(result) {
  assert.equal(result.doneCount, 1);
  const text = JSON.stringify([result.logs, result.notifications]);
  assert.ok(!text.includes("synthetic-seek-secret"));
  assert.ok(!text.includes("synthetic-clearance"));
  for (const request of result.requests) {
    assert.equal(Object.hasOwn(request, "body"), false);
    assert.ok(!Object.keys(request.headers).some((name) => /^(?:content-type|refract-)/i.test(name)));
    if (request.method === "post") assert.equal(request.headers.Origin, new URL(request.url).origin);
    else assert.equal(Object.hasOwn(request.headers, "Origin"), false);
    assert.equal(request.headers.Accept, "*/*");
    assert.equal(request.headers["Sec-Fetch-Site"], "same-origin");
    assert.equal(request.headers["Sec-Fetch-Mode"], "cors");
    assert.equal(request.headers["Sec-Fetch-Dest"], "empty");
    assert.equal(request["auto-cookie"], false);
    assert.equal(request["auto-redirect"], false);
  }
  return text;
}

// 2026-09-07 两站实际未签到响应：没有领奖记录，也没有排名。
const emptyBoard = { list: [], record: null, order: null, total: 0 };
const todayRecord = { id: 10, member_id: 123, day_id: 7, gain: 5, created_at: "2026-09-06T14:17:26.000Z" };

test("签到成功优先使用服务端 current，包括真实零余额", async () => {
  for (const current of [6716, 0]) {
    const result = await runCron("nodeseek", { body: { success: true, message: "今天的签到收益是5个鸡腿", gain: 5, current } });
    assert.match(output(result), new RegExp("当前余额：" + current));
    assert.equal(result.requests.length, 2);
  }
});

test("签到成功未带余额时查询当前账号，余额不可得时不伪造零", async () => {
  for (const valid of [true, false]) {
    const result = await runCron("nodeseek", null, {
      http(method, request) {
        if (request.url.includes("/getInfo/")) return valid
          ? { body: { success: true, detail: { member_id: 123, coin: 321 } } }
          : { status: 503 };
        return { body: method === "get" ? emptyBoard : { success: true, message: "签到成功" } };
      },
    });
    assert.match(output(result), /签到成功/);
    assert.match(output(result), valid ? /当前余额：321/ : /当前余额：查询失败/);
    assert.equal(result.requests.filter(request => request.method === "post").length, 1);
  }
});

test("余额账号不匹配时不展示他人的鸡腿余额", async () => {
  const result = await runCron("nodeseek", null, {
    http: (_method, request) => ({ body: request.url.includes("/getInfo/")
      ? { success: true, detail: { member_id: 999, coin: 999999 } }
      : { list: [], record: todayRecord, order: 1, total: 1 } }),
  });
  assert.match(output(result), /今日已签到/);
  assert.match(output(result), /当前余额：查询失败/);
  assert.doesNotMatch(output(result), /999999/);
  assert.equal(result.requests.filter(request => request.method === "post").length, 0);
});

function runCron(site, response, extra = {}) {
  return runScript(script, {
    argument: "site=" + site + "&mode=fixed",
    store: { [site + "_data"]: JSON.stringify([account]) },
    http: (method, request) => request.url.includes("/api/account/getInfo/")
      ? { body: { success: true, detail: { member_id: account.userId, coin: 105 } } }
      : method === "get" ? { body: emptyBoard } : response,
    ...extra,
  });
}

function captureOptions(overrides = {}) {
  return {
    argument: "site=nodeseek",
    request: {
      method: "GET",
      url: "https://www.nodeseek.com/api/account/getInfo/123?phone=1&readme=1&signature=1",
      headers: {
        cOoKiE: token, "User-AGENT": account.userAgent, Referer: "https://www.nodeseek.com/setting",
      },
    },
    response: { status: 200, headers: {}, body: JSON.stringify({ success: true, detail: { member_id: 123, member_name: "测试账号", phone: "" } }) },
    ...overrides,
  };
}

test("未签到的 record=null、order=null 能领取一次并发送成功通知", async () => {
  for (const site of ["nodeseek", "deepflood"]) {
    const result = await runCron(site, {
      status: 200,
      body: { success: true, message: "今天的签到收益是5个鸡腿", gain: 5, current: 105 },
    });
    assert.deepEqual(result.requests.map(request => request.method), ["get", "post"]);
    assert.match(output(result), /签到成功/);
    assert.equal(result.notifications.length, 1);
    assert.match(result.notifications[0].subtitle, /签到成功/);
  }
});

test("签到 POST 带本站 Origin，避免 NodeSeek high risk action 拒绝", async () => {
  const result = await runCron("nodeseek", null, {
    http: (method, request) => {
      if (method === "get") return { body: emptyBoard };
      if (request.headers.Origin !== "https://www.nodeseek.com") {
        return { status: 403, body: { success: false, message: "high risk action" } };
      }
      return { body: { success: true, message: "今天的签到收益是5个鸡腿", gain: 5, current: 6716 } };
    },
  });
  assert.match(result.logs.join("\n"), /签到成功/);
  assert.match(output(result), /当前余额：6716/);
  assert.equal(result.requests.length, 2);
});

test("Surge 不提供 clearTimeout 时网络成功和失败都结束一次", async () => {
  for (const [response, expected] of [
    [{ body: { success: true, message: "签到成功", current: 105 } }, /签到成功/],
    [{ error: "synthetic-seek-secret" }, /网络请求失败/],
  ]) {
    const result = await runCron("nodeseek", response, { omitClearTimeout: true });
    assert.match(output(result), expected);
    assert.equal(result.requests.length, 2);
  }
});

test("两个站点先查询今日记录，固定模式只发一次无正文签到请求", async () => {
  for (const site of ["deepflood", "nodeseek"]) {
    const result = await runCron(site, { status: 200, body: { success: true, message: "签到成功，获得 5 个鸡腿", current: 105 } });
    assert.match(output(result), /签到成功/);
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0].url, "https://www." + site + ".com/api/attendance/board?page=1");
    assert.equal(result.requests[0].method, "get");
    assert.equal(result.requests[1].url, "https://www." + site + ".com/api/attendance?random=false");
    assert.equal(result.requests[1].method, "post");
    for (const request of result.requests) {
      assert.equal(request.headers.Cookie, token);
      assert.equal(request.headers["User-Agent"], account.userAgent);
      assert.equal(request.headers.Referer, "https://www." + site + ".com/board");
      assert.ok(request.timeout > 0 && request.timeout <= 12);
    }
  }
});

test("随机参数与旧 default=true 都代表 random=true，显式参数优先", async () => {
  for (const [argument, legacy, expected] of [
    ["site=nodeseek&mode=random", "false", "true"],
    ["site=nodeseek", "true", "true"],
    ["site=nodeseek", "false", "false"],
    ["site=nodeseek&mode=fixed", "true", "false"],
  ]) {
    const result = await runCron("nodeseek", { body: { success: true, message: "签到成功" } }, {
      argument,
      store: { nodeseek_data: JSON.stringify([account]), nodeseek_default: legacy },
    });
    output(result);
    assert.ok(result.requests[1].url.endsWith("random=" + expected));
  }
});

test("参数错误、未知站点和缺少凭据不会发出网络请求", async () => {
  for (const argument of ["", "site=evil", "site=__proto__", "site=nodeseek&mode=invalid", "site=nodeseek&site=deepflood", "site=%XX", "site=nodeseek"]) {
    const result = await runScript(script, { argument });
    assert.equal(result.requests.length, 0);
    assert.match(output(result), /签到失败/);
  }
});

test("捕获正常请求 Cookie，无需 Set-Cookie，保留其他账号与扩展字段", async () => {
  const oldAccount = { ...account, token: "session=old", extraState: { untouched: true } };
  const otherAccount = { userId: 456, userName: "另一个账号", token: "session=other", flags: [1] };
  const store = { nodeseek_data: JSON.stringify([oldAccount, otherAccount]), unrelated: "keep" };
  const result = await runScript(script, captureOptions({ store }));
  assert.match(output(result), /Cookie 更新成功/);
  assert.equal(result.requests.length, 0);
  const captured = JSON.parse(store.nodeseek_data);
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[0], { ...oldAccount, token, userAgent: "SyntheticBrowser/1" });
  assert.deepEqual(captured[1], otherAccount);
  assert.equal(store.unrelated, "keep");
});

test("相同 Cookie 与元信息重复捕获不产生通知", async () => {
  const store = { nodeseek_data: JSON.stringify([{ ...account, userAgent: "SyntheticBrowser/1" }]) };
  const result = await runScript(script, captureOptions({ store }));
  output(result);
  assert.equal(result.notifications.length, 0);
});

test("两个站点的 Service Worker Referer 可捕获设置页账号", async () => {
  for (const [site, version] of [["nodeseek", "0.3.34"], ["deepflood", "0.3.33"]]) {
    const base = captureOptions();
    const request = {
      ...base.request,
      url: "https://www." + site + ".com/api/account/getInfo/123?readme=1&signature=1&phone=1",
      headers: { ...base.request.headers, Referer: "https://www." + site + ".com/sw.js?v=" + version },
    };
    const result = await runScript(script, { ...base, argument: "site=" + site, request });
    assert.match(output(result), /Cookie 更新成功/);
    assert.equal(result.requests.length, 0);
    const saved = JSON.parse(result.store[site + "_data"]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].userId, 123);
    assert.equal(saved[0].token, token);
  }
});

test("Service Worker 捕获仍拒绝其他来源和不完整的账号证据", async () => {
  const base = captureOptions();
  const workerRequest = {
    ...base.request,
    headers: { ...base.request.headers, Referer: "https://www.nodeseek.com/sw.js?v=0.3.34" },
  };
  const invalidReferers = [
    "https://www.deepflood.com/sw.js?v=0.3.34",
    "https://www.nodeseek.com.evil.test/sw.js?v=0.3.34",
    "https://www.nodeseek.com/other.js?v=0.3.34",
    "https://www.nodeseek.com/sw.js",
    "https://www.nodeseek.com/sw.js?v=",
    "https://www.nodeseek.com/sw.js?v=0.3.34&other=1",
  ];
  const changes = invalidReferers.map((Referer) => ({ request: { ...workerRequest, headers: { ...workerRequest.headers, Referer } } }));
  changes.push(
    { request: { ...workerRequest, url: workerRequest.url.replace("phone=1&", "") } },
    { request: { ...workerRequest, url: workerRequest.url.replace("/123?", "/456?") } },
    { response: { status: 200, body: JSON.stringify({ success: true, detail: { member_id: 123, member_name: "测试账号" } }) } },
    { response: { status: 200, body: JSON.stringify({ success: false, detail: { member_id: 123, member_name: "测试账号", phone: "" } }) } },
  );
  for (const change of changes) {
    const store = { nodeseek_data: JSON.stringify([{ ...account, token: "session=old" }]) };
    const before = JSON.stringify(store);
    const result = await runScript(script, { ...base, request: workerRequest, ...change, store });
    output(result);
    assert.equal(JSON.stringify(store), before);
    assert.equal(result.requests.length, 0);
  }
});

test("普通资料请求、错误域名、身份不一致或缺少信息均不覆盖存储", async () => {
  const base = captureOptions();
  const cases = [
    { request: { ...base.request, url: base.request.url.replace("phone=1&", "") } },
    { request: { ...base.request, url: base.request.url.replace("www.nodeseek.com", "www.nodeseek.com.evil.test") } },
    { request: { ...base.request, method: "OPTIONS" } },
    { request: { ...base.request, headers: {} } },
    { request: { ...base.request, headers: { ...base.request.headers, Referer: "https://www.nodeseek.com/space/456" } } },
    { response: { status: 200, body: JSON.stringify({ success: true, detail: { member_id: 456, member_name: "其他账号", phone: "" } }) } },
    { response: { status: 200, body: JSON.stringify({ success: false, detail: { member_id: 123, member_name: "测试账号", phone: "" } }) } },
    { response: { status: 200, body: JSON.stringify({ success: true, detail: {} }) } },
    { response: { status: 200, body: JSON.stringify({ success: true, detail: { member_id: 123, member_name: "测试账号" } }) } },
    { response: { status: 403, body: "Forbidden" } },
  ];
  for (const change of cases) {
    const store = { nodeseek_data: JSON.stringify([account]) };
    const before = JSON.stringify(store);
    const result = await runScript(script, { ...base, ...change, store });
    output(result);
    assert.equal(JSON.stringify(store), before);
    assert.equal(result.requests.length, 0);
  }
});

test("损坏的账号数组保留原文，捕获不清空旧数据", async () => {
  for (const raw of ["{broken", "{}", "null"]) {
    const store = { nodeseek_data: raw };
    const result = await runScript(script, captureOptions({ store }));
    assert.match(output(result), /存储/);
    assert.equal(store.nodeseek_data, raw);
  }
});

test("有效今日记录只查询记录和余额，两站均不重复领奖", async () => {
  for (const site of ["nodeseek", "deepflood"]) {
    const store = { [site + "_data"]: JSON.stringify([account]) };
    const before = JSON.stringify(store);
    const result = await runCron(site, null, {
      store,
      http: (_method, request) => ({ body: request.url.includes("/api/account/getInfo/")
        ? { success: true, detail: { member_id: account.userId, coin: 105 } }
        : { list: [], record: todayRecord, order: 1, total: 1 } }),
    });
    assert.match(output(result), /今日已签到/);
    assert.match(output(result), /当前余额：105/);
    assert.deepEqual(result.requests.map(request => request.method), ["get", "get"]);
    assert.equal(JSON.stringify(store), before);
  }
});

test("今日记录或 board 结构错误时停止，不发送 POST", async () => {
  const bodies = [
    {}, { record: null }, { ...emptyBoard, list: {} }, { ...emptyBoard, order: "1" },
    { ...emptyBoard, total: -1 }, { ...emptyBoard, total: null }, { ...emptyBoard, success: false },
  ];
  for (const record of [0, 1, true, "signed", [], {},
    { ...todayRecord, member_id: 456 }, { ...todayRecord, member_id: "123" },
    { ...todayRecord, id: 0 }, { ...todayRecord, day_id: -1 },
    { ...todayRecord, gain: -1 }, { ...todayRecord, gain: true },
    { ...todayRecord, created_at: "invalid" }, { ...todayRecord, created_at: "2026" },
  ]) bodies.push({ ...emptyBoard, record });
  for (const body of bodies) {
    const result = await runCron("nodeseek", null, { http: () => ({ body }) });
    assert.match(output(result), /未发起领奖请求/);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].method, "get");
  }
});

test("读取今日状态遇到认证、网络或 303 错误时不尝试领奖", async () => {
  for (const response of [
    { status: 401 }, { error: "synthetic-seek-secret" },
    { status: 303, headers: { Location: "https://www.nodeseek.com/api/attendance/board?page=1" }, body: "<title>303 See Other</title>" },
  ]) {
    const result = await runCron("nodeseek", null, { http: () => response });
    assert.match(output(result), /签到失败/);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].method, "get");
  }
});

test("兼容真实固定奖励文案和有效收益字段，未知文案不掩盖无效数据", async () => {
  for (const body of [
    { success: true, message: "今天的签到收益是5个鸡腿", gain: 5, current: 100 },
    { success: true, message: "今天的签到收益是5个鸡腿" },
    { success: true, message: "奖励到账", gain: 5, current: 100 },
  ]) {
    const result = await runCron("deepflood", { body });
    assert.match(output(result), /签到成功/);
    assert.equal(result.requests.filter((request) => request.method === "post").length, 1);
  }
  for (const body of [
    { success: true, message: "奖励到账", gain: true, current: 100 },
    { success: true, message: "奖励到账", gain: -1, current: 100 },
    { success: true, message: "奖励到账", gain: 5, current: "100" },
    { success: false, message: "今天的签到收益是5个鸡腿", gain: 5, current: 100 },
  ]) {
    const result = await runCron("deepflood", { body });
    assert.match(output(result), /签到失败/);
    assert.equal(result.requests.filter((request) => request.method === "post").length, 1);
  }
});

test("缺少浏览器 UA 的旧账号保留 Cookie，明确要求刷新捕获", async () => {
  const legacy = { userId: 123, userName: "旧账号", token };
  const store = { nodeseek_data: JSON.stringify([legacy]) };
  const before = store.nodeseek_data;
  const result = await runCron("nodeseek", null, { store });
  assert.match(output(result), /缺少浏览器 User-Agent/);
  assert.equal(result.requests.length, 0);
  assert.equal(store.nodeseek_data, before);
});

test("服务器已签到回复与 success=false 的普通失败分开处理", async () => {
  const done = await runCron("nodeseek", { body: { success: false, message: "今天已经签到过了" } });
  assert.match(output(done), /今日已签到/);
  const failed = await runCron("nodeseek", { body: { success: false, message: "签到失败 synthetic-seek-secret" } });
  assert.match(output(failed), /未确认签到成功/);
});

test("HTTP200 的空 JSON、成功标志不足和 HTML 都不能算成功", async () => {
  for (const body of [{}, { success: true }, { success: true, message: "欢迎光临" }, "<html>普通页面</html>", "not-json", "null"]) {
    const result = await runCron("nodeseek", { status: 200, body });
    assert.match(output(result), /响应格式异常/);
    assert.equal(result.requests.length, 2);
  }
});

test("登录失效、验证拦截、HTTP异常和网络错误均明确报告且不重试", async () => {
  const cases = [
    [{ status: 401, body: "" }, /登录失效/],
    [{ status: 200, body: { success: false, message: "请先登录" } }, /登录失效/],
    [{ status: 200, body: { success: false, message: "需要登录后使用本接口" } }, /登录失效/],
    [{ status: 200, body: { success: false, message: "session expired" } }, /登录失效/],
    [{ status: 200, body: '<html><title>登录 - NodeSeek</title></html>' }, /登录失效/],
    [{ status: 200, body: "<title>Just a moment...</title>" }, /验证拦截/],
    [{ status: 403, body: "Forbidden" }, /拒绝访问/],
    [{ status: 429, body: "" }, /频率受限/],
    [{ status: 500, body: "" }, /HTTP 500/],
    [{ status: 302, headers: { LoCaTiOn: "https://evil.test/" }, body: "" }, /未转发登录凭据/],
    [{ error: "synthetic-seek-secret network failure" }, /网络请求失败/],
  ];
  for (const [response, expected] of cases) {
    const result = await runCron("nodeseek", response);
    assert.match(output(result), expected);
    assert.equal(result.requests.length, 2);
  }
});

test("一个账号失败不阻止其余账号，原始存储不会被认证失败清空", async () => {
  const store = { nodeseek_data: JSON.stringify([account, { ...account, userId: 456, token: "session=other" }]) };
  const before = store.nodeseek_data;
  const result = await runCron("nodeseek", null, {
    store,
    http: (method, _options, index) => index === 0 ? { status: 401 } : method === "get" ? { body: emptyBoard } : { body: { success: true, message: "签到成功", current: 105 } },
  });
  assert.match(output(result), /签到失败 · 账号 1/);
  assert.match(output(result), /签到成功 · 账号 2/);
  assert.equal(store.nodeseek_data, before);
  assert.equal(result.requests.length, 3);
});

test("HTTP 客户端不回调时仍在秒级期限结束一次", { timeout: 15000 }, async () => {
  const result = await runCron("nodeseek", null, { http: () => new Promise(() => {}), timeoutMs: 14000 });
  assert.match(output(result), /网络请求超时/);
  assert.equal(result.requests.length, 1);
});
