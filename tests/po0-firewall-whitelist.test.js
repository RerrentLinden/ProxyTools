"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { runScript } = require("./helpers/surge-harness");

const SCRIPT = path.join(__dirname, "../surge-scripts/po0-firewall-whitelist.js");
const TOKEN = "pgnfw_synthetic0secret0token";
const BASE = "https://124.221.69.228/api/firewall/" + TOKEN;
const OFFICE = "203.0.113.0/24";
const HOME = "198.51.100.0/24";
const PHONE = "192.0.2.0/24";
const ARGUMENT =
  "tokens=" + TOKEN +
  "&cellular_slot=0&wired_slot=&ssid_slots=Hotspot=0|Home=1|Office-5G=2&unknown_slot=4&notify=false";
const OFFICE_5G = { v4: { primaryInterface: "en0" }, wifi: { ssid: "Office-5G" } };

function status(currentIp, entries, extra = {}) {
  return {
    status: 200,
    body: {
      enabled: true,
      whitelist: entries.map(([ip, slot]) => ({ ip, slot })),
      limit: 5,
      currentIp,
      tokenAvailable: true,
      token: TOKEN,
      ...extra,
    },
  };
}

function html(code) {
  return { status: code, body: `<html><head><title>${code} Service Temporarily Unavailable</title></head></html>` };
}

// 依次返回给定回应；超出后重复最后一个。
function sequence(...replies) {
  return (_method, _request, index) => replies[Math.min(index, replies.length - 1)];
}

function run(http, network = OFFICE_5G) {
  return runScript(SCRIPT, { argument: ARGUMENT, network, http, timerScale: 0 });
}

function checkResult(result) {
  assert.equal(result.doneCount, 1);
  assert.doesNotMatch(JSON.stringify([result.doneValue, result.notifications, result.logs]), /synthetic0secret/);
  for (const request of result.requests) {
    assert.equal(request.timeout, 15);
  }
}

test("按 SSID 槽位写入并显示 /24 出口", async () => {
  const result = await run(sequence(status(OFFICE, [[PHONE, 0], [HOME, 1], [OFFICE, 2]])));
  checkResult(result);
  assert.deepEqual(result.requests.map((r) => [r.method, r.url]), [["post", BASE + "/add?slot=2"]]);
  assert.equal(result.doneValue.icon, "checkmark.shield");
  assert.match(result.doneValue.title, /1\/1 · Wi-Fi Office-5G · 出口 203\.0\.113\.0\/24/);
  assert.match(result.doneValue.content, /203\.0\.113\.0\/24 📌2 ←/);
});

test("403 后查询状态：网段已在别的槽位时算成功并提示实际槽位", async () => {
  const result = await run(sequence(
    // 2026-11-16 实测的 403 响应体
    { status: 403, body: { code: 403, message: "IP is already pinned to another slot." } },
    status(OFFICE, [[PHONE, 0], [HOME, 1], [OFFICE, 4]]),
  ));
  checkResult(result);
  assert.deepEqual(result.requests.map((r) => [r.method, r.url]), [
    ["post", BASE + "/add?slot=2"],
    ["get", BASE],
  ]);
  assert.equal(result.doneValue.icon, "checkmark.shield");
  assert.match(result.doneValue.title, /1\/1 .* 出口 203\.0\.113\.0\/24/);
  assert.match(result.doneValue.content, /⚠️ 当前网段已在槽位 4，未写入槽位 2/);
});

test("403 后查询状态：网段不在白名单时报错并带上服务端原因", async () => {
  const result = await run(sequence(
    { status: 403, body: { error: "token 已停用" } },
    status(OFFICE, [[HOME, 1]]),
  ));
  checkResult(result);
  assert.equal(result.doneValue.icon, "exclamationmark.shield");
  assert.match(result.doneValue.title, /0\/1 .* 出口 203\.0\.113\.0\/24/);
  assert.match(result.doneValue.content, /❌ 写入被拒（token 已停用），当前网段 203\.0\.113\.0\/24 不在白名单/);
});

test("403 后状态查询也失败时报两段原因", async () => {
  const result = await run(sequence({ status: 403, body: "<html>403</html>" }, { status: 401, body: { error: "无效 token" } }));
  checkResult(result);
  assert.equal(result.requests.length, 2);
  assert.match(result.doneValue.content, /写入被拒（当前网段可能已在其它槽位），状态查询失败：HTTP 401：无效 token/);
});

test("openresty 503 后重试成功", async () => {
  const result = await run(sequence(html(503), status(OFFICE, [[OFFICE, 2]])));
  checkResult(result);
  assert.equal(result.requests.length, 2);
  assert.deepEqual(result.timers, [3000]);
  assert.equal(result.doneValue.icon, "checkmark.shield");
});

test("切网瞬间没有出口接口时重试", async () => {
  const result = await run(sequence({ error: "No outgoing interface" }, status(OFFICE, [[OFFICE, 2]])));
  checkResult(result);
  assert.equal(result.requests.length, 2);
  assert.equal(result.doneValue.icon, "checkmark.shield");
});

test("持续 503 时重试两次后报 HTTP 状态，不把 HTML 塞进面板", async () => {
  const result = await run(sequence(html(503)));
  checkResult(result);
  assert.equal(result.requests.length, 3);
  assert.deepEqual(result.timers, [3000, 8000]);
  assert.equal(result.doneValue.icon, "exclamationmark.shield");
  assert.match(result.doneValue.content, /❌ HTTP 503$/);
  assert.doesNotMatch(result.doneValue.content, /<html>/);
});

test("200 但不是状态结构时显示服务端消息，不重试", async () => {
  const result = await run(sequence({ status: 200, body: { error: "请求过于频繁" } }));
  checkResult(result);
  assert.equal(result.requests.length, 1);
  assert.match(result.doneValue.content, /❌ HTTP 200：请求过于频繁/);
  assert.doesNotMatch(result.doneValue.content, /undefined/);
});

test("未配置 SSID 的 Wi-Fi 使用陌生网络槽位", async () => {
  const network = { v4: { primaryInterface: "en0" }, wifi: { ssid: "Office-2G" } };
  const result = await run(sequence(status(OFFICE, [[OFFICE, 4]])), network);
  checkResult(result);
  assert.equal(result.requests[0].url, BASE + "/add?slot=4");
});
