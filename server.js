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

app.listen(PORT, () => {
  const usingCustomDir = !!process.env.DATA_DIR;
  console.log(`\n  PPGantt running at http://localhost:${PORT}`);
  console.log(`  Data:  ${DATA_DIR}${usingCustomDir ? " (from DATA_DIR)" : " (default)"}\n`);
});
