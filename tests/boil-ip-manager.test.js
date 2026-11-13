const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const script = fs.readFileSync(path.join(__dirname, "..", "surge-scripts", "boil-ip-manager.js"), "utf8");
const moduleText = fs.readFileSync(path.join(__dirname, "..", "surge-modules", "boil-ip-manager.sgmodule"), "utf8");
const profileText = fs.readFileSync(path.join(__dirname, "boil-ip-manager-profile.conf"), "utf8");

const TOKEN = "tok-Secret-9f3c-Example";
const STATE_KEY = "boil_ip_manager_state_v1";
const GET_IP = "/api/v1/getIP";
const CHANGE_IP = "/api/v1/changeIP/";
const START = Date.UTC(2026, 9, 1, 4, 0, 0) / 1000;
const OLD_IP = "203.0.113.10";
const NEW_IP = "203.0.113.20";
const RECORD_KEYS = [
  "v",
  "token",
  "status",
  "oldIp",
  "newIp",
  "startedAt",
  "requestedAt",
  "checkedAt",
  "nextAllowedAt",
  "busyUntil",
  "usesLeft",
];

/* ---------- 测试工具 ---------- */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function fingerprint(token) {
  let hash = 5381;
  for (let i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function fmt(seconds) {
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function json(status, value, extra = {}) {
  return { status, body: JSON.stringify(value), ...extra };
}
function ipOk(ip, extra) {
  return json(200, { ok: true, ip }, extra);
}
function changeOk(fields = {}, extra) {
  return json(
    200,
    { ok: true, message: "正在執行更換IP", uses_left: 2, next_allowed_at: START + 60, ...fields },
    extra
  );
}
function apiError(message, status = 400) {
  return json(status, { error: message });
}
function networkError(message = "The request timed out.", extra = {}) {
  return { error: message, ...extra };
}
// 依次返回给定回应；超出后重复最后一个。
function sequence(...replies) {
  return (index) => replies[Math.min(index, replies.length - 1)];
}

function createEnv(nowSeconds = START) {
  return { now: nowSeconds * 1000, store: {} };
}

function nowSec(env) {
  return Math.floor(env.now / 1000);
}

function seedState(env, fields) {
  env.store[STATE_KEY] = JSON.stringify({
    v: 1,
    token: fingerprint(TOKEN),
    status: "changed",
    oldIp: OLD_IP,
    newIp: "",
    startedAt: 0,
    requestedAt: 0,
    checkedAt: 0,
    nextAllowedAt: 0,
    busyUntil: 0,
    usesLeft: null,
    ...fields,
  });
}

function readState(env) {
  const raw = env.store[STATE_KEY];
  return raw ? JSON.parse(raw) : null;
}

function changeArg(extra = "", notify = false) {
  return `action=change&api_token=${TOKEN}&enabled=true&notify=${notify}${extra}`;
}

function queryArg() {
  return `action=query&api_token=${TOKEN}&enabled=true&notify=true`;
}

// 假时钟：setTimeout 与 HTTP 回调都进入同一队列，执行时把时钟推进到计划时间。
function run(env, options) {
  const {
    argument,
    trigger,
    responses = {},
    notificationThrows = false,
    writeFails = false,
    noStore = false,
  } = options;
  const calls = [];
  const notifications = [];
  const logs = [];
  const harnessErrors = [];
  const queue = [];
  const counters = {};
  let seq = 0;
  let timers = 0;
  let doneCount = 0;
  let doneValue;

  function schedule(atMs, fn) {
    queue.push({ atMs, seq: seq++, fn });
  }

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [env.now]));
    }
    static now() {
      return env.now;
    }
  }

  const context = {
    Date: FakeDate,
    console: {
      log(...args) {
        logs.push(args.join(" "));
      },
    },
    setTimeout(fn, delay) {
      timers += 1;
      schedule(env.now + Math.max(0, Number(delay) || 0), fn);
      return timers;
    },
    $httpClient: {
      post(requestOptions, callback) {
        const pathname = new URL(requestOptions.url).pathname;
        const index = counters[pathname] || 0;
        counters[pathname] = index + 1;
        calls.push({
          path: pathname,
          url: requestOptions.url,
          headers: requestOptions.headers,
          body: requestOptions.body,
          timeout: requestOptions.timeout,
          at: env.now / 1000,
        });
        const source = responses[pathname];
        let reply = typeof source === "function" ? source(index) : source && source[index];
        if (!reply) {
          harnessErrors.push(`未配置回应：${pathname} #${index}`);
          reply = networkError("harness");
        }
        schedule(env.now + (reply.latency || 0) * 1000, () => {
          if (reply.error) callback(reply.error, undefined, undefined);
          else callback(null, { status: reply.status, headers: {} }, reply.body);
        });
      },
    },
    $notification: {
      post(title, subtitle, body) {
        if (notificationThrows) throw new Error("notification failed");
        notifications.push({ title, subtitle, body });
      },
    },
    $done(value) {
      doneCount += 1;
      doneValue = value;
    },
  };
  if (argument !== undefined) context.$argument = argument;
  if (trigger !== undefined) context.$trigger = trigger;
  if (!noStore) {
    context.$persistentStore = {
      read(key) {
        return Object.prototype.hasOwnProperty.call(env.store, key) ? env.store[key] : null;
      },
      write(value, key) {
        if (typeof value !== "string") harnessErrors.push("持久化只接受字符串");
        if (key !== STATE_KEY) harnessErrors.push(`意外的存储键：${key}`);
        if (writeFails) return false;
        env.store[key] = value;
        return true;
      },
    };
  }

  vm.runInNewContext(script, context);
  let steps = 0;
  while (queue.length) {
    queue.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
    const item = queue.shift();
    env.now = Math.max(env.now, item.atMs);
    item.fn();
    steps += 1;
    if (steps > 500) throw new Error("事件队列未收敛");
  }

  assert.deepStrictEqual(harnessErrors, []);
  assert.strictEqual(doneCount, 1, "$done 必须恰好调用一次");
  const exposed = [
    JSON.stringify(env.store),
    JSON.stringify(doneValue),
    JSON.stringify(notifications),
    logs.join("\n"),
  ].join("\n");
  assert.ok(!exposed.includes(TOKEN), "Token 不得出现在存储、面板、通知或日志中");

  return {
    calls,
    paths: calls.map((call) => call.path),
    count: (pathname) => calls.filter((call) => call.path === pathname).length,
    notifications,
    done: doneValue,
    timers,
    state: readState(env),
  };
}

