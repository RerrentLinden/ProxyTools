const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const script = fs.readFileSync(path.join(__dirname, "..", "boil-ip-manager.js"), "utf8");
const moduleText = fs.readFileSync(path.join(__dirname, "..", "boil-ip-manager.sgmodule"), "utf8");

assert.doesNotMatch(moduleText, /type=(?:cron|event)\b/);
assert.doesNotMatch(moduleText.split("[Panel]")[1], /update-interval\s*=/);
assert.match(
  moduleText,
  /https:\/\/raw\.githubusercontent\.com\/RerrentLinden\/ProxyTools\/main\/boil-ip-manager\.js/
);
assert.match(moduleText, /change_enabled:false/);

function runCase({ argument, response, error }) {
  const calls = [];
  const notifications = [];
  let doneValue;

  const context = {
    $argument: argument,
    $httpClient: {
      post(options, callback) {
        calls.push(options);
        callback(error || null, response && { status: response.status }, response && response.body);
      },
    },
    $notification: {
      post(title, subtitle, body) {
        notifications.push({ title, subtitle, body });
      },
    },
    $done(value) {
      doneValue = value;
    },
    console,
  };

  vm.runInNewContext(script, context);
  return { calls, notifications, doneValue };
}

{
  const result = runCase({
    argument: "action=change&api_token=secret&enabled=false&notify=true",
  });
  assert.strictEqual(result.calls.length, 0);
  assert.match(result.doneValue.content, /开关已关闭/);
}

{
  const result = runCase({
    argument: "action=query&api_token=secret&enabled=true&notify=true",
    response: { status: 200, body: '{"ok":true,"ip":"42.3.69.25"}' },
  });
  assert.strictEqual(result.calls.length, 1);
  assert.strictEqual(result.calls[0].url, "https://ippanel.boil.network/api/v1/getIP");
  assert.strictEqual(result.calls[0].headers.Authorization, "Bearer secret");
  assert.match(result.doneValue.content, /42\.3\.69\.25/);
  assert.strictEqual(result.notifications.length, 0);
}

{
  const result = runCase({
    argument: "action=change&api_token=secret&enabled=true&notify=false",
    response: {
      status: 200,
      body: '{"ok":true,"message":"正在執行更換IP","uses_left":2,"next_allowed_at":1782732942}',
    },
  });
  assert.strictEqual(result.calls.length, 1);
  assert.strictEqual(result.calls[0].url, "https://ippanel.boil.network/api/v1/changeIP/");
  assert.match(result.doneValue.content, /更换请求已接受/);
  assert.match(result.doneValue.content, /剩余 API 次数：2/);
  assert.match(result.doneValue.content, /不代表新 IP 已经生效/);
  assert.strictEqual(result.notifications.length, 0);
}

{
  const result = runCase({
    argument: "action=change&api_token=secret&enabled=true&notify=true",
    response: { status: 400, body: '{"error":"頻率限制中，下次可用時間：123"}' },
  });
  assert.strictEqual(result.calls.length, 1);
  assert.match(result.doneValue.content, /頻率限制中/);
  assert.strictEqual(result.notifications.length, 1);
}

{
  const result = runCase({
    argument: "action=query&api_token=&enabled=true&notify=true",
  });
  assert.strictEqual(result.calls.length, 0);
  assert.match(result.doneValue.content, /填写 API Token/);
}

{
  const result = runCase({
    argument: "action=query&api_token=secret&enabled=true&notify=true",
    response: { status: 200, body: "not-json" },
  });
  assert.match(result.doneValue.content, /不是有效 JSON/);
}

console.log("boil-ip-manager tests passed");
