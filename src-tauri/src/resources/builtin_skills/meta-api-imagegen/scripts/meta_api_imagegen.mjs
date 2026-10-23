#!/usr/bin/env node

import {
  readFile,
  mkdir,
  access,
  lstat,
  open,
  rename,
  link,
  unlink,
  realpath,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULTS = {
  baseUrl: "https://meta-api.vip/v1",
  imageModel: "auto",
  responsesModel: "gpt-5.5",
  size: "1024x1024",
  quality: "auto",
  outputFormat: "png",
  out: "output/imagegen/output.png",
};
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
  const args = { ...DEFAULTS, images: [] };
  const valueOptions = new Map([
    ["--api-key", "apiKey"],
    ["--base-url", "baseUrl"],
    ["--prompt", "prompt"],
    ["--prompt-file", "promptFile"],
    ["--mask", "mask"],
    ["--out", "out"],
    ["--image-model", "imageModel"],
    ["--responses-model", "responsesModel"],
    ["--size", "size"],
    ["--quality", "quality"],
    ["--responses-quality", "responsesQuality"],
    ["--output-format", "outputFormat"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--image" || valueOptions.has(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${token} requires a value`);
      if (token === "--image") args.images.push(value);
      else args[valueOptions.get(token)] = value;
      if (token === "--base-url") args.explicitBaseUrl = true;
      continue;
    }
    if (token === "--direct-only") args.directOnly = true;
    else if (token === "--responses-only") args.responsesOnly = true;
    else if (token === "--force") args.force = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (args.directOnly && args.responsesOnly)
    throw new Error("Use --direct-only or --responses-only, not both");
  if (args.mask && !args.images.length)
    throw new Error("--mask requires an --image");
  if (args.mask && args.responsesOnly)
    throw new Error(
      "Masked edits require the direct Images API; Responses cannot preserve the mask",
    );
  if (!["png", "jpeg", "webp"].includes(args.outputFormat))
    throw new Error("--output-format must be png, jpeg, or webp");
  return args;
}

function printHelp() {
  console.log(
    `YuanHeng ImageGen\n\nUsage:\n  meta_api_imagegen.mjs --prompt <text> [options]\n\nOptions:\n  --image <path>           Add an edit/reference image (repeatable)\n  --mask <path>            Optional mask (direct edit API only)\n  --out <path>             Output path\n  --image-model <model>    Default: auto; newest available GPT Image, quality first\n  --base-url <url>         Explicit direct API base URL (overrides YuanHeng runtime)\n  --api-key <key>          Explicit API key (overrides YuanHeng runtime)\n  --size <size>            Image size (default: 1024x1024)\n  --quality <quality>      Image quality (default: auto)\n  --responses-model <id>   Outer Responses chat model (default: gpt-5.5)\n  --responses-quality <q>  Optional separate fallback quality\n  --output-format <format> png, jpeg, or webp\n  --direct-only            Do not use the Responses fallback\n  --responses-only         Skip the direct Images API\n  --force                  Overwrite an existing output\n  --dry-run                Inspect the plan without network requests or model lookup`,
  );
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Invalid API base URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "API base URL must not contain credentials, query parameters, or fragments",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error(
      "API base URL must use HTTPS (HTTP is allowed only for loopback)",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return url.toString().replace(/\/+$/, "");
}

function codexHome() {
  return resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"));
}

async function readOptionalJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${label}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid ${label}; repair the configuration before generating`,
    );
  }
}

function validateApiKey(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const key = value.trim();
  if (
    /^(?:PROXY_MANAGED|YOUR[_ -].*|PLACEHOLDER|NONE|NULL|UNDEFINED)$/i.test(
      key,
    ) ||
    /^eyJ[A-Za-z0-9_-]+\./.test(key) ||
    /\s/.test(key)
  ) {
    throw new Error(
      "Refusing an OAuth token or placeholder as an API key; configure YuanHeng or supply a real API key",
    );
  }
  return key;
}

async function resolveConnection(args) {
  if (!args.apiKey && !args.explicitBaseUrl) {
    const runtime = await readOptionalJson(
      resolve(codexHome(), "yuanheng-imagegen.json"),
      "YuanHeng image runtime",
    );
    if (runtime !== undefined) {
      if (
        !runtime ||
        runtime.owner !== "yuanheng-imagegen" ||
        runtime.version !== 1 ||
        typeof runtime.enabled !== "boolean"
      ) {
        throw new Error(
          "Invalid YuanHeng image runtime; reconfigure Codex in YuanHeng",
        );
      }
      if (!runtime.enabled)
        throw new Error(
          "YuanHeng image routing is disabled; select YuanHeng relay mode and configure Codex first",
        );
      const surface = process.env.YUANHENG_IMAGEGEN_SURFACE;
      if (surface && !["codex", "chatgpt-desktop"].includes(surface))
        throw new Error("Unknown YuanHeng image surface");
      const baseUrl =
        surface === "codex"
          ? runtime.terminalBaseUrl
          : surface === "chatgpt-desktop"
            ? runtime.desktopBaseUrl
            : runtime.baseUrl;
      if (!baseUrl)
        throw new Error(
          "YuanHeng image routing is unavailable for this Codex surface; reconfigure this tool in YuanHeng",
        );
      const match =
        typeof baseUrl === "string" &&
        /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/(?:codex|chatgpt-desktop)\/v1$/.exec(
          baseUrl,
        );
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535)
        throw new Error(
          "Invalid YuanHeng image runtime address; reconfigure Codex in YuanHeng",
        );
      return {
        baseUrl,
        headers: {},
        catalogPath: "/images/models",
        source: "yuanheng-local",
      };
    }
  }
  let apiKey = validateApiKey(
    args.apiKey || process.env.NAN_API_KEY || process.env.OPENAI_API_KEY,
  );
  if (!apiKey) {
    const auth = await readOptionalJson(
      resolve(codexHome(), "auth.json"),
      "Codex API credentials",
    );
    // Official-login OAuth credentials are not third-party Images API credentials.
    if (
      auth &&
      auth.auth_mode !== "chatgpt" &&
      !(auth.tokens && auth.auth_mode !== "apikey")
    ) {
      apiKey = validateApiKey(auth.NAN_API_KEY || auth.OPENAI_API_KEY);
    }
  }
  if (!args.dryRun && !apiKey)
    throw new Error(
      "Missing API key or YuanHeng runtime; configure Codex in YuanHeng or supply NAN_API_KEY/OPENAI_API_KEY",
    );
  return {
    baseUrl: normalizeBaseUrl(args.baseUrl),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    catalogPath: "/models",
    source: "direct-api",
  };
}

async function loadPrompt(args) {
  if (args.prompt && args.promptFile)
    throw new Error("Use --prompt or --prompt-file, not both");
  const prompt = args.promptFile
    ? (await readFile(args.promptFile, "utf8")).trim()
    : args.prompt?.trim();
  if (!prompt) throw new Error("Missing prompt. Use --prompt or --prompt-file");
  return prompt;
}

function imageMime(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new Error("Image data is not PNG, JPEG, or WebP");
}

async function prepareFiles(args) {
  const outputPath = resolve(args.out);
  let existing;
  try {
    existing = await lstat(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && !args.force)
    throw new Error(
      `Output already exists: ${outputPath} (use --force to overwrite)`,
    );
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(
      "Output must be a regular file, not a directory or symbolic link",
    );
  const inputs = [];
  for (const path of [...args.images, ...(args.mask ? [args.mask] : [])]) {
    if (
      (await realpath(path)) ===
      (existing ? await realpath(outputPath) : outputPath)
    )
      throw new Error("Output must not overwrite a reference image or mask");
    const bytes = await readFile(path);
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error("Input image exceeds the 64 MiB helper limit");
    const mime = imageMime(bytes);
    inputs.push({ path, bytes, mime });
  }
  const mask = args.mask ? inputs.pop() : null;
  if (mask && mask.mime !== "image/png")
    throw new Error("The edit mask must be a PNG file");
  if (args.dryRun) return { outputPath, images: inputs, mask };
  await mkdir(dirname(outputPath), { recursive: true });
  await access(dirname(outputPath), fsConstants.W_OK);
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  await handle.close();
  return { outputPath, temporaryPath, images: inputs, mask };
}

class ApiError extends Error {
  constructor(status, unsupported, code) {
    super(
      `HTTP ${status}${code ? ` (${code})` : ""}; request failed${unsupported ? ": endpoint is unsupported" : ""}`,
    );
    this.unsupported = unsupported;
  }
}

function endpointUnsupported(status, data, text) {
  if (![404, 405, 501].includes(status)) return false;
  const rawCode = data?.error?.code ?? data?.error?.type ?? data?.code;
  const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";
  const message = String(data?.error?.message ?? data?.message ?? text)
    .trim()
    .toLowerCase();
  if (
    /model|channel|quota|billing|credit|balance|permission|policy|safety|content|account|token|authentication/.test(
      message,
    )
  )
    return false;
  const endpointCodes = new Set([
    "unsupported_endpoint",
    "endpoint_not_supported",
    "route_not_found",
    "method_not_allowed",
    "not_implemented",
    "unsupported_path",
  ]);
  if (code) return endpointCodes.has(code);
  return /^(?:404 page not found|not found|method not allowed|not implemented|(?:endpoint|route|path)(?: is)? (?:not found|not supported|unsupported|not implemented))[.!]?$/.test(
    message,
  );
}

async function readJson(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    /* A plain route-not-found response can still identify an unsupported endpoint. */
  }
  if (!response.ok) {
    const rawCode = data?.error?.code ?? data?.error?.type;
    // Do not log upstream bodies: a proxy can echo credentials or user content in errors.
    const knownCodes = new Set([
      "unsupported_endpoint",
      "endpoint_not_supported",
      "route_not_found",
      "method_not_allowed",
      "not_implemented",
      "model_not_found",
      "insufficient_quota",
      "content_policy_violation",
      "rate_limit_exceeded",
      "invalid_api_key",
    ]);
    const code = knownCodes.has(rawCode) ? rawCode : null;
    throw new ApiError(
      response.status,
      endpointUnsupported(response.status, data, text),
      code,
    );
  }
  if (!data || typeof data !== "object")
    throw new Error(
      "API returned invalid JSON; the image request will not be replayed",
    );
  if (data.error)
    throw new Error(
      "API returned an error; the image request will not be replayed",
    );
  return data;
}

function modelParts(id) {
  const match = /^gpt-image-(\d+(?:\.\d+)*)(?:-([a-z0-9-]+))?$/i.exec(id);
  if (!match) return null;
  const suffix = (match[2] || "").toLowerCase();
  const quality =
    suffix === "sunburst"
      ? 4
      : suffix === ""
        ? 3
        : /(?:flare|mini|fast)/.test(suffix)
          ? 1
          : 2;
  return { id, version: match[1].split(".").map(Number), quality };
}

async function chooseImageModel(args, connection) {
  if (args.imageModel !== "auto") return args.imageModel;
  const data = await readJson(
    await fetch(`${connection.baseUrl}${connection.catalogPath}`, {
      headers: connection.headers,
      redirect: "error",
    }),
  );
  if (!Array.isArray(data.data))
    throw new Error(
      "Image model directory is unavailable; no image request was sent",
    );
  const models = data.data.flatMap((item) =>
    typeof item?.id === "string" ? [modelParts(item.id)].filter(Boolean) : [],
  );
  models.sort((a, b) => {
    for (
      let index = 0;
      index < Math.max(a.version.length, b.version.length);
      index += 1
    ) {
      const difference = (b.version[index] || 0) - (a.version[index] || 0);
      if (difference) return difference;
    }
    return b.quality - a.quality || a.id.localeCompare(b.id);
  });
  if (!models.length)
    throw new Error(
      "No versioned GPT Image model is available to this credential; refresh platform access or specify --image-model explicitly",
    );
  return models[0].id;
}

async function saveResult(item, args, files) {
  let bytes;
  if (typeof item?.b64_json === "string") {
    if (
      item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json) ||
      item.b64_json.length % 4 === 1
    )
      throw new Error("Invalid image base64 data");
    bytes = Buffer.from(item.b64_json, "base64");
  } else if (typeof item?.url === "string") {
    let url;
    try {
      url = new URL(item.url);
    } catch {
      throw new Error("Invalid image download URL");
    }
    if (url.username || url.password)
      throw new Error("Image download URL must not contain credentials");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Image download URL must use HTTPS");
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok)
      throw new Error(`Image download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else
    throw new Error("Image response had neither final b64_json nor URL data");
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Generated image exceeds the 64 MiB helper limit");
  imageMime(bytes);
  const handle = await open(files.temporaryPath, "w");
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  if (args.force) await rename(files.temporaryPath, files.outputPath);
  else {
    // An output created while generation was running must never be overwritten.
    await link(files.temporaryPath, files.outputPath);
    await unlink(files.temporaryPath);
  }
  console.log(`WROTE_IMAGE=${files.outputPath}`);
}

async function directImages(args, connection, prompt, files) {
  const editing = files.images.length > 0;
  const url = `${connection.baseUrl}/images/${editing ? "edits" : "generations"}`;
  console.log(
    `TRY_DIRECT=${url} IMAGE_MODEL=${args.imageModel} MODE=${editing ? "edit" : "generate"}`,
  );
  let request;
  if (editing) {
    const form = new FormData();
    for (const [name, value] of Object.entries({
      model: args.imageModel,
      prompt,
      size: args.size,
      quality: args.quality,
      n: "1",
      output_format: args.outputFormat,
    }))
      form.append(name, value);
    for (const image of files.images)
      form.append(
        files.images.length === 1 ? "image" : "image[]",
        new Blob([image.bytes], { type: image.mime }),
        basename(image.path),
      );
    if (files.mask)
      form.append(
        "mask",
        new Blob([files.mask.bytes], { type: files.mask.mime }),
        basename(files.mask.path),
      );
    request = {
      method: "POST",
      headers: connection.headers,
      body: form,
      redirect: "error",
    };
  } else {
    request = {
      method: "POST",
      headers: { ...connection.headers, "Content-Type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        model: args.imageModel,
        prompt,
        size: args.size,
        quality: args.quality,
        n: 1,
        output_format: args.outputFormat,
      }),
    };
  }
  const data = await readJson(await fetch(url, request));
  if (!data.data?.[0])
    throw new Error(
      "Direct Images API returned no data[0]; the image request will not be replayed",
    );
  await saveResult(data.data[0], args, files);
  console.log(`ROUTE=direct-images IMAGE_MODEL=${args.imageModel}`);
}

function finalImage(output) {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (
      item?.type === "image_generation_call" &&
      item.status === "completed" &&
      typeof item.result === "string"
    )
      return item.result;
  }
  return null;
}