/* ---------- 模块与测试配置 ---------- */

test("module keeps manual-only triggers and declares confirm_seconds", () => {
  assert.doesNotMatch(moduleText, /type=(?:cron|event)\b/);
  assert.doesNotMatch(moduleText.split("[Panel]")[1], /update-interval\s*=/);
  assert.match(
    moduleText,
    /https:\/\/raw\.githubusercontent\.com\/RerrentLinden\/ProxyTools\/main\/surge-scripts\/boil-ip-manager\.js/
  );
  assert.match(moduleText, /change_enabled:false/);
  assert.match(moduleText, /^#!arguments=.*\bconfirm_seconds:120\b/m);
  assert.match(moduleText, /^#!arguments-desc=.*\bconfirm_seconds: /m);
  assert.match(moduleText, /^#!desc=.*短暂断网/m);

  const lines = moduleText.split("\n");
  const changeLine = lines.find((line) => line.startsWith("boil-ip-change ="));
  const queryLine = lines.find((line) => line.startsWith("boil-ip-query ="));
  assert.match(changeLine, /,timeout=300,/);
  assert.match(changeLine, /&confirm_seconds=\{\{\{confirm_seconds\}\}\}"/);
  assert.match(queryLine, /,timeout=20,/);
});

test("test profile mirrors change script timeout and confirm_seconds", () => {
  const changeLine = profileText.split("\n").find((line) => line.startsWith("boil-ip-change ="));
  assert.match(changeLine, /,timeout=300,/);
  assert.match(changeLine, /enabled=false/);
  assert.match(changeLine, /confirm_seconds=\d+/);
});

/* ---------- 配置与开关 ---------- */

test("disabled change sends no request", () => {
  const env = createEnv();
  const result = run(env, { argument: `action=change&api_token=${TOKEN}&enabled=false&notify=true` });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(result.timers, 0);
  assert.match(result.done.content, /开关已关闭，未请求 API。/);
  assert.strictEqual(result.notifications.length, 0);
  assert.strictEqual(result.state, null);
});

test("missing token is a configuration error without requests", () => {
  const result = run(createEnv(), { argument: "action=query&api_token=&enabled=true&notify=true" });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(result.done.title, "Boil IP 配置错误");
  assert.match(result.done.content, /填写 API Token/);
});

test("invalid confirm_seconds is a configuration error without requests", () => {
  for (const value of ["abc", "-5", "1.5", "12s"]) {
    const result = run(createEnv(), { argument: changeArg(`&confirm_seconds=${value}`) });
    assert.strictEqual(result.calls.length, 0, value);
    assert.strictEqual(result.done.title, "Boil IP 配置错误", value);
    assert.match(result.done.content, /confirm_seconds/, value);
  }
});

test("auto-interval trigger never changes IP", () => {
  const env = createEnv();
  const result = run(env, { argument: changeArg("&confirm_seconds=120", true), trigger: "auto-interval" });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(result.done.content, "更换 IP 只能手动点击触发；未请求 API。");
  assert.strictEqual(result.notifications.length, 0);
  assert.strictEqual(result.state, null);
});

/* ---------- 查询 ---------- */

test("query sends one getIP and shows current IP", () => {
  const env = createEnv();
  const result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk("42.3.69.25")] } });
  assert.deepStrictEqual(result.paths, [GET_IP]);
  assert.strictEqual(result.calls[0].url, "https://ippanel.boil.network/api/v1/getIP");
  assert.strictEqual(result.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(result.calls[0].body, "");
  assert.strictEqual(result.calls[0].timeout, 15);
  assert.strictEqual(result.done.title, "Boil IP 查询");
  assert.strictEqual(result.done.content, "当前 IP\n42.3.69.25");
  assert.strictEqual(result.notifications.length, 0);
  assert.deepStrictEqual(env.store, {});
});

test("query reports non-JSON and API errors without writing state", () => {
  const env = createEnv();
  seedState(env, { status: "pending", requestedAt: START - 60, busyUntil: START + 60 });
  const before = env.store[STATE_KEY];

  let result = run(env, { argument: queryArg(), responses: { [GET_IP]: [{ status: 200, body: "not-json" }] } });
  assert.strictEqual(result.done.title, "Boil IP 查询失败");
  assert.match(result.done.content, /不是有效 JSON/);

  result = run(env, { argument: queryArg(), responses: { [GET_IP]: [apiError("內部錯誤，請稍後再試")] } });
  assert.match(result.done.content, /內部錯誤/);

  result = run(env, {
    argument: queryArg(),
    responses: { [GET_IP]: [apiError("用戶與機器不匹配，API已失效")] },
  });
  assert.match(result.done.content, /API Token 已失效/);
  assert.strictEqual(env.store[STATE_KEY], before);
});

test("query marks a recent change record as changed (AC7)", () => {
  const env = createEnv();
  seedState(env, {
    status: "pending",
    requestedAt: START - 120,
    startedAt: START - 125,
    busyUntil: START + 30,
    nextAllowedAt: START + 300,
  });
  const result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(NEW_IP)] } });
  assert.match(result.done.content, new RegExp(`^当前 IP\\n${NEW_IP}\\n`));
  assert.match(result.done.content, new RegExp(`已从 ${OLD_IP} 更换（${fmt(START - 120)} 提交）`));
  assert.match(result.done.content, new RegExp(`下次可更换：${fmt(START + 300)}`));
  assert.strictEqual(result.state.status, "changed");
  assert.strictEqual(result.state.newIp, NEW_IP);
  assert.strictEqual(result.state.checkedAt, START);
  assert.strictEqual(result.state.busyUntil, START + 30, "查询流程不改 busyUntil");
});

