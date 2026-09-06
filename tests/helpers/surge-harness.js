"use strict";

const fs = require("node:fs");
const vm = require("node:vm");

/** 用合成的网络响应和持久化存储运行一个完整的 Surge 脚本。 */
async function runScript(filename, options = {}) {
  const {
    store = {}, request, response, argument, http,
    timeoutMs = 1500, scriptType, now, omitClearTimeout = false, notificationError,
  } = options;
  const requests = [];
  const notifications = [];
  const logs = [];
  const pendingTimers = new Set();
  let doneCount = 0;
  let doneValue;
  let resolveDone;
  let rejectDone;
  const completion = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timer = setTimeout(() => rejectDone(new Error("脚本未在测试期限内调用 $done")), timeoutMs);
  const DateClass = now === undefined ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  };
  const context = {
    $environment: { system: "macOS", "surge-version": "6.9.0", "surge-build": "12250" },
    $script: { name: "fixture", type: scriptType || (response ? "http-response" : request ? "http-request" : "cron") },
    $persistentStore: {
      read(key) { return Object.hasOwn(store, key) ? store[key] : null; },
      write(value, key) {
        if (typeof key !== "string" || !key) throw new Error("测试要求使用明确的存储键");
        if (value === null) delete store[key];
        else {
          if (typeof value !== "string") throw new Error("Surge 持久化存储只接受字符串");
          store[key] = value;
        }
        return true;
      },
    },
    $notification: { post(title, subtitle, body, notificationOptions) {
      if (notificationError) throw new Error(notificationError);
      notifications.push({ title, subtitle, body, options: notificationOptions });
    } },
    console: Object.fromEntries(["log", "warn", "error", "info", "debug"].map((level) => [level,
      (...args) => logs.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")),
    ])),
    $done(value) {
      doneCount += 1;
      doneValue = value;
      // 等待已排队的回调完成，使重复 $done 也能被断言发现。
      setImmediate(resolveDone);
    },
    Date: DateClass,
    setTimeout(callback, delay, ...args) {
      const handle = setTimeout(() => {
        pendingTimers.delete(handle);
        try { callback(...args); } catch (error) { rejectDone(error); }
      }, delay);
      pendingTimers.add(handle);
      return handle;
    },
    clearTimeout(handle) { pendingTimers.delete(handle); clearTimeout(handle); },
    $httpClient: {},
  };
  if (omitClearTimeout) delete context.clearTimeout;
  if (request !== undefined) context.$request = structuredClone(request);
  if (response !== undefined) context.$response = structuredClone(response);
  if (argument !== undefined) context.$argument = argument;
  for (const method of ["get", "post", "put", "delete", "head", "options", "patch"]) {
    context.$httpClient[method] = (input, callback) => {
      const requestOptions = typeof input === "string" ? { url: input } : structuredClone(input);
      const index = requests.length;
      requests.push({ method, ...requestOptions });
      Promise.resolve().then(() => {
        if (!http) throw new Error(`测试未配置 HTTP 响应：${method} ${requestOptions.url}`);
        return http(method, requestOptions, index);
      }).then((result) => {
        if (!result) throw new Error("测试 HTTP 响应不能为空");
        const body = typeof result.body === "object" ? JSON.stringify(result.body) : result.body ?? "";
        callback(result.error || null, { status: result.status ?? 200, headers: result.headers || {} }, body);
      }).catch(rejectDone);
    };
  }
  try {
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename, timeout: timeoutMs });
    await completion;
    await new Promise((resolve) => setImmediate(resolve));
    return { requests, notifications, logs, store, doneCount, doneValue };
  } finally {
    clearTimeout(timer);
    for (const handle of pendingTimers) clearTimeout(handle);
  }
}

module.exports = { runScript };
