---
name: meta-api-imagegen
description: Generate or edit raster images through YuanHeng when the user requests an image, poster, thumbnail, illustration, or visual asset, or an image would help complete their ongoing task. Use reference images for requested edits. Viewing, describing, or analyzing an image alone does not require generation.
---

# YuanHeng ImageGen

Generate or edit the image needed for the current task, show the result using the
host application's supported image, attachment, or artifact display, then continue
any remaining work. The user does not need to name this skill. Inspecting or
explaining an existing image alone does not request generation.

## Run the installed skill

Use `scripts/run_imagegen.mjs` next to this SKILL.md as the only entry point.
Resolve the actual installed skill directory; do not assume a Codex directory.
The quoted absolute paths below work with ordinary shell execution on supported
platforms. Keep the output in the user's task directory.

```text
node "<absolute skill directory>/scripts/run_imagegen.mjs" --prompt "Create a polished product poster..." --out "<absolute task directory>/poster.png"
```

For an edit, preserve the user's specified details and provide the reference:

```text
node "<absolute skill directory>/scripts/run_imagegen.mjs" --image "<absolute path>/product.png" --prompt "Keep the product unchanged and replace the background with a clean studio background." --out "<absolute task directory>/product-edited.png"
```

Repeat `--image` for multiple references. Use a PNG `--mask` for a masked edit.
Choose a new output name unless the user requested replacing an existing output.
The helper validates inputs and output access before sending an image request.
If Node is unavailable, explain that execution is unavailable in this host;
do not substitute another account or issue a second image request elsewhere.

Generation can take several minutes. If the host returns a running command or
job/session ID, keep waiting on that same job using its supported progress tools.
A wait timeout is not a failed generation and must not start a new command.

## Current tool connection and model

Each installed copy has a credential-free `yuanheng-binding.json` pointing to
that tool's runtime file managed by YuanHeng. The helper uses this binding to
reach the local Core and the image connection configured for that tool in
YuanHeng. Its image group can differ from the tool's chat group. Keep the
YuanHeng client open so it can restore an independent image connection if Core
restarts; a missing credential sync requires reopening YuanHeng.
Missing, invalid, or disabled bindings/routes require reconfiguration in
YuanHeng. Do not borrow another application's route or read Codex credentials
for DSH, WorkBuddy, or another host.

OpenCode may discover Claude's installed skills. When its verified shell marker
identifies OpenCode, the launcher rejects every other tool's binding before any
request, including explicit connection overrides. Enable and use OpenCode's own
copy instead. If another tool inherited that marker because it was launched
inside OpenCode, start an independent session. Do not clear the marker or invoke
the lower-level helper to bypass this check.

Codex CLI and desktop share a tool group; the terminal bridge selects its own
surface and otherwise the configured default applies. Other applications always
use their own namespace. WorkBuddy code-mode installation and an office-mode
ZIP import use the same bundle. An imported copy's binding points to this
computer's stable runtime file, so later Core port changes are picked up without
reimporting. A ZIP copied to another computer needs configuration there.

The helper reads the model directory through that same route and selects the
newest numbered `gpt-image-*` version, including namespaced IDs such as
`openai/gpt-image-2.5-sunburst`; the full directory ID is preserved in requests.
Within one version, quality takes priority: available 2.5 Sunburst is preferred
over 2.5 Flare. New numeric versions
are discovered automatically. A directory failure or empty eligible catalog
stops generation; an unavailable model is never invented. Honor an explicit user
model choice with `--image-model <id>`, which skips automatic selection.
`--quality` controls the API quality parameter separately and defaults to `auto`.

Useful options:

- `--image-model <id>` for an explicit model; default is `auto`.
- `--size 1024x1024`, `--quality auto`, `--output-format png` (also jpeg or webp).
- `--force` to replace an existing output after successful generation.
- `--dry-run` to inspect the plan without network requests; automatic selection
  remains unresolved until a real execution reads the model directory.
- `--direct-only` to forbid the optional Codex compatibility route.
- `--responses-only`, `--responses-model <id>`, and `--responses-quality <value>`
  only when intentionally using a supported Responses compatibility route.

Explicitly requested `--base-url` or `--api-key` can override the managed
connection. Environment API keys do not override a managed runtime. Never print
credentials or copy them into commands, logs, or final responses; prefer existing
configured access. The lower-level helper retains legacy `CODEX_HOME` support for
older Codex integrations; do not bypass this skill's binding by invoking it.

## Failure handling

When the image directory has no eligible model, relay that error and direct the
user to choose a group with GPT Image access in YuanHeng's Image Generation
capability. The current chat group may only provide text models. Do not assume
the whole account lacks image access, guess model IDs, or try another group's
credential. `--image-model` selects a model; it does not grant permission. A
directory failure occurs before generation and must not trigger guessed image
requests.

Generation uses the Images API. For routes supporting compatibility fallback,
only an explicit unsupported-endpoint response permits one Responses attempt;
the selected image model is passed to the image tool separately from the outer
chat model. An independently configured image group uses its dedicated Images
route and cannot fall back through the chat connection. Other tool routes use
the direct Images API exclusively. Masks are never discarded to enable fallback.

Network, rate-limit, quota/model/content, server, incomplete stream, or local
save failures must not cause the agent to rerun generation automatically. A
failed request may already have been billed: explain the failure and wait for
the user's retry decision. Partial images and truncated streams are not success.
When reporting a result, distinguish the requested image model from an
upstream's undisclosed internal mapping.

## Display and continue

If the host has an available image-viewing tool and a vision-capable model,
inspect the saved result before assessing its visual quality. DSH or another
host using a text-only model should use the helper's validated saved-file result
and must not force an unsupported image-reading tool or claim to have visually
inspected it.

Show the image using the host's supported preview, attachment, or result area.
In Codex, use an absolute-path embed such as
`![Generated poster](/absolute/path/poster.png)`. WorkBuddy and other hosts may
not render a local Markdown image inside chat; use their supported file/result
presentation, and state the saved location if no preview is available. Do not
promise native chat embedding without verifying support. Continue any remaining
writing, design, coding, or other work in the user's original request.
