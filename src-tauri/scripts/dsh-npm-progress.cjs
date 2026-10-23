// Loaded only into our pinned private npm process. Observe its work without
// changing installation, retries or integrity checks. Never persist package paths.
const { writeFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");

const destination = join(process.cwd(), "package-progress.json");
const started = new Set();
const completed = new Set();
let unpacking = false;
let scheduled = false;

function publish() {
  scheduled = false;
  try {
    writeFileSync(
      `${destination}.tmp`,
      JSON.stringify({ completed: completed.size, total: started.size }),
    );
    renameSync(`${destination}.tmp`, destination);
  } catch {
    // Progress is optional; inability to write it must not break npm.
  }
}

process.on("time", (event, name) => {
  if (event === "start" && name === "reify:unpack") {
    unpacking = true;
    started.clear();
    completed.clear();
  } else if (
    unpacking &&
    typeof name === "string" &&
    name.startsWith("reifyNode:")
  ) {
    if (event === "start") started.add(name);
    if (event === "end" && started.has(name)) completed.add(name);
  } else if (event === "end" && name === "reify:unpack") {
    unpacking = false;
  } else {
    return;
  }
  // npm registers the unpack tasks synchronously before awaiting them. Publish
  // after that turn so the denominator is the full batch, not the first package.
  if (!scheduled) {
    scheduled = true;
    setImmediate(publish);
  }
});