test("query reports a recent change record that is still on the old IP (AC7)", () => {
  let env = createEnv();
  seedState(env, { status: "unclear", requestedAt: START - 120, busyUntil: START + 180 });
  let before = env.store[STATE_KEY];
  let result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(OLD_IP)] } });
  assert.match(result.done.content, /仍为更换前 IP（提交后 2 分钟）/);
  assert.match(result.done.content, /可能仍在重连，稍后再查/);
  assert.strictEqual(env.store[STATE_KEY], before);

  env = createEnv();
  seedState(env, { status: "unchanged", requestedAt: START - 600 });
  result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(OLD_IP)] } });
  assert.match(result.done.content, /仍为更换前 IP（提交后 10 分钟）/);
  assert.doesNotMatch(result.done.content, /可能仍在重连/);

  env = createEnv();
  seedState(env, { status: "pending", requestedAt: START - 25 * 3600 });
  before = env.store[STATE_KEY];
  result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(NEW_IP)] } });
  assert.strictEqual(result.done.content, `当前 IP\n${NEW_IP}`);
  assert.strictEqual(env.store[STATE_KEY], before);

  env = createEnv();
  seedState(env, { token: "00000000", status: "pending", requestedAt: START - 60 });
  result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(NEW_IP)] } });
  assert.strictEqual(result.done.content, `当前 IP\n${NEW_IP}`);
});

/* ---------- 更换：成功与未变化 ---------- */