async function readResponsesImage(response) {
  if (!response.ok) return readJson(response);
  if (
    !(response.headers.get("content-type") || "").includes("text/event-stream")
  ) {
    const data = await readJson(response);
    if (data.status !== "completed")
      throw new Error("Responses request did not complete");
    const result = finalImage(data.output);
    if (!result) throw new Error("Responses completed without a final image");
    return result;
  }
  if (!response.body) throw new Error("Responses stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let image = null;
  let completed = false;
  function consume(frame) {
    const lines = frame.split("\n");
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const raw = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!raw || raw === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(
        "Malformed Responses stream; no successful image completion was confirmed",
      );
    }
    const type = event.type || eventName;
    if (
      event.error ||
      ["error", "response.failed", "response.incomplete"].includes(type) ||
      ["failed", "incomplete", "cancelled"].includes(event.response?.status)
    )
      throw new Error("Responses image generation failed or was incomplete");
    if (type === "response.output_item.done")
      image = finalImage([event.item]) || image;
    if (type === "response.completed") {
      if (event.response?.status !== "completed" || event.response?.error)
        throw new Error("Responses did not confirm successful completion");
      image = finalImage(event.response.output) || image;
      completed = true;
    }
    // partial_image_b64 and intermediate image events are deliberately ignored.
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim())
    throw new Error(
      "Responses stream was truncated before its final event boundary",
    );
  if (!completed || !image)
    throw new Error("Responses stream ended without a completed final image");
  return image;
}

