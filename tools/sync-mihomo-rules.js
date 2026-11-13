"use strict";

// 由 surge-rules/<名称>.list 生成 mihomo-rules/<名称>.yaml（classical 规则集）。
// 用法：node tools/sync-mihomo-rules.js          检查是否同步
//       node tools/sync-mihomo-rules.js --write  重新生成
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const NAMES = ["Gemini", "AIOther"];
const SUPPORTED = /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6|IP-ASN|PROCESS-NAME),[^,\s]+(,no-resolve)?$/;

function render(name) {
  const source = `surge-rules/${name}.list`;
  const lines = fs.readFileSync(path.join(root, source), "utf8").split(/\r?\n/);
  const out = [`# 由 ${source} 生成，请修改源文件后运行 node tools/sync-mihomo-rules.js --write`, "payload:"];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) { out.push("  " + line); continue; }
    if (!SUPPORTED.test(line)) throw new Error(`${source} 含 mihomo 不支持的规则：${line}`);
    out.push("  - " + line);
  }
  return out.join("\n") + "\n";
}

const write = process.argv.includes("--write");
const stale = [];
for (const name of NAMES) {
  const target = path.join(root, "mihomo-rules", `${name}.yaml`);
  const text = render(name);
  if (write) fs.writeFileSync(target, text);
  else if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) stale.push(name);
}
if (stale.length) {
  console.error(`mihomo 规则集未同步：${stale.join("、")}；运行 node tools/sync-mihomo-rules.js --write`);
  process.exit(1);
}
console.log(write ? `已生成：${NAMES.join("、")}` : `mihomo 规则集已同步：${NAMES.join("、")}`);