test("change records old IP, submits once and confirms the new IP (AC2)", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120", true),
    trigger: "button",
    responses: {
      [GET_IP]: sequence(ipOk(OLD_IP), ipOk(OLD_IP), ipOk(NEW_IP)),
      [CHANGE_IP]: [changeOk()],
    },
  });

  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP, GET_IP, GET_IP]);
  assert.strictEqual(result.count(CHANGE_IP), 1);
  assert.strictEqual(result.calls[1].url, "https://ippanel.boil.network/api/v1/changeIP/");
  assert.ok(result.calls.every((call) => call.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(result.calls.every((call) => call.body === ""));
  assert.deepStrictEqual(
    result.calls.map((call) => call.timeout),
    [15, 15, 10, 10]
  );
  assert.deepStrictEqual(
    result.calls.map((call) => call.at - START),
    [0, 0, 10, 20]
  );
  assert.strictEqual(result.timers, 2);

  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.strictEqual(result.done.style, "good");
  assert.strictEqual(result.done["icon-color"], "#34C759");
  assert.strictEqual(
    result.done.content,
    [
      `旧 IP：${OLD_IP}`,
      `新 IP：${NEW_IP}`,
      "确认耗时：20 秒",
      "剩余 API 次数：2",
      `下次可更换：${fmt(START + 60)}`,
    ].join("\n")
  );
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(result.notifications[0].title, "Boil IP 已更换");
  assert.strictEqual(result.notifications[0].body, result.done.content);

  assert.deepStrictEqual(Object.keys(result.state), RECORD_KEYS);
  assert.match(result.state.token, /^[0-9a-f]{8}$/);
  assert.deepStrictEqual(result.state, {
    v: 1,
    token: fingerprint(TOKEN),
    status: "changed",
    oldIp: OLD_IP,
    newIp: NEW_IP,
    startedAt: START,
    requestedAt: START,
    checkedAt: START + 20,
    nextAllowedAt: START + 60,
    busyUntil: 0,
    usesLeft: 2,
  });

  // 冷却未到：本地拦截，不发请求、不通知（AC6）。
  const blocked = run(env, { argument: changeArg("&confirm_seconds=120", true) });
  assert.strictEqual(blocked.calls.length, 0);
  assert.strictEqual(blocked.done.title, "Boil IP 更换未提交");
  assert.strictEqual(blocked.done.style, "info");
  assert.strictEqual(blocked.done.icon, "clock");
  assert.strictEqual(
    blocked.done.content,
    `冷却中，下次可更换：${fmt(START + 60)}\n未请求 API，不扣次数`
  );
  assert.strictEqual(blocked.notifications.length, 0);

  // 冷却结束后允许再次提交。
  env.now = (START + 61) * 1000;
  const again = run(env, {
    argument: changeArg(),
    responses: { [GET_IP]: [ipOk(NEW_IP)], [CHANGE_IP]: [changeOk({ next_allowed_at: START + 121 })] },
  });
  assert.deepStrictEqual(again.paths, [GET_IP, CHANGE_IP]);
  assert.strictEqual(again.done.title, "Boil IP 更换已提交");
});

test("unchanged IP within the window is reported without resubmitting (AC3)", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120", true),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.count(CHANGE_IP), 1);
  assert.deepStrictEqual(
    result.calls.filter((call) => call.path === GET_IP).map((call) => call.at - START),
    [0, 10, 20, 30, 45, 60, 80, 100, 120]
  );
  assert.strictEqual(result.done.title, "Boil IP 未变化");
  assert.strictEqual(result.done.style, "alert");
  assert.strictEqual(result.done.icon, "exclamationmark.triangle.fill");
  assert.strictEqual(result.done["icon-color"], "#FF9500");
  assert.strictEqual(
    result.done.content,
    [
      `120 秒内仍为旧 IP：${OLD_IP}`,
      "可能是官方重拨后分回同一 IP，或仍在重连",
      "请勿立即重试；稍后点「Boil IP 查询」确认",
      "剩余 API 次数：2",
      `下次可更换：${fmt(START + 60)}`,
    ].join("\n")
  );
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(result.state.status, "unchanged");
  assert.strictEqual(result.state.busyUntil, 0);
  assert.strictEqual(result.state.checkedAt, START + 120);
});

test("confirm_seconds caps at 240 and uses the declared poll offsets", () => {
  let result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=999"),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.deepStrictEqual(
    result.calls.slice(2).map((call) => call.at - START),
    [10, 20, 30, 45, 60, 80, 100, 120, 150, 180, 210, 240]
  );
  assert.match(result.done.content, /^240 秒内仍为旧 IP/);
  assert.strictEqual(result.state.status, "unchanged");

  result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=50"),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.deepStrictEqual(
    result.calls.slice(2).map((call) => call.at - START),
    [10, 20, 30, 45, 50]
  );

  result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=5"),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.deepStrictEqual(
    result.calls.slice(2).map((call) => call.at - START),
    [5]
  );
});

test("a late poll triggers the next due poll immediately", () => {
  const result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=45"),
    responses: {
      [GET_IP]: sequence(ipOk(OLD_IP), ipOk(OLD_IP, { latency: 25 }), ipOk(OLD_IP), ipOk(OLD_IP), ipOk(NEW_IP)),
      [CHANGE_IP]: [changeOk()],
    },
  });
  assert.deepStrictEqual(
    result.calls.slice(2).map((call) => call.at - START),
    [10, 35, 35, 45]
  );
  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.match(result.done.content, /确认耗时：45 秒/);
});

