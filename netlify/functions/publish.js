/**
 * Netlify Function: POST /.netlify/functions/publish
 * FIXED: 502 + No log — now handles both JSON (base64) and multipart/form-data,
 * uses CommonJS handler compatible with Netlify esbuild, extensive logging,
 * proper env var checks, and JSON error responses (never crashes).
 *
 * Env vars (Netlify dashboard → Site settings → Environment variables):
 *  - GITHUB_TOKEN  (required) PAT with `repo` scope
 *  - GITHUB_OWNER  (required) e.g. "mayurdevin"
 *  - GITHUB_REPO   (required) e.g. "rex-store"
 *  - GITHUB_BRANCH (optional) default "main"
 *  - APPS_JSON_PATH (optional) default "data/apps.json"
 *  - IMAGES_DIR     (optional) default "images/apps"
 *  - PUBLISH_KEY    (optional) if set, require header x-publish-key
 */

const GITHUB_API = "https://api.github.com";

// Use global fetch (Node 18+). Netlify Functions have it. Wrap to allow mocking.
function getFetch() {
  const f = (typeof global !== "undefined" && global.fetch) || (typeof globalThis !== "undefined" && globalThis.fetch);
  if (!f) console.error("[publish] FATAL: global fetch not available — Node version too old");
  return f;
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-publish-key, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `app-${Date.now()}`;
}
function sanitizeVersion(v) {
  return String(v).trim().replace(/\s+/g, "-");
}

// ---------- GitHub helpers with logging ----------
async function ghFetch(url, token, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rex-store-publish",
    ...(opts.headers || {}),
  };
  const _fetch = getFetch();
  if (!_fetch) throw new Error("fetch not available");
  try {
    const res = await _fetch(url, { ...opts, headers });
    return res;
  } catch (e) {
    console.error(`[publish] ghFetch network error for ${url}:`, e.message);
    throw e;
  }
}

