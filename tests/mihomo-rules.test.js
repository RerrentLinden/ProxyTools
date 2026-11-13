"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const rules = (text, prefix) => text.split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && l !== "payload:")
  .map((l) => (prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l));

test("生成的 mihomo 规则集与 Surge 源文件同步", () => {
  execFileSync(process.execPath, [path.join(root, "tools", "sync-mihomo-rules.js")], { stdio: "pipe" });
});

test("手写的 Claude yaml 与 Claude.list 规则一致", () => {
  const list = rules(fs.readFileSync(path.join(root, "surge-rules", "Claude.list"), "utf8"));
  for (const name of ["Claude.yaml", "Claude_No_Resolve.yaml"]) {
    const yaml = rules(fs.readFileSync(path.join(root, "mihomo-rules", name), "utf8"), "- ");
    assert.deepEqual(yaml, list, name);
  }
});