test("transient poll errors keep confirming; non-transient errors stop", () => {
  let result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=60"),
    responses: {
      [GET_IP]: sequence(
        ipOk(OLD_IP),
        networkError(),
        apiError("Bad Gateway", 502),
        apiError("內部錯誤，請稍後再試"),
        ipOk(NEW_IP)
      ),
      [CHANGE_IP]: [changeOk()],
    },
  });
  assert.strictEqual(result.count(CHANGE_IP), 1);
  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.match(result.done.content, /确认耗时：45 秒/);

  result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=120", true),
    responses: {
      [GET_IP]: sequence(ipOk(OLD_IP), apiError("用戶與機器不匹配，API已失效")),
      [CHANGE_IP]: [changeOk()],
    },
  });
  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP, GET_IP]);
  assert.strictEqual(result.done.title, "Boil IP 确认失败");
  assert.match(result.done.content, /确认新 IP 时查询失败：用戶與機器不匹配/);
  assert.match(result.done.content, /API Token 已失效/);
  assert.match(result.done.content, /未重复提交/);
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(result.state.status, "pending");

  result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=20"),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP), networkError()), [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.done.title, "Boil IP 结果不明确");
  assert.match(result.done.content, /20 秒内未能查询到当前 IP：网络请求失败/);
  assert.strictEqual(result.state.status, "pending");
});

/* ---------- 更换：不等待（旧模块兼容） ---------- */

test("missing confirm_seconds finishes immediately without polling", () => {
  for (const extra of ["", "&confirm_seconds=", "&confirm_seconds=0"]) {
    const env = createEnv();
    const result = run(env, {
      argument: changeArg(extra),
      responses: {
        [GET_IP]: [ipOk(OLD_IP)],
        [CHANGE_IP]: [changeOk({ uses_left: "3", next_allowed_at: (START + 90) * 1000 })],
      },
    });
    assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP], extra);
    assert.strictEqual(result.timers, 0, extra);
    assert.strictEqual(env.now, START * 1000, extra);
    assert.strictEqual(result.done.title, "Boil IP 更换已提交");
    assert.strictEqual(
      result.done.content,
      [
        `旧 IP：${OLD_IP}`,
        "官方正在重连线路，VPS 会短暂断网",
        "1–3 分钟后点「Boil IP 查询」确认是否已变化",
        "剩余 API 次数：3",
        `下次可更换：${fmt(START + 90)}`,
      ].join("\n")
    );
    assert.doesNotMatch(result.done.content, /不代表新 IP 已经生效/);
    assert.strictEqual(result.state.status, "pending");
    assert.strictEqual(result.state.nextAllowedAt, START + 90);
    assert.strictEqual(result.state.usesLeft, 3);
    assert.strictEqual(result.state.busyUntil, START + 30);
  }
});

test("object $argument is supported", () => {
  const result = run(createEnv(), {
    argument: { action: "change", api_token: TOKEN, enabled: true, notify: false, confirm_seconds: 0 },
    responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.done.title, "Boil IP 更换已提交");
});

/* ---------- 更换：查询旧 IP 失败 ---------- */

test("getIP failure before submit never calls changeIP (AC4)", () => {
  const env = createEnv();
  seedState(env, { status: "changed", newIp: OLD_IP, requestedAt: START - 3600 });
  const before = env.store[STATE_KEY];
  let result = run(env, {
    argument: changeArg("&confirm_seconds=120", true),
    responses: { [GET_IP]: [apiError("內部錯誤，請稍後再試")] },
  });
  assert.deepStrictEqual(result.paths, [GET_IP]);
  assert.strictEqual(result.done.title, "Boil IP 更换未提交");
  assert.strictEqual(result.done.content, "查询当前 IP 失败：內部錯誤，請稍後再試\n未提交更换");
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(env.store[STATE_KEY], before, "失败后恢复原记录");

  const empty = createEnv();
  result = run(empty, {
    argument: changeArg("&confirm_seconds=120"),
    responses: { [GET_IP]: [networkError()] },
  });
  assert.deepStrictEqual(result.paths, [GET_IP]);
  assert.match(result.done.content, /查询当前 IP 失败：网络请求失败/);
  assert.strictEqual(result.state, null);

  // 恢复后立即再次点击不被“提交中”锁拦截。
  result = run(empty, {
    argument: changeArg(),
    responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [changeOk()] },
  });
  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP]);
});

/* ---------- 更换：结果不明确 ---------- */

