"use strict";

// 把 surge-rules/<名称>.list 同步到 mihomo-rules/<名称>.yaml（classical 规则集）。
// - FULL 中的规则集没有上游版本，整份由 .list 生成。
// - 其余 yaml 是 blackmatrix7 Clash 版快照；只把 .list 末尾「ProxyTools 补充」段同步到 yaml 末尾。
// 用法：node tools/sync-mihomo-rules.js          检查是否同步
//       node tools/sync-mihomo-rules.js --write  重新生成
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const FULL = ["AIOther"];
const HANDWRITTEN = ["Claude", "Claude_No_Resolve"]; // 手写，由测试检查与 Claude.list 一致
const MARKER = "# ===== ProxyTools 补充 =====";
const MODIFIED = (name) => `# MODIFIED: 末尾「ProxyTools 补充」段由 surge-rules/${name}.list 同步，请勿直接修改`;
const SUPPORTED = /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6|IP-ASN|PROCESS-NAME),[^,\s]+(,no-resolve)?$/;

function convert(lines, source) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) { out.push("  " + line); continue; }
    if (!SUPPORTED.test(line)) throw new Error(`${source} 含 mihomo 不支持的规则：${line}`);
    out.push("  - " + line);
  }
  return out;
}

function render(name, current) {
  const source = `surge-rules/${name}.list`;
  const list = fs.readFileSync(path.join(root, source), "utf8").split(/\r?\n/);
  if (FULL.includes(name)) {
    return [`# 由 ${source} 生成，请修改源文件后运行 node tools/sync-mihomo-rules.js --write`, "payload:",
      ...convert(list, source)].join("\n") + "\n";
  }
  const markerIndex = list.findIndex((line) => line.trim() === MARKER);
  const extra = markerIndex < 0 ? [] : convert(list.slice(markerIndex), source);
  let lines = current.replace(/\n+$/, "").split("\n");
  const cut = lines.findIndex((line) => line.trim() === MARKER);
  if (cut >= 0) lines = lines.slice(0, cut);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines = lines.filter((line) => line !== MODIFIED(name));
  if (extra.length) {
    const payload = lines.indexOf("payload:");
    lines.splice(payload, 0, MODIFIED(name));
    lines.push("", ...extra);
  }
  return lines.join("\n") + "\n";
}

const write = process.argv.includes("--write");
const stale = [];
const synced = [];
const names = fs.readdirSync(path.join(root, "mihomo-rules")).filter((f) => f.endsWith(".yaml"))
  .map((f) => f.slice(0, -5)).filter((n) => !HANDWRITTEN.includes(n));
for (const name of FULL) if (!names.includes(name)) names.push(name);
for (const name of names.sort()) {
  if (!fs.existsSync(path.join(root, "surge-rules", `${name}.list`))) continue;
  const target = path.join(root, "mihomo-rules", `${name}.yaml`);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const text = render(name, current);
  if (write) fs.writeFileSync(target, text);
  else if (current !== text) stale.push(name);
  synced.push(name);
}
if (stale.length) {
  console.error(`mihomo 规则集未同步：${stale.join("、")}；运行 node tools/sync-mihomo-rules.js --write`);
  process.exit(1);
}
console.log(`${write ? "已同步" : "已核对"}：${synced.join("、")}`);