async function getFileSha(owner, repo, path, branch, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const res = await ghFetch(url, token);
  if (res.status === 404) {
    console.log(`[publish] getFileSha 404 (not found, will create): ${path}`);
    return { sha: null, exists: false };
  }
  if (!res.ok) {
    const t = await res.text();
    console.error(`[publish] getFileSha failed for ${path}: ${res.status} ${t}`);
    throw new Error(`Failed to check ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha, exists: true, content: data.content };
}

async function putFile(owner, repo, path, base64Content, message, branch, token, existingSha = null) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const body = { message, content: base64Content, branch };
  if (existingSha) body.sha = existingSha;
  const res = await ghFetch(url, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`[publish] putFile failed for ${path}: ${res.status} ${t}`);
    throw new Error(`PUT ${path} failed ${res.status}: ${t}`);
  }
  return res.json();
}

async function uploadImageFile(owner, repo, branch, token, dirPrefix, fileName, base64, message) {
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "image.png";
  const path = `${dirPrefix}/${safe}`;
  let sha = null;
  try {
    const info = await getFileSha(owner, repo, path, branch, token);
    if (info.exists) sha = info.sha;
  } catch (e) {
    console.error(`[publish] uploadImageFile getSha error for ${path}:`, e.message);
  }
  try {
    await putFile(owner, repo, path, base64, message, branch, token, sha);
  } catch (e) {
    if (!sha && String(e.message).includes("sha")) {
      console.error(`[publish] uploadImageFile retrying with fresh sha for ${path}`);
      const info = await getFileSha(owner, repo, path, branch, token);
      await putFile(owner, repo, path, base64, message, branch, token, info.sha);
    } else {
      console.error(`[publish] uploadImageFile failed for ${path}:`, e.message);
      throw e;
    }
  }
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  console.log(`[publish] uploaded image -> ${rawUrl}`);
  return rawUrl;
}

// ---------- Multipart parser (no external deps) ----------
function getHeader(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k] || "";
  }
  return "";
}

function parseMultipart(event) {
  const headers = event.headers || {};
  const contentType = getHeader(headers, "content-type");
  if (!contentType || !contentType.toLowerCase().includes("multipart/form-data")) {
    return null;
  }
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    console.error("[publish] multipart missing boundary in Content-Type:", contentType);
    throw new Error("Invalid multipart/form-data: missing boundary");
  }
  const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim().replace(/^"|"$/g, "");
  console.log(`[publish] parsing multipart, boundary=${boundary.slice(0, 20)}..., isBase64Encoded=${event.isBase64Encoded}`);
  const bodyBuffer = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  if (!bodyBuffer.length) {
    console.error("[publish] multipart body empty");
    throw new Error("Empty multipart body");
  }

  // Use latin1 (binary) string to preserve byte values 0-255 for splitting
  const bodyStr = bodyBuffer.toString("binary");
  const boundaryStr = `--${boundary}`;
  const rawParts = bodyStr.split(boundaryStr);

  const fields = {};
  const files = {}; // key -> array of { filename, contentType, data: Buffer }

  // rawParts[0] is preamble, last is epilogue (--), skip
  for (let i = 1; i < rawParts.length; i++) {
    let part = rawParts[i];
    // Last boundary ends with --, and parts after that are empty
    if (part.startsWith("--")) break;
    // Trim leading \r\n and trailing \r\n
    if (part.startsWith("\r\n")) part = part.slice(2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      console.error("[publish] multipart part without header boundary, skipping");
      continue;
    }
    const headerStr = part.slice(0, headerEnd);
    let contentStr = part.slice(headerEnd + 4); // after \r\n\r\n

    // contentStr still in binary encoding; for files we need Buffer
    // Headers are ascii, safe to parse
    const headersArr = headerStr.split("\r\n");
    let disposition = "";
    let partContentType = "";
    for (const h of headersArr) {
      const lower = h.toLowerCase();
      if (lower.startsWith("content-disposition")) disposition = h;
      if (lower.startsWith("content-type")) partContentType = h.split(":")[1]?.trim() || "";
    }

    const nameMatch = disposition.match(/name="([^"]+)"/i) || disposition.match(/name=([^;]+)/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i) || disposition.match(/filename=([^;]+)/i);
    const fieldName = nameMatch ? nameMatch[1].replace(/"/g, "").trim() : null;
    const fileName = filenameMatch ? filenameMatch[1].replace(/"/g, "").trim() : null;

    if (!fieldName) {
      console.error("[publish] multipart part without name, skipping");
      continue;
    }

    if (fileName) {
      // file
      // contentStr is binary string; convert back to Buffer with 'binary'
      // Remove possible trailing \r\n that is part of multipart framing (already trimmed, but double-check)
      const data = Buffer.from(contentStr, "binary");
      console.log(`[publish] multipart file field=${fieldName} filename=${fileName} size=${data.length} type=${partContentType}`);
      if (!files[fieldName]) files[fieldName] = [];
      files[fieldName].push({ filename: fileName, contentType: partContentType || "application/octet-stream", data });
    } else {
      // field — decode from binary to utf8 (fields are text)
      const value = Buffer.from(contentStr, "binary").toString("utf8");
      // Handle duplicate field names (e.g., multiple screenshots field? not)
      if (fields[fieldName] !== undefined) {
        // if already exists, make array
        if (Array.isArray(fields[fieldName])) fields[fieldName].push(value);
        else fields[fieldName] = [fields[fieldName], value];
      } else {
        fields[fieldName] = value;
      }
      console.log(`[publish] multipart field ${fieldName}=${String(value).slice(0, 80)}`);
    }
  }

  return { fields, files };
}

// ---------- Main handler ----------
async function handler(event, context) {
  console.log("[publish] invoked", {
    method: event.httpMethod,
    path: event.path,
    hasBody: !!event.body,
    bodyLen: event.body ? event.body.length : 0,
    isBase64Encoded: !!event.isBase64Encoded,
    contentType: getHeader(event.headers || {}, "content-type"),
    headers: Object.keys(event.headers || {}),
  });

  try {
    if (event.httpMethod === "OPTIONS") {
      console.log("[publish] OPTIONS preflight");
      return jsonResponse(204, {});
    }
    if (event.httpMethod !== "POST") {
      console.error(`[publish] invalid method ${event.httpMethod}`);
      return jsonResponse(405, { error: "Method not allowed. Use POST." });
    }

    // Env var checks with logging (never log token value)
    const token = (process.env.GITHUB_TOKEN || "").trim();
    const owner = (process.env.GITHUB_OWNER || "").trim();
    const repo = (process.env.GITHUB_REPO || "").trim();
    const branch = (process.env.GITHUB_BRANCH || "main").trim();
    const appsJsonPath = (process.env.APPS_JSON_PATH || "data/apps.json").trim();
    const imagesDir = (process.env.IMAGES_DIR || "images/apps").trim();
    const expectedKey = (process.env.PUBLISH_KEY || "").trim();

    console.log(`[publish] env check`, {
      hasToken: !!token,
      tokenLen: token ? token.length : 0,
      owner: owner || "(missing)",
      repo: repo || "(missing)",
      branch,
      appsJsonPath,
      hasPublishKey: !!expectedKey,
    });

    if (expectedKey) {
      const actual = getHeader(event.headers, "x-publish-key");
      if (actual !== expectedKey) {
        console.error(`[publish] publish key mismatch: got ${actual ? "***" : "(empty)"} expected ***`);
        return jsonResponse(401, { error: "Unauthorized — invalid publish key" });
      }
      console.log("[publish] publish key validated");
    }

    if (!token || !owner || !repo) {
      console.error("[publish] missing required env vars", {
        hasToken: !!token,
        hasOwner: !!owner,
        hasRepo: !!repo,
      });
      return jsonResponse(500, {
        error: "Server not configured: missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO env vars. Set them in Netlify dashboard → Site settings → Environment variables and redeploy.",
        hint: "See README section 'Configure Netlify environment variables'. Ensure variables are set for all scopes and site is redeployed after setting.",
      });
    }

    // Global fetch check
    const _fetchCheck = getFetch();
    if (typeof _fetchCheck !== "function") {
      console.error("[publish] fetch not available in runtime");
      return jsonResponse(500, { error: "Server misconfigured: fetch not available. Use Node 18+ (set AWS_LAMBDA_JS_RUNTIME to nodejs20.x in netlify.toml)" });
    }

    // ---------- Parse payload: support both multipart/form-data and JSON ----------
    let payload = null; // for JSON path
    let parsedMultipart = null;
    let apkBuffer = null;
    let apkFileName = null;
    let iconFile = null; // { data: Buffer, filename, contentType }
    let screenshotFiles = []; // array of file objects

    let name, version, category, shortDesc, description, whatsNew, size;

    const ct = getHeader(event.headers, "content-type") || "";
    const isMultipart = ct.toLowerCase().includes("multipart/form-data");

    let providedId = "";
    let featuredRaw = null;

    if (isMultipart) {
      console.log("[publish] detected multipart/form-data, parsing...");
      try {
        parsedMultipart = parseMultipart(event);
      } catch (e) {
        console.error("[publish] multipart parse failed:", e.message, e.stack);
        return jsonResponse(400, { error: `Invalid multipart body: ${e.message}` });
      }
      if (!parsedMultipart) {
        console.error("[publish] multipart parse returned null");
        return jsonResponse(400, { error: "Failed to parse multipart body" });
      }
      const f = parsedMultipart.fields || {};
      const fl = parsedMultipart.files || {};

      providedId = (f.id || "").trim();
      name = (f.name || f.appName || "").trim();
      version = (f.version || "").trim();
      category = (f.category || "").trim();
      shortDesc = (f.shortDesc || "").trim();
      description = (f.description || "").trim();
      whatsNew = (f.whatsNew || f.whats_new || "").trim();
      size = (f.size || "").trim();
      featuredRaw = f.featured;

      // files
      // APK field may be 'apk', 'apkFile', 'file' — try common names
      const apkCandidates = ["apk", "apkFile", "file", "apk_file"];
      for (const k of apkCandidates) {
        if (fl[k] && fl[k][0]) {
          iconFile = iconFile; // keep
          apkBuffer = fl[k][0].data;
          apkFileName = fl[k][0].filename || "app.apk";
          console.log(`[publish] using apk from field ${k}`);
          break;
        }
      }
      // also check if only one file and field name is apk (already)
      if (!apkBuffer) {
        // fallback: if single file but field name mismatch, take first file that looks like apk
        const allFiles = Object.values(fl).flat();
        const apkLike = allFiles.find((x) => x.filename && x.filename.toLowerCase().endsWith(".apk"));
        if (apkLike) {
          apkBuffer = apkLike.data;
          apkFileName = apkLike.filename;
          console.log(`[publish] fallback apk detection: ${apkFileName}`);
        } else if (allFiles[0]) {
          // last resort: first file
          apkBuffer = allFiles[0].data;
          apkFileName = allFiles[0].filename || "app.apk";
          console.log(`[publish] fallback apk first file: ${apkFileName}`);
        }
      }

      // icon: field 'icon' or 'iconFile'
      if (fl.icon && fl.icon[0]) iconFile = fl.icon[0];
      else if (fl.iconFile && fl.iconFile[0]) iconFile = fl.iconFile[0];

      // screenshots: field 'screenshots', 'screenshots[]', 'shots'
      const shotKeys = ["screenshots", "screenshots[]", "shots", "images"];
      for (const k of shotKeys) {
        if (fl[k]) {
          screenshotFiles = screenshotFiles.concat(fl[k]);
        }
      }
      // limit 6
      screenshotFiles = screenshotFiles.slice(0, 6);
      console.log(`[publish] multipart parsed: name=${name}, version=${version}, apk=${apkFileName} ${apkBuffer ? apkBuffer.length : 0} bytes, icon=${iconFile ? iconFile.filename : "none"} ${iconFile ? iconFile.data.length : 0}, screenshots=${screenshotFiles.length}`);
    } else {
      // JSON path (legacy: base64)
      console.log("[publish] detected JSON (or unknown) content-type, parsing as JSON");
      let rawBody = event.body || "";
      // Handle isBase64Encoded for JSON (should not be, but handle)
      if (event.isBase64Encoded) {
        try {
          rawBody = Buffer.from(rawBody, "base64").toString("utf8");
          console.log("[publish] decoded base64 JSON body, len", rawBody.length);
        } catch (e) {
          console.error("[publish] failed to decode base64 body:", e.message);
        }
      }
      try {
        payload = JSON.parse(rawBody || "{}");
      } catch (e) {
        console.error("[publish] JSON parse failed:", e.message, "body preview:", String(rawBody).slice(0, 200));
        return jsonResponse(400, { error: "Invalid JSON body. Ensure Content-Type is application/json and body is valid JSON." });
      }
      console.log("[publish] JSON payload keys:", Object.keys(payload));

      providedId = (payload.id || "").trim();
      name = (payload.name || "").trim();
      version = (payload.version || "").trim();
      category = (payload.category || "").trim();
      shortDesc = (payload.shortDesc || "").trim();
      description = (payload.description || "").trim();
      whatsNew = (payload.whatsNew || "").trim();
      size = (payload.size || "").trim();
      featuredRaw = payload.featured;

      const apkBase64 = payload.apkBase64;
      apkFileName = payload.apkFileName || "app.apk";

      if (apkBase64) {
        try {
          apkBuffer = Buffer.from(apkBase64, "base64");
          console.log(`[publish] decoded apkBase64 len=${apkBase64.length} -> buffer ${apkBuffer.length}`);
        } catch (e) {
          console.error("[publish] apkBase64 decode failed:", e.message);
          return jsonResponse(400, { error: "Invalid apkBase64" });
        }
      }

      // icon: { base64, fileName }
      if (payload.icon && payload.icon.base64) {
        try {
          const b = Buffer.from(payload.icon.base64, "base64");
          iconFile = { data: b, filename: payload.icon.fileName || "icon.png", contentType: payload.icon.mime || "image/png" };
          console.log(`[publish] icon from JSON: ${iconFile.filename} ${b.length}`);
        } catch (e) {
          console.error("[publish] icon base64 decode failed:", e.message);
        }
      }
      if (Array.isArray(payload.screenshots)) {
        for (const s of payload.screenshots.slice(0, 6)) {
          if (!s.base64) continue;
          try {
            const b = Buffer.from(s.base64, "base64");
            screenshotFiles.push({ data: b, filename: s.fileName || `screenshot-${screenshotFiles.length + 1}.jpg`, contentType: s.mime || "image/jpeg" });
          } catch (e) {
            console.error("[publish] screenshot base64 decode failed:", e.message);
          }
        }
        console.log(`[publish] screenshots from JSON: ${screenshotFiles.length}`);
      }
    }

    // ---------- Validate ----------
    const missing = [];
    if (!name) missing.push("name");
    if (!version) missing.push("version");
    if (!category) missing.push("category");
    if (!shortDesc) missing.push("shortDesc");
    if (!description) missing.push("description");
    if (!whatsNew) missing.push("whatsNew");
    if (!apkBuffer || !apkBuffer.length) missing.push("apk (file)");
    if (missing.length) {
      console.error(`[publish] missing fields: ${missing.join(", ")}`, { name, version, category, apkLen: apkBuffer ? apkBuffer.length : 0 });
      return jsonResponse(400, { error: `Missing required fields: ${missing.join(", ")}` });
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(String(version).trim())) {
      console.error(`[publish] invalid version format: ${version}`);
      return jsonResponse(400, { error: "Version must be semver like 1.0.0" });
    }
    if (apkBuffer.length > 50 * 1024 * 1024) {
      console.error(`[publish] apk too large: ${apkBuffer.length} bytes`);
      return jsonResponse(413, { error: `APK too large (${(apkBuffer.length / 1024 / 1024).toFixed(1)} MB). GitHub Release asset limit is 2GB but Netlify Function limit is ~6MB. Try compressing or use manual upload.` });
    }
    if (apkBuffer[0] !== 0x50 || apkBuffer[1] !== 0x4b) {
      console.warn("[publish] APK does not start with PK header — may not be valid ZIP, continuing");
    }

    // Allow explicit id for edit flows (keeps slug stable when name changes); otherwise slugify name
    const id = providedId ? slugify(providedId) : slugify(name);
    const cleanVersion = sanitizeVersion(version);
    const tag = `${id}-v${cleanVersion}`;
    console.log(`[publish] id=${id} (provided=${!!providedId}) tag=${tag}`);

    // ---------- GitHub operations ----------
    try {
      // 1. Fetch current apps.json
      let apps = [];
      let appsSha = null;
      try {
        const info = await getFileSha(owner, repo, appsJsonPath, branch, token);
        if (info.exists) {
          appsSha = info.sha;
          const decoded = Buffer.from(info.content, "base64").toString("utf8");
          const parsed = JSON.parse(decoded);
          apps = Array.isArray(parsed) ? parsed : [];
          console.log(`[publish] loaded apps.json: ${apps.length} apps, sha=${appsSha.slice(0, 7)}`);
        } else {
          console.log(`[publish] apps.json not found at ${appsJsonPath}, will create new`);
        }
      } catch (e) {
        if (String(e.message).includes("404")) {
          console.log("[publish] apps.json 404, treating as empty");
        } else {
          console.error("[publish] failed to load apps.json:", e.message);
          throw e;
        }
      }

      // Check duplicate tag
      const tagCheckUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
      console.log(`[publish] checking tag exists: ${tag}`);
      const tagRes = await ghFetch(tagCheckUrl, token);
      if (tagRes.ok) {
        console.error(`[publish] tag already exists: ${tag}`);
        return jsonResponse(409, { error: `Tag ${tag} already exists — bump version` });
      } else if (tagRes.status !== 404) {
        const t = await tagRes.text();
        console.error(`[publish] tag check unexpected status ${tagRes.status}: ${t}`);
        // treat as not exists if 404 else error? Continue but log
      } else {
        console.log(`[publish] tag not exists, ok to create`);
      }

      // 2. Create Release
      const releaseUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases`;
      const releaseBody = {
        tag_name: tag,
        name: `${name} v${cleanVersion}`,
        body: `${description}\n\n---\n### What's New in v${cleanVersion}\n${whatsNew}`,
        draft: false,
        prerelease: false,
        generate_release_notes: false,
      };
      console.log(`[publish] creating release ${tag}...`);
      const relRes = await ghFetch(releaseUrl, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(releaseBody),
      });
      if (!relRes.ok) {
        const t = await relRes.text();
        console.error(`[publish] release creation failed: ${relRes.status} ${t}`);
        return jsonResponse(502, { error: `GitHub release creation failed: ${relRes.status} ${t}` });
      }
      const release = await relRes.json();
      const uploadUrlTemplate = release.upload_url;
      const uploadBase = uploadUrlTemplate.split("{")[0];
      console.log(`[publish] release created id=${release.id} upload_url=${uploadBase}`);

      // 3. Upload APK as release asset
      const apkUploadUrl = `${uploadBase}?name=${encodeURIComponent(apkFileName)}`;
      console.log(`[publish] uploading APK to ${apkUploadUrl} size=${apkBuffer.length}`);
      const _f = getFetch();
      const apkRes = await _f(apkUploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Length": String(apkBuffer.length),
          Accept: "application/vnd.github+json",
          "User-Agent": "rex-store-publish",
        },
        body: apkBuffer,
      });
      if (!apkRes.ok) {
        const t = await apkRes.text();
        console.error(`[publish] APK upload failed: ${apkRes.status} ${t}`);
        return jsonResponse(502, { error: `APK asset upload failed: ${apkRes.status} ${t}` });
      }
      const asset = await apkRes.json();
      const apkUrl = asset.browser_download_url || asset.url;
      console.log(`[publish] APK uploaded, url=${apkUrl}`);
      if (!apkUrl) {
        console.error("[publish] APK upload no url in response:", JSON.stringify(asset).slice(0, 300));
        return jsonResponse(502, { error: "APK upload succeeded but no download URL returned" });
      }

      // 4. Upload icon & screenshots via Contents API (optional, non-fatal)
      let iconUrl = null;
      const dirForApp = `${imagesDir}/${id}`;
      if (iconFile && iconFile.data && iconFile.data.length) {
        try {
          console.log(`[publish] uploading icon ${iconFile.filename} ${iconFile.data.length} bytes`);
          const base64 = iconFile.data.toString("base64");
          iconUrl = await uploadImageFile(owner, repo, branch, token, dirForApp, iconFile.filename || "icon.png", base64, `feat: add icon for ${id} v${cleanVersion}`);
        } catch (e) {
          console.error(`[publish] icon upload failed (non-fatal):`, e.message);
        }
      }
      const screenshotUrls = [];
      for (let i = 0; i < screenshotFiles.length; i++) {
        const s = screenshotFiles[i];
        if (!s.data || !s.data.length) continue;
        try {
          console.log(`[publish] uploading screenshot ${i + 1}/${screenshotFiles.length} ${s.filename} ${s.data.length}`);
          const base64 = s.data.toString("base64");
          const url = await uploadImageFile(owner, repo, branch, token, dirForApp, s.filename || `screenshot-${i + 1}.jpg`, base64, `feat: add screenshot ${i + 1} for ${id} v${cleanVersion}`);
          screenshotUrls.push(url);
        } catch (e) {
          console.error(`[publish] screenshot ${i} upload failed (non-fatal):`, e.message);
        }
      }

      // 5. Merge into apps.json
      const now = new Date().toISOString().slice(0, 10);
      const computedSize = size || `${(apkBuffer.length / 1024 / 1024).toFixed(1)} MB`;
      const existingIdx = apps.findIndex((a) => a.id === id);
      const existing = existingIdx >= 0 ? apps[existingIdx] : null;

      // Featured handling: respect provided flag if present, else keep existing or false
      let featured = existing?.featured ?? false;
      if (featuredRaw !== null && featuredRaw !== undefined && featuredRaw !== "") {
        if (typeof featuredRaw === "string") featured = featuredRaw === "true" || featuredRaw === "1" || featuredRaw.toLowerCase() === "on";
        else featured = !!featuredRaw;
      }
      const newApp = {
        id,
        name: String(name).trim(),
        version: cleanVersion,
        category: String(category).trim(),
        shortDesc: String(shortDesc).trim(),
        description: String(description).trim(),
        whatsNew: String(whatsNew).trim(),
        icon: iconUrl || existing?.icon || `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4e6.png`,
        screenshots: screenshotUrls.length ? screenshotUrls : existing?.screenshots || [],
        apkUrl,
        size: computedSize,
        featured,
        updatedAt: now,
      };

      if (existingIdx >= 0) {
        console.log(`[publish] updating existing app at index ${existingIdx}`);
        apps[existingIdx] = { ...existing, ...newApp };
      } else {
        console.log(`[publish] adding new app to catalog`);
        apps.unshift(newApp);
      }
      apps.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      const newContent = Buffer.from(JSON.stringify(apps, null, 2), "utf8").toString("base64");

      if (!appsSha) {
        try {
          const fresh = await getFileSha(owner, repo, appsJsonPath, branch, token);
          if (fresh.exists) {
            appsSha = fresh.sha;
            console.log(`[publish] re-fetched sha for apps.json: ${appsSha.slice(0, 7)}`);
          }
        } catch (e) {
          console.error("[publish] re-fetch sha failed:", e.message);
        }
      }

      const putBody = {
        message: existing ? `chore: update ${name} to v${cleanVersion}` : `feat: publish ${name} v${cleanVersion}`,
        content: newContent,
        branch,
      };
      if (appsSha) putBody.sha = appsSha;

      const putUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(appsJsonPath).replace(/%2F/g, "/")}`;
      console.log(`[publish] updating ${appsJsonPath} with ${apps.length} apps`);
      let putRes = await ghFetch(putUrl, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      });

      if (putRes.status === 409) {
        console.error("[publish] apps.json PUT 409 sha mismatch, refetching and retrying");
        const fresh = await getFileSha(owner, repo, appsJsonPath, branch, token);
        if (fresh.exists) {
          putBody.sha = fresh.sha;
          putRes = await ghFetch(putUrl, token, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(putBody),
          });
        }
      }

      if (!putRes.ok) {
        const t = await putRes.text();
        console.error(`[publish] apps.json update failed: ${putRes.status} ${t}`);
        return jsonResponse(502, { error: `Failed to update ${appsJsonPath}: ${putRes.status} ${t}. Release ${tag} and APK were created, but catalog not updated — please update manually.`, releaseUrl: release.html_url, apkUrl });
      }
      console.log(`[publish] SUCCESS: ${id} v${cleanVersion} published, tag=${tag}`);

      return jsonResponse(200, {
        success: true,
        id,
        tag,
        apkUrl,
        app: newApp,
        releaseUrl: release.html_url,
      });
    } catch (err) {
      console.error("[publish] unhandled error in GitHub flow:", err.stack || err.message);
      return jsonResponse(500, { error: err.message || String(err) });
    }
  } catch (err) {
    console.error("[publish] top-level unhandled error:", err.stack || err.message);
    return jsonResponse(500, { error: `Internal error: ${err.message || String(err)}` });
  }
}

// Export for Netlify — CommonJS (works with netlify/functions/package.json type=commonjs + esbuild)
exports.handler = handler;
module.exports.handler = handler;