test("inconclusive submit is never resubmitted and protects the next click (AC5)", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=30", true),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [networkError()] },
  });
  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP, GET_IP, GET_IP, GET_IP]);
  assert.strictEqual(result.done.title, "Boil IP 结果不明确");
  assert.strictEqual(result.done.style, "alert");
  assert.match(result.done.content, new RegExp(`^30 秒内仍为旧 IP：${OLD_IP}`));
  assert.match(result.done.content, /提交回应：网络请求失败：The request timed out\.；未重复提交/);
  assert.match(result.done.content, new RegExp(`保护期至：${fmt(START + 300)}`));
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(result.state.status, "unclear");
  assert.strictEqual(result.state.requestedAt, START);
  assert.strictEqual(result.state.busyUntil, START + 300);
  assert.strictEqual(result.state.checkedAt, START + 30);

  const blocked = run(env, { argument: changeArg("&confirm_seconds=30", true) });
  assert.strictEqual(blocked.calls.length, 0);
  assert.strictEqual(blocked.notifications.length, 0);
  assert.strictEqual(
    blocked.done.content,
    `上一次提交结果不明确，处于保护期\n${fmt(START + 300)} 后可再试\n未请求 API，不扣次数`
  );

  env.now = (START + 301) * 1000;
  const later = run(env, {
    argument: changeArg(),
    responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [changeOk({ next_allowed_at: START + 361 })] },
  });
  assert.deepStrictEqual(later.paths, [GET_IP, CHANGE_IP]);
});

test("5xx, non-JSON and 內部錯誤 submits are inconclusive", () => {
  const cases = [
    apiError("內部錯誤，請稍後再試"),
    apiError("Bad Gateway", 502),
    { status: 200, body: "<html>oops</html>" },
    networkError("timeout", { latency: 15 }),
  ];
  for (const reply of cases) {
    const env = createEnv();
    const result = run(env, {
      argument: changeArg("", true),
      responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [reply] },
    });
    assert.strictEqual(result.count(CHANGE_IP), 1);
    assert.strictEqual(result.timers, 0);
    assert.strictEqual(result.done.title, "Boil IP 结果不明确");
    assert.match(result.done.content, /提交回应：.+；未重复提交/);
    assert.match(result.done.content, /1–3 分钟后点「Boil IP 查询」确认是否已变化/);
    assert.strictEqual(result.state.status, "unclear");
    assert.strictEqual(result.state.busyUntil, result.state.requestedAt + 300);
    assert.strictEqual(result.notifications.length, 1);
  }

  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=240"),
    responses: { [GET_IP]: sequence(ipOk(OLD_IP)), [CHANGE_IP]: [apiError("Bad Gateway", 503)] },
  });
  assert.strictEqual(result.count(CHANGE_IP), 1);
  assert.strictEqual(result.done.title, "Boil IP 结果不明确");
  assert.match(result.done.content, /^240 秒内仍为旧 IP/);
  assert.strictEqual(result.state.status, "unclear");
  assert.strictEqual(result.state.busyUntil, START + 300, "保护期不短于 300 秒");
});

test("inconclusive submit followed by a new IP is changed but keeps the protection window", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120", true),
    responses: {
      [GET_IP]: sequence(ipOk(OLD_IP), ipOk(OLD_IP), ipOk(NEW_IP)),
      [CHANGE_IP]: [apiError("內部錯誤，請稍後再試")],
    },
  });
  assert.strictEqual(result.count(CHANGE_IP), 1);
  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.strictEqual(
    result.done.content,
    [
      `旧 IP：${OLD_IP}`,
      `新 IP：${NEW_IP}`,
      "确认耗时：20 秒",
      "（提交回应不明确，但已确认 IP 变化）",
      `官方冷却时间未知，${fmt(START + 300)} 前的点击会在本地拦截`,
    ].join("\n")
  );
  assert.strictEqual(result.state.status, "changed");
  assert.strictEqual(result.state.newIp, NEW_IP);
  assert.strictEqual(result.state.nextAllowedAt, 0, "不明确提交没有官方 next_allowed_at");
  assert.strictEqual(result.state.busyUntil, START + 300, "保留不明确提交的保护期");
  assert.ok(result.state.busyUntil > START + 20);

  // 立即再点：本地拦截，不发请求、不通知。
  const blocked = run(env, { argument: changeArg("&confirm_seconds=120", true) });
  assert.strictEqual(blocked.calls.length, 0);
  assert.strictEqual(blocked.timers, 0);
  assert.strictEqual(blocked.notifications.length, 0);
  assert.strictEqual(blocked.done.title, "Boil IP 更换未提交");
  assert.strictEqual(
    blocked.done.content,
    `上一次更换刚确认完成，处于保护期\n${fmt(START + 300)} 后可再试\n未请求 API，不扣次数`
  );

  // 保护期结束后允许再次提交。
  env.now = (START + 301) * 1000;
  const later = run(env, {
    argument: changeArg(),
    responses: { [GET_IP]: [ipOk(NEW_IP)], [CHANGE_IP]: [changeOk({ next_allowed_at: START + 361 })] },
  });
  assert.deepStrictEqual(later.paths, [GET_IP, CHANGE_IP]);
});

