const express = require("express");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").split("\n").forEach((line) => {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  });
}

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR.replace(/^~/, process.env.HOME || ""))
  : path.join(__dirname, "data");

app.use(express.static(__dirname));

app.get("/api/manifest", (req, res) => {
  const manifestPath = path.join(DATA_DIR, "_manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: "No _manifest.json in DATA_DIR", data_dir: DATA_DIR });
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Invalid manifest JSON: ${err.message}` });
  }
});

app.get("/api/data/:file", (req, res) => {
  const requested = req.params.file;
  if (!/^[\w.-]+\.(json|js)$/.test(requested)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(DATA_DIR, requested);
  if (!filePath.startsWith(DATA_DIR)) {
    return res.status(400).json({ error: "Path traversal blocked" });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found", requested });
  }
  res.sendFile(filePath);
});

// POST /api/refresh-manifest — rebuild _manifest.json from the .json files
// actually present in DATA_DIR. Sorts newest-first by synced_at (fallback to
// filesystem mtime). Each entry preserves metadata from the file's own
// `source` block if present. Invoked by the sidebar's "Refresh" button.
app.post("/api/refresh-manifest", (req, res) => {
  try {
    if (!fs.existsSync(DATA_DIR) || !fs.statSync(DATA_DIR).isDirectory()) {
      return res.status(500).json({ error: "DATA_DIR does not exist", data_dir: DATA_DIR });
    }

    const entries = fs
      .readdirSync(DATA_DIR)
      .filter((name) => name.endsWith(".json"))
      .filter((name) => name !== "_manifest.json") // never include the manifest itself
      .map((filename) => {
        const filePath = path.join(DATA_DIR, filename);
        const stat = fs.statSync(filePath);
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        } catch (_) {
          parsed = null; // malformed JSON — still list the file but with minimal metadata
        }
        const src = (parsed && parsed.source) || {};
        const isFixture = filename.startsWith("_fixture");
        return {
          filename,
          table_name: src.table_name || filename.replace(/\.json$/, ""),
          notion_url: src.notion_url || "",
          data_source_id: src.data_source_id || "",
          synced_at: src.synced_at || stat.mtime.toISOString(),
          row_count: src.row_count != null ? src.row_count : (Array.isArray(parsed && parsed.tasks) ? parsed.tasks.length : null),
          is_fixture: isFixture,
        };
      });

    // Newest-first by synced_at. Ties broken by filename for deterministic order.
    entries.sort((a, b) => {
      if (a.synced_at < b.synced_at) return 1;
      if (a.synced_at > b.synced_at) return -1;
      return a.filename.localeCompare(b.filename);
    });

    const manifest = {
      version: 1,
      generated_at: new Date().toISOString(),
      files: entries,
    };

    const manifestPath = path.join(DATA_DIR, "_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    res.json(manifest);
  } catch (err) {
    res.status(500).json({ error: `Refresh failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  const usingCustomDir = !!process.env.DATA_DIR;
  console.log(`\n  PPGantt running at http://localhost:${PORT}`);
  console.log(`  Data:  ${DATA_DIR}${usingCustomDir ? " (from DATA_DIR)" : " (default)"}\n`);
});