async function responsesFallback(args, connection, prompt, files) {
  if (files.mask)
    throw new Error(
      "Masked edits cannot fall back to Responses because the mask would be lost",
    );
  const url = `${connection.baseUrl}/responses`;
  const content = [{ type: "input_text", text: prompt }];
  for (const image of files.images)
    content.push({
      type: "input_image",
      image_url: `data:${image.mime};base64,${image.bytes.toString("base64")}`,
    });
  const payload = {
    model: args.responsesModel,
    input: [{ role: "user", content }],
    tools: [
      {
        type: "image_generation",
        model: args.imageModel,
        size: args.size,
        quality: args.responsesQuality || args.quality,
        output_format: args.outputFormat,
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
  };
  console.log(
    `TRY_RESPONSES=${url} OUTER_MODEL=${args.responsesModel} IMAGE_MODEL=${args.imageModel}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...connection.headers,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    redirect: "error",
  });
  const result = await readResponsesImage(response);
  await saveResult({ b64_json: result }, args, files);
  console.log(
    `ROUTE=responses-tool REQUESTED_IMAGE_MODEL=${args.imageModel} OUTER_MODEL=${args.responsesModel}`,
  );
  console.log(
    "NOTE=The selected image model was explicitly requested in the tool; the provider controls actual execution.",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const prompt = await loadPrompt(args);
  const files = await prepareFiles(args);
  try {
    const connection = await resolveConnection(args);
    if (args.dryRun) {
      console.log(
        JSON.stringify({
          dryRun: true,
          connection: connection.source,
          baseUrl: connection.baseUrl,
          imageModel: args.imageModel,
          modelSelection:
            args.imageModel === "auto"
              ? "unresolved: no model-directory request in dry-run"
              : "explicit",
          route: args.responsesOnly ? "responses-tool" : "direct-images",
          outerModel: args.responsesModel,
          quality: args.quality,
          responsesQuality: args.responsesQuality || args.quality,
          size: args.size,
          outputFormat: args.outputFormat,
          images: args.images,
          mask: args.mask || null,
          outputPath: files.outputPath,
        }),
      );
      return;
    }
    args.imageModel = await chooseImageModel(args, connection);
    console.log(
      `SELECTED_IMAGE_MODEL=${args.imageModel} CONNECTION=${connection.source}`,
    );
    if (!args.responsesOnly) {
      try {
        await directImages(args, connection, prompt, files);
        return;
      } catch (error) {
        if (
          args.directOnly ||
          !(error instanceof ApiError) ||
          !error.unsupported ||
          files.mask
        )
          throw error;
        console.error(
          `DIRECT_UNSUPPORTED=${error.message}; trying Responses once`,
        );
      }
    }
    await responsesFallback(args, connection, prompt, files);
  } finally {
    if (files.temporaryPath) await unlink(files.temporaryPath).catch(() => {});
  }
}

main().catch((error) => {
  // Fetch/network errors can include remote text in causes; only emit our bounded top-level message.
  console.error(`ERROR=${error.message}`);
  process.exitCode = 1;
});