test("accepted submit confirmed as changed clears busyUntil and relies on next_allowed_at", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120"),
    responses: {
      [GET_IP]: sequence(ipOk(OLD_IP), ipOk(NEW_IP)),
      [CHANGE_IP]: [changeOk({ next_allowed_at: START + 90 })],
    },
  });
  assert.strictEqual(result.state.status, "changed");
  assert.strictEqual(result.state.busyUntil, 0);
  assert.doesNotMatch(result.done.content, /官方冷却时间未知/);

  const blocked = run(env, { argument: changeArg() });
  assert.strictEqual(blocked.calls.length, 0);
  assert.strictEqual(blocked.done.content, `冷却中，下次可更换：${fmt(START + 90)}\n未请求 API，不扣次数`);
});

test("far-future next_allowed_at does not lock local changes (bounded cooldown)", () => {
  const twoDays = START + 2 * 24 * 3600;

  // 冷却分支：超过 24 小时的 nextAllowedAt 不参与拦截，正常请求。
  let env = createEnv();
  seedState(env, { nextAllowedAt: twoDays, newIp: OLD_IP, requestedAt: START - 3600 });
  let result = run(env, {
    argument: changeArg(),
    responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [changeOk()] },
  });
  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP]);
  assert.strictEqual(result.done.title, "Boil IP 更换已提交");

  // 24 小时内的 nextAllowedAt 仍然拦截，不发请求。
  env = createEnv();
  seedState(env, { nextAllowedAt: START + 600 });
  result = run(env, { argument: changeArg() });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(result.done.content, `冷却中，下次可更换：${fmt(START + 600)}\n未请求 API，不扣次数`);

  // 忙碌分支：显示的可再试时间忽略异常的 nextAllowedAt，只看 busyUntil。
  env = createEnv();
  seedState(env, { status: "pending", requestedAt: START - 10, busyUntil: START + 100, nextAllowedAt: twoDays });
  result = run(env, { argument: changeArg() });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(
    result.done.content,
    `上一次更换仍在确认新 IP\n${fmt(START + 100)} 后可再试\n未请求 API，不扣次数`
  );

  // 查询面板仍可显示官方给出的时间（不拦截，只展示）。
  env = createEnv();
  seedState(env, { nextAllowedAt: twoDays, newIp: OLD_IP, requestedAt: START - 3600 });
  result = run(env, { argument: queryArg(), responses: { [GET_IP]: [ipOk(OLD_IP)] } });
  assert.match(result.done.content, new RegExp(`下次可更换：${fmt(twoDays)}`));
});

/* ---------- 更换：本地保护与官方错误 ---------- */

test("stored cooldown and busy records block without requests (AC6)", () => {
  let env = createEnv();
  seedState(env, { nextAllowedAt: START + 45 });
  let result = run(env, { argument: changeArg("&confirm_seconds=120", true) });
  assert.strictEqual(result.calls.length, 0);
  assert.strictEqual(result.done.content, `冷却中，下次可更换：${fmt(START + 45)}\n未请求 API，不扣次数`);

  const busyCases = [
    ["requesting", "上一次更换仍在提交中"],
    ["pending", "上一次更换仍在确认新 IP"],
    ["unclear", "上一次提交结果不明确，处于保护期"],
  ];
  for (const [status, text] of busyCases) {
    env = createEnv();
    seedState(env, { status, requestedAt: START - 10, busyUntil: START + 100, nextAllowedAt: START + 50 });
    result = run(env, { argument: changeArg("&confirm_seconds=120") });
    assert.strictEqual(result.calls.length, 0, status);
    assert.strictEqual(result.done.title, "Boil IP 更换未提交");
    assert.strictEqual(
      result.done.content,
      `${text}\n${fmt(START + 100)} 后可再试\n未请求 API，不扣次数`
    );
  }

  // 其他 Token 的记录或损坏的记录不阻止更换。
  for (const raw of [
    JSON.stringify({ v: 1, token: "00000000", status: "pending", busyUntil: START + 100, nextAllowedAt: START + 100 }),
    "{not json",
  ]) {
    env = createEnv();
    env.store[STATE_KEY] = raw;
    result = run(env, {
      argument: changeArg(),
      responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [changeOk()] },
    });
    assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP]);
  }
});

