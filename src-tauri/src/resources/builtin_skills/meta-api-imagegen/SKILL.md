---
name: meta-api-imagegen
description: Generate or edit raster images through YuanHeng when the user requests an image, poster, thumbnail, illustration, or visual asset, or an image would help complete their ongoing task. Use reference images for requested edits. Viewing, describing, or analyzing an image alone does not require generation.
---

# YuanHeng ImageGen

Use the bundled helper for image generation and editing during the conversation.
The user does not need to name this skill. Preserve the purpose of the current
task: generate the needed image, show it in the conversation, then continue the
remaining work. A request to inspect or explain an existing image does not itself
request a new image.

## Connection and model selection

The helper first reads `${CODEX_HOME:-$HOME/.codex}/yuanheng-imagegen.json`, a
credential-free runtime descriptor managed by YuanHeng. Requests go through the
local Core, which uses the configured tool's current platform credential and
group. Codex desktop uses the descriptor's default route (desktop preferred);
YuanHeng's terminal bridge sets `YUANHENG_IMAGEGEN_SURFACE=codex` to use its
separate terminal route. A missing surface, disabled route, invalid descriptor,
or stopped Core must be fixed in YuanHeng; do not switch accounts to bypass it.

Before generation, the helper reads the available model directory from that
same route and selects the newest numbered `gpt-image-*` version. Within the
same version, quality takes priority: for example, available 2.5 Sunburst is
preferred over 2.5 Flare. Version numbers are compared numerically, so newer
versions do not require a skill update. No unavailable model is invented. If the
directory fails or has no recognized image model, stop and explain the problem.
Respect an explicit user model choice with `--image-model <id>`; it takes priority
and skips automatic selection. `--quality` controls the API quality parameter
separately and defaults to `auto` for model compatibility.

For an explicitly requested direct connection, `--base-url` or `--api-key`
overrides the YuanHeng runtime. Without a runtime, direct mode also supports
`NAN_API_KEY`/`OPENAI_API_KEY` in the environment, then API-key credentials in
`${CODEX_HOME:-$HOME/.codex}/auth.json`. The default direct base is
`https://meta-api.vip/v1`; direct automatic selection reads `/models`. OAuth login
tokens and proxy placeholders are not API keys. Never print credentials or copy
them into commands, logs, or final responses; prefer existing configured access.

## Generate or edit

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/meta-api-imagegen/scripts/meta_api_imagegen.mjs" \
  --prompt "Create a polished product poster..." \
  --out "output/imagegen/poster.png"
```

For edits, inspect the reference first and preserve the user's specified details:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/meta-api-imagegen/scripts/meta_api_imagegen.mjs" \
  --image "input/product.png" \
  --prompt "Keep the product unchanged and replace the background with a clean studio background." \
  --out "output/imagegen/product-edited.png"
```

Repeat `--image` for multiple references. Use a PNG `--mask` for a masked edit;
masked requests require the direct Images Edit API. Choose a new output filename
unless the user requested replacing an existing output. The helper validates
inputs and output access before sending an image request.

Useful options:

- `--image-model <id>` to honor an explicit model choice; default is `auto`.
- `--size 1024x1024`, `--quality auto`, `--output-format png` (also jpeg or webp).
- `--responses-model <id>` to choose the outer Responses chat model.
- `--responses-quality <value>` to override quality on the compatibility route.
- `--direct-only` to forbid compatibility fallback.
- `--responses-only` to use the compatibility route intentionally (no mask).
- `--force` to replace an existing output after successful generation.
- `--dry-run` to inspect the plan without network requests; automatic model
  selection is explicitly unresolved until a real execution reads the directory.

## Routing and failure handling

The helper uses `POST /images/generations` or multipart `POST /images/edits`.
Only an explicit unsupported-endpoint response (404, 405, or 501, with no business
error) permits one fallback to `POST /responses`. Its `image_generation` tool
explicitly requests the selected image model; the outer chat model is separate.
Report the requested image model and successful route without claiming knowledge
of an upstream's undisclosed internal mapping.

Network failures, rate limits, quota/model/content errors, other server errors,
missing final image data, and local save failures do not trigger automatic
replay. A failed request may already have been billed: explain the error and
wait for the user's retry decision. Do not rerun with another model merely
because one request failed. Masks are never silently dropped for fallback.
Only a completed final image counts as success; partial or truncated streams do
not.

## Show the result and continue

Inspect the saved image before reporting success. Embed it using its absolute
filesystem path, for example `![Generated poster](/absolute/path/poster.png)`,
with a brief description and any material limitation. Do not stop at a path or a
statement that the image was generated. If the original request also includes
writing, design, coding, or another deliverable, continue that work with the
image after displaying it. Keep any user-requested output format and scope.
