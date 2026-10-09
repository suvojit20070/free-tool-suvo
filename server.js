// server.js
const express = require("express");
const puppeteer = require("puppeteer");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: allow all origins
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === "::1" ||
      l === "::" ||
      l.startsWith("fc") ||
      l.startsWith("fd") ||
      l.startsWith("fe80") ||
      l.startsWith("::ffff:127.") ||
      l.startsWith("::ffff:10.") ||
      l.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function validateUrl(raw) {
  if (!raw) throw new Error("Missing 'web' parameter");

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });

  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("Private/local addresses are not allowed");
  }

  return url.toString();
}

function toInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// 1) Take screenshot
// GET /api/v1/take-ss?web=https://example.com&height=2000[&width=1280][&full=true]
app.get("/api/v1/take-ss", async (req, res) => {
  try {
    const url = await validateUrl(req.query.web);
    const width = toInt(req.query.width, 1280, 200, 3840);
    const height = toInt(req.query.height, 2000, 200, 10000);
    const fullPage = req.query.full === "true";

    const png = await withPage(async (page) => {
      await page.setViewport({ width, height });
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      return page.screenshot({ type: "png", fullPage });
    });

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(Buffer.from(png));
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2) Read web page (text content)
// GET /api/v1/read-web-page?web=https://example.com&max_length=20000
app.get("/api/v1/read-web-page", async (req, res) => {
  try {
    const url = await validateUrl(req.query.web);
    const maxLength = toInt(req.query.max_length, 20000, 100, 200000);

    const result = await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      return page.evaluate(() => {
        document
          .querySelectorAll("script, style, noscript, svg, iframe")
          .forEach((el) => el.remove());
        return {
          title: document.title || "",
          text: (document.body ? document.body.innerText : "")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        };
      });
    });

    const truncated = result.text.length > maxLength;

    res.json({
      success: true,
      url,
      title: result.title,
      length: Math.min(result.text.length, maxLength),
      total_length: result.text.length,
      truncated,
      content: result.text.slice(0, maxLength),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    endpoints: [
      "/api/v1/take-ss?web=website_url&height=2000",
      "/api/v1/read-web-page?web=website_url&max_length=20000",
    ],
  });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

async function shutdown() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