test("rate-limit error stores next allowed time and blocks the next click (AC6)", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120", true),
    responses: {
      [GET_IP]: [ipOk(OLD_IP)],
      [CHANGE_IP]: [apiError(`頻率限制中，下次可用時間：${START + 90}`)],
    },
  });
  assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP]);
  assert.strictEqual(result.timers, 0);
  assert.strictEqual(result.done.title, "Boil IP 更换失败");
  assert.strictEqual(result.done.style, "error");
  assert.strictEqual(
    result.done.content,
    [
      `頻率限制中，下次可用時間：${START + 90}`,
      "官方规定本次调用已扣 1 次 API",
      `下次可更换：${fmt(START + 90)}，之前点击会在本地拦截`,
    ].join("\n")
  );
  assert.strictEqual(result.notifications.length, 1);
  assert.strictEqual(result.state.nextAllowedAt, START + 90);
  assert.strictEqual(result.state.busyUntil, 0);

  const blocked = run(env, { argument: changeArg("&confirm_seconds=120", true) });
  assert.strictEqual(blocked.calls.length, 0);
  assert.match(blocked.done.content, new RegExp(`冷却中，下次可更换：${fmt(START + 90)}`));

  // 13 位毫秒时间戳；已有记录保留原状态与字段。
  const withRecord = createEnv();
  seedState(withRecord, { status: "changed", newIp: NEW_IP, requestedAt: START - 3600, usesLeft: 1 });
  const ms = run(withRecord, {
    argument: changeArg(),
    responses: {
      [GET_IP]: [ipOk(NEW_IP)],
      [CHANGE_IP]: [apiError(`頻率限制中，下次可用時間：${(START + 75) * 1000}`)],
    },
  });
  assert.strictEqual(ms.state.nextAllowedAt, START + 75);
  assert.strictEqual(ms.state.status, "changed");
  assert.strictEqual(ms.state.newIp, NEW_IP);
  assert.strictEqual(ms.state.usesLeft, 1);
  assert.strictEqual(ms.state.requestedAt, START - 3600);
});

test("official errors give actionable hints and clear the lock (AC8)", () => {
  const cases = [
    ["用戶與機器不匹配，API已失效", /^API Token 已失效（用戶與機器不匹配）。请到 ippanel\.boil\.network 重新获取 Token 并更新模块参数。$/],
    ["當日更換IP次數已用完：5/5次", /^當日更換IP次數已用完：5\/5次\n官方规定本次调用已扣 1 次 API，请勿重复点击。$/],
    ["當前機器不允許更換IP", /^當前機器不允許更換IP\n官方规定本次调用已扣 1 次 API，请勿重复点击。$/],
    ["頻率限制中", /^頻率限制中\n官方规定本次调用已扣 1 次 API，请勿重复点击。$/],
    ["僅允許POST", /^僅允許POST$/],
  ];
  for (const [message, expected] of cases) {
    const env = createEnv();
    const result = run(env, {
      argument: changeArg("&confirm_seconds=120", true),
      responses: {
        [GET_IP]: [ipOk(OLD_IP)],
        [CHANGE_IP]: [apiError(message, message === "僅允許POST" ? 405 : 400)],
      },
    });
    assert.deepStrictEqual(result.paths, [GET_IP, CHANGE_IP], message);
    assert.strictEqual(result.done.title, "Boil IP 更换失败", message);
    assert.match(result.done.content, expected, message);
    assert.strictEqual(result.notifications.length, 1, message);
    assert.strictEqual(result.state, null, message);
  }

  // 2xx 但没有 ok:true 视为明确失败，不按不明确处理。
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=120"),
    responses: { [GET_IP]: [ipOk(OLD_IP)], [CHANGE_IP]: [json(200, { ok: false, error: "未知错误" })] },
  });
  assert.strictEqual(result.done.title, "Boil IP 更换失败");
  assert.strictEqual(result.done.content, "未知错误");
  assert.strictEqual(result.state, null);
});

/* ---------- 结束保障与存储 ---------- */

test("throwing notification still reaches $done once", () => {
  const result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=20", true),
    notificationThrows: true,
    responses: { [GET_IP]: sequence(ipOk(OLD_IP), ipOk(NEW_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.done.title, "Boil IP 已更换");
});

test("storage write failure is noted on the panel", () => {
  const env = createEnv();
  const result = run(env, {
    argument: changeArg("&confirm_seconds=20"),
    writeFails: true,
    responses: { [GET_IP]: sequence(ipOk(OLD_IP), ipOk(NEW_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.match(result.done.content, /\n（本地记录写入失败）$/);
  assert.strictEqual(result.state, null);
});

test("runs without $persistentStore", () => {
  const result = run(createEnv(), {
    argument: changeArg("&confirm_seconds=20"),
    noStore: true,
    responses: { [GET_IP]: sequence(ipOk(OLD_IP), ipOk(NEW_IP)), [CHANGE_IP]: [changeOk()] },
  });
  assert.strictEqual(result.done.title, "Boil IP 已更换");
  assert.doesNotMatch(result.done.content, /本地记录写入失败/);
});

test("script does not depend on clearTimeout", () => {
  assert.doesNotMatch(script, /clearTimeout\s*\(/);
  assert.doesNotMatch(script, /toLocaleString/);
});

/* ---------- 执行 ---------- */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
if (failed) {
  console.log(`${failed}/${tests.length} boil-ip-manager tests failed`);
  process.exit(1);
}
console.log(`boil-ip-manager tests passed (${tests.length})`);
