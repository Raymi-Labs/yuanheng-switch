import { readFileSync, openSync, closeSync, writeFileSync, constants, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const escape=(s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#!|~]/g, "\\$&")
    .replace(/\r?\n/g, "<br>");
const renderPreview=function renderPreview(draft) {
  const lines = [
    "# 商品文案草稿 / Product copy draft",
    "",
    "仅供人工审稿，未上架 / Human review required; not published.",
    "",
  ];
  for (const p of draft.products) {
    lines.push(
      `## ${p.sku}`,
      "",
      `价格 / Price (CNY): ${p.price_cny}`,
      "",
      `### ${escape(p.title_zh)}`,
      ...p.bullets_zh.map((s) => `- ${escape(s)}`),
      "",
      `### ${escape(p.title_en)}`,
      ...p.bullets_en.map((s) => `- ${escape(s)}`),
      "",
      `待确认字段 / Unknown fields: ${p.missing_information.map(escape).join(", ") || "—"}`,
      "",
    );
    lines.push(
      "### 原始事实核对 / Source facts",
      "",
      "| 字段 / Field | 原值 / Value |",
      "| --- | --- |",
    );
    const excluded = [
      "title_zh",
      "title_en",
      "bullets_zh",
      "bullets_en",
      "missing_information",
      "review_status",
      "supplier_note",
    ];
    for (const key of Object.keys(p)
      .filter((k) => !excluded.includes(k))
      .sort())
      lines.push(`| ${escape(key)} | ${escape(JSON.stringify(p[key]))} |`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
};
const input=fileURLToPath(new URL('listing-draft.json',import.meta.url));
const output=fileURLToPath(new URL('listing-draft.md',import.meta.url));
const inputFd=openSync(input,constants.O_RDONLY|constants.O_NOFOLLOW);
let draft;
try { const s=fstatSync(inputFd); if(!s.isFile()||s.size>4194304) throw Error('Invalid draft file'); draft=JSON.parse(readFileSync(inputFd,'utf8')); } finally { closeSync(inputFd); }
const preview=renderPreview(draft);
const outputFd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
try { if(!fstatSync(outputFd).isFile()) throw Error('Invalid output file'); const {ftruncateSync}=await import('node:fs'); ftruncateSync(outputFd,0); writeFileSync(outputFd,preview); } finally { closeSync(outputFd); }
