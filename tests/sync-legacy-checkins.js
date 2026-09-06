"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const write = process.argv.includes("--write");
const modules = [
  ["deepflood.sgmodule", "deepflood.sgmodule", "DeepFlood[Token]"],
  ["nodeseek.sgmodule", "nodeseek.sgmodule", "NodeSeek[Token]"],
  ["sciencehub.sgmodule", "科研通自动签到.sgmodule", "科研通获取Cookie"],
];

for (const [canonical, legacy, captureName] of modules) {
  let text = fs.readFileSync(path.join(root, "surge-modules", canonical), "utf8");
  if (canonical === "deepflood.sgmodule" || canonical === "nodeseek.sgmodule") {
    // 旧入口没有 mode 参数，继续由旧的 *_default 存储值决定奖励模式。
    text = text.replace(/,mode:fixed/, "")
      .replace(/&mode=\{\{\{mode\}\}\}/g, "")
      .replace(/mode：fixed 固定奖励；random 随机奖励。\\n/, "");
  }
  const mapping = { cron: "定时签到", capture: "禁用脚本", mitm: "禁用MITM" };
  for (const [key, replacement] of Object.entries(mapping)) {
    text = text.replaceAll("{{{" + key + "}}}", "{{{" + replacement + "}}}")
      .replace(new RegExp("([=,])" + key + ":", "g"), "$1" + replacement + ":")
      .replaceAll(key + "：", replacement + "：");
  }
  text = text.replace(/禁用脚本:[^,\n]+/, "禁用脚本:" + captureName);
  text = "# 旧安装地址的兼容入口，由 tests/sync-legacy-checkins.js 从正式模块生成。\n" + text;
  const target = path.join(root, legacy);
  if (write) fs.writeFileSync(target, text);
  else assert.equal(fs.readFileSync(target, "utf8"), text, `旧入口未同步：${legacy}`);
}
const script = fs.readFileSync(path.join(root, "surge-modules", "scripts", "sciencehub.js"), "utf8");
const legacyScript = path.join(root, "sciencehub-script.js");
if (write) fs.writeFileSync(legacyScript, script);
else assert.equal(fs.readFileSync(legacyScript, "utf8"), script, "旧科研通 JS 入口未同步");
console.log(write ? "已同步四个旧入口，原有中文参数名保留。" : "四个旧入口与正式脚本保持一致。");
