"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const directory = path.join(root, "surge-modules");
const prefix = "https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/";
const expected = ["deepflood", "nodeseek", "sciencehub", "bilibili-manga", "bilibili-manga-exchange", "v2ex"];

function splitFields(value) {
  const result = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) { result.push(value.slice(start, index).trim()); start = index + 1; }
  }
  assert.equal(quoted, false, "参数引号未闭合");
  result.push(value.slice(start).trim());
  return result;
}

function render(text) {
  const definitions = text.match(/^#!arguments=(.*)$/m);
  const values = Object.create(null);
  for (const part of definitions ? definitions[1].split(",") : []) {
    const colon = part.indexOf(":");
    const key = colon < 0 ? part : part.slice(0, colon);
    assert.match(key, /^[A-Za-z0-9_]+$/, "正式模块参数必须使用 ASCII 标识");
    assert.ok(!Object.hasOwn(values, key), "模块参数名重复");
    values[key] = colon < 0 ? "" : part.slice(colon + 1);
  }
  const rendered = text.replace(/\{\{\{([^}]+)\}\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(values, key), `参数 ${key} 未声明`);
    return values[key];
  });
  assert.doesNotMatch(rendered, /\{\{\{|\}\}\}/, "模块存在未替换参数");
  return rendered;
}

const profileIndex = process.argv.indexOf("--profile-dir");
const profileDirectory = profileIndex >= 0 ? path.resolve(process.argv[profileIndex + 1]) : null;
if (profileDirectory) fs.mkdirSync(profileDirectory, { recursive: true });
const scriptFiles = new Set();
const scriptNames = new Set();
let scriptCount = 0;
for (const name of expected) {
  const filename = path.join(directory, name + ".sgmodule");
  const text = fs.readFileSync(filename, "utf8");
  assert.match(text, /^#!name=.+$/m);
  assert.match(text, /^#!category=签到任务$/m);
  const rendered = render(text);
  let section = "";
  const scriptLines = [];
  const hosts = [];
  for (const original of rendered.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line; continue; }
    if (section === "[MITM]") {
      assert.match(line, /^hostname\s*=\s*%APPEND%\s+/);
      hosts.push(line.replace("%APPEND%", ""));
    }
    if (section !== "[Script]") continue;
    const separator = line.indexOf("=");
    assert.ok(separator > 0, "脚本定义缺少等号");
    const scriptName = line.slice(0, separator).trim();
    assert.ok(!scriptNames.has(scriptName), `脚本名重复：${scriptName}`);
    scriptNames.add(scriptName);
    const fields = Object.create(null);
    for (const field of splitFields(line.slice(separator + 1))) {
      const equals = field.indexOf("=");
      assert.ok(equals > 0, `字段缺少赋值：${field}`);
      const key = field.slice(0, equals).trim();
      assert.ok(!Object.hasOwn(fields, key), `字段重复：${key}`);
      fields[key] = field.slice(equals + 1).trim().replace(/^"(.*)"$/, "$1");
    }
    assert.ok(["cron", "http-request", "http-response"].includes(fields.type), "脚本类型不在签到范围");
    assert.ok(Number(fields.timeout) > 0 && Number(fields.timeout) <= 180, "脚本应有明确且受限的超时");
    assert.ok(fields["script-path"] && fields["script-path"].startsWith(prefix), "执行脚本必须来自本仓库正式目录");
    const relative = fields["script-path"].slice(prefix.length);
    assert.match(relative, /^scripts\/[a-z0-9-]+\.js$/, "脚本路径无效");
    const scriptPath = path.join(directory, relative);
    assert.ok(fs.statSync(scriptPath).isFile(), `依赖未入库：${relative}`);
    scriptFiles.add(scriptPath);
    if (fields.type === "cron") assert.ok([5, 6].includes(fields.cronexp.trim().split(/\s+/).length), "Cron 字段数错误");
    else {
      assert.ok(fields.pattern, "捕获脚本缺少匹配模式");
      new RegExp(fields.pattern);
    }
    scriptLines.push(line.replace(fields["script-path"], scriptPath));
    scriptCount++;
  }
  assert.ok(scriptLines.length, "模块没有脚本");
  if (profileDirectory) {
    fs.writeFileSync(path.join(profileDirectory, name + ".conf"),
      "[General]\nloglevel = notify\n\n[Script]\n" + scriptLines.join("\n") +
      (hosts.length ? "\n\n[MITM]\n" + hosts.join("\n") : "") + "\n\n[Rule]\nFINAL,DIRECT\n");
  }
}
for (const file of scriptFiles) {
  const code = fs.readFileSync(file, "utf8");
  new vm.Script(code, { filename: file });
  assert.doesNotMatch(code, /\brequire\s*\(|\bimport\s*(?:\(|["'{*])|\beval\s*\(/,
    "正式脚本不得运行时加载其他代码");
}
console.log(`模块校验通过：${expected.length} 个模块，${scriptCount} 项脚本声明，${scriptFiles.size} 个仓库内自包含 JS。`);
if (profileDirectory) console.log("已生成逐模块原生 Surge 检查配置。 ");
