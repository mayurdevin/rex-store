/**
 * Netlify Function: POST /.netlify/functions/update
 * Updates app metadata in data/apps.json without creating a new GitHub Release.
 * Keeps existing apkUrl/release intact. Optionally uploads new icon/screenshots.
 * Body: JSON or multipart/form-data with fields: id*, name, version, category, shortDesc, description, whatsNew, size, featured
 * Files: icon, screenshots (multipart) or base64 in JSON { icon: { base64, fileName }, screenshots: [{base64, fileName}] }
 */

const GITHUB_API = "https://api.github.com";

function getFetch() {
  const f = (typeof global !== "undefined" && global.fetch) || (typeof globalThis !== "undefined" && globalThis.fetch);
  if (!f) console.error("[update] fetch not available");
  return f;
}
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-publish-key, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
function getHeader(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k] || "";
  return "";
}
async function ghFetch(url, token, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rex-store-update",
    ...(opts.headers || {}),
  };
  const _fetch = getFetch();
  if (!_fetch) throw new Error("fetch not available");
  const res = await _fetch(url, { ...opts, headers });
  return res;
}
async function getFileSha(owner, repo, path, branch, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return { sha: null, exists: false };
  if (!res.ok) {
    const t = await res.text();
    console.error(`[update] getFileSha ${path} ${res.status}: ${t}`);
    throw new Error(`Failed to check ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha, exists: true, content: data.content };
}
async function putFile(owner, repo, path, base64Content, message, branch, token, existingSha = null) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const body = { message, content: base64Content, branch };
  if (existingSha) body.sha = existingSha;
  const res = await ghFetch(url, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    console.error(`[update] putFile ${path} ${res.status}: ${t}`);
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
  } catch (e) { console.error(`[update] getSha error ${path}`, e.message); }
  try { await putFile(owner, repo, path, base64, message, branch, token, sha); }
  catch (e) {
    if (!sha && String(e.message).includes("sha")) {
      const info = await getFileSha(owner, repo, path, branch, token);
      await putFile(owner, repo, path, base64, message, branch, token, info.sha);
    } else throw e;
  }
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  console.log(`[update] uploaded ${rawUrl}`);
  return rawUrl;
}

function parseMultipart(event) {
  const ct = getHeader(event.headers, "content-type");
  if (!ct || !ct.toLowerCase().includes("multipart/form-data")) return null;
  const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing boundary");
  const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim().replace(/^"|"$/g, "");
  const bodyBuffer = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "", "utf8");
  if (!bodyBuffer.length) throw new Error("Empty multipart body");
  const bodyStr = bodyBuffer.toString("binary");
  const boundaryStr = `--${boundary}`;
  const rawParts = bodyStr.split(boundaryStr);
  const fields = {};
  const files = {};
  for (let i = 1; i < rawParts.length; i++) {
    let part = rawParts[i];
    if (part.startsWith("--")) break;
    if (part.startsWith("\r\n")) part = part.slice(2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd);
    let contentStr = part.slice(headerEnd + 4);
    const headersArr = headerStr.split("\r\n");
    let disposition = "";
    let partCT = "";
    for (const h of headersArr) {
      const lower = h.toLowerCase();
      if (lower.startsWith("content-disposition")) disposition = h;
      if (lower.startsWith("content-type")) partCT = h.split(":")[1]?.trim() || "";
    }
    const nameMatch = disposition.match(/name="([^"]+)"/i) || disposition.match(/name=([^;]+)/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i) || disposition.match(/filename=([^;]+)/i);
    const fieldName = nameMatch ? nameMatch[1].replace(/"/g, "").trim() : null;
    const fileName = filenameMatch ? filenameMatch[1].replace(/"/g, "").trim() : null;
    if (!fieldName) continue;
    if (fileName) {
      const data = Buffer.from(contentStr, "binary");
      if (!files[fieldName]) files[fieldName] = [];
      files[fieldName].push({ filename: fileName, contentType: partCT || "application/octet-stream", data });
    } else {
      const value = Buffer.from(contentStr, "binary").toString("utf8");
      if (fields[fieldName] !== undefined) {
        if (Array.isArray(fields[fieldName])) fields[fieldName].push(value);
        else fields[fieldName] = [fields[fieldName], value];
      } else fields[fieldName] = value;
    }
  }
  return { fields, files };
}

async function handler(event) {
  console.log("[update] invoked", { method: event.httpMethod, ct: getHeader(event.headers, "content-type"), hasBody: !!event.body });
  try {
    if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Use POST" });

    const token = (process.env.GITHUB_TOKEN || "").trim();
    const owner = (process.env.GITHUB_OWNER || "").trim();
    const repo = (process.env.GITHUB_REPO || "").trim();
    const branch = (process.env.GITHUB_BRANCH || "main").trim();
    const appsJsonPath = (process.env.APPS_JSON_PATH || "data/apps.json").trim();
    const imagesDir = (process.env.IMAGES_DIR || "images/apps").trim();
    const expectedKey = (process.env.PUBLISH_KEY || "").trim();

    console.log("[update] env", { hasToken: !!token, owner, repo });

    if (expectedKey) {
      const actual = getHeader(event.headers, "x-publish-key");
      if (actual !== expectedKey) return jsonResponse(401, { error: "Unauthorized — invalid publish key" });
    }
    if (!token || !owner || !repo) {
      console.error("[update] missing env");
      return jsonResponse(500, { error: "Server not configured: missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO" });
    }

    let id, name, version, category, shortDesc, description, whatsNew, size, featured;
    let iconFile = null;
    let screenshotFiles = [];

    const ct = getHeader(event.headers, "content-type") || "";
    const isMultipart = ct.toLowerCase().includes("multipart/form-data");

    if (isMultipart) {
      console.log("[update] parsing multipart");
      const parsed = parseMultipart(event);
      if (!parsed) return jsonResponse(400, { error: "Failed to parse multipart" });
      const f = parsed.fields || {};
      const fl = parsed.files || {};
      id = (f.id || "").trim();
      name = (f.name || "").trim();
      version = (f.version || "").trim();
      category = (f.category || "").trim();
      shortDesc = (f.shortDesc || "").trim();
      description = (f.description || "").trim();
      whatsNew = (f.whatsNew || "").trim();
      size = (f.size || "").trim();
      featured = f.featured;
      if (fl.icon && fl.icon[0]) iconFile = fl.icon[0];
      else if (fl.iconFile && fl.iconFile[0]) iconFile = fl.iconFile[0];
      const shotKeys = ["screenshots", "screenshots[]", "shots"];
      for (const k of shotKeys) if (fl[k]) screenshotFiles = screenshotFiles.concat(fl[k]);
      screenshotFiles = screenshotFiles.slice(0, 6);
    } else {
      let rawBody = event.body || "";
      if (event.isBase64Encoded) rawBody = Buffer.from(rawBody, "base64").toString("utf8");
      let payload;
      try { payload = JSON.parse(rawBody || "{}"); } catch (e) {
        console.error("[update] JSON parse failed", e.message);
        return jsonResponse(400, { error: "Invalid JSON" });
      }
      id = (payload.id || "").trim();
      name = (payload.name || "").trim();
      version = (payload.version || "").trim();
      category = (payload.category || "").trim();
      shortDesc = (payload.shortDesc || "").trim();
      description = (payload.description || "").trim();
      whatsNew = (payload.whatsNew || "").trim();
      size = (payload.size || "").trim();
      featured = payload.featured;
      if (payload.icon && payload.icon.base64) {
        try {
          const b = Buffer.from(payload.icon.base64, "base64");
          iconFile = { data: b, filename: payload.icon.fileName || "icon.png", contentType: payload.icon.mime || "image/png" };
        } catch (e) { console.error("[update] icon decode failed", e.message); }
      }
      if (Array.isArray(payload.screenshots)) {
        for (const s of payload.screenshots.slice(0, 6)) {
          if (!s.base64) continue;
          try {
            const b = Buffer.from(s.base64, "base64");
            screenshotFiles.push({ data: b, filename: s.fileName || `screenshot-${screenshotFiles.length+1}.jpg`, contentType: s.mime || "image/jpeg" });
          } catch (e) {}
        }
      }
      // Also support screenshots_clear flag?
    }

    if (!id) {
      console.error("[update] missing id");
      return jsonResponse(400, { error: "Missing required field: id" });
    }

    // Load apps.json
    let apps = [];
    let appsSha = null;
    try {
      const info = await getFileSha(owner, repo, appsJsonPath, branch, token);
      if (!info.exists) return jsonResponse(404, { error: "apps.json not found" });
      appsSha = info.sha;
      const decoded = Buffer.from(info.content, "base64").toString("utf8");
      apps = JSON.parse(decoded);
      if (!Array.isArray(apps)) apps = [];
      console.log(`[update] loaded ${apps.length} apps`);
    } catch (e) {
      console.error("[update] load apps.json failed", e.message);
      return jsonResponse(500, { error: e.message });
    }

    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1) {
      console.error(`[update] app not found ${id}`);
      return jsonResponse(404, { error: `App not found: ${id}` });
    }
    const existing = apps[idx];
    console.log(`[update] editing ${id} current v${existing.version}`);

    // Upload new icon/screenshots if provided
    let iconUrl = existing.icon;
    const dirForApp = `${imagesDir}/${id}`;
    if (iconFile && iconFile.data && iconFile.data.length) {
      try {
        console.log(`[update] uploading new icon ${iconFile.filename} ${iconFile.data.length}`);
        const b64 = iconFile.data.toString("base64");
        iconUrl = await uploadImageFile(owner, repo, branch, token, dirForApp, iconFile.filename || "icon.png", b64, `chore: update icon for ${id}`);
      } catch (e) {
        console.error("[update] icon upload failed", e.message);
        return jsonResponse(502, { error: `Icon upload failed: ${e.message}` });
      }
    }
    let screenshotUrls = existing.screenshots || [];
    if (screenshotFiles.length) {
      // If new screenshots provided, replace (or could append). Spec: update should replace.
      screenshotUrls = [];
      for (let i = 0; i < screenshotFiles.length; i++) {
        const s = screenshotFiles[i];
        try {
          console.log(`[update] uploading screenshot ${i+1} ${s.filename}`);
          const b64 = s.data.toString("base64");
          const url = await uploadImageFile(owner, repo, branch, token, dirForApp, s.filename || `screenshot-${i+1}.jpg`, b64, `chore: update screenshot ${i+1} for ${id}`);
          screenshotUrls.push(url);
        } catch (e) { console.error(`[update] screenshot ${i} failed`, e.message); }
      }
    }

    // Build updated app — keep apkUrl/size unless explicitly updating version with new APK via publish flow
    // For update without new release, keep existing apkUrl and size
    const now = new Date().toISOString().slice(0, 10);
    const updatedApp = {
      ...existing,
      name: name || existing.name,
      version: version || existing.version,
      category: category || existing.category,
      shortDesc: shortDesc || existing.shortDesc,
      description: description || existing.description,
      whatsNew: whatsNew || existing.whatsNew,
      icon: iconUrl,
      screenshots: screenshotUrls,
      size: size || existing.size,
      updatedAt: now,
    };
    if (featured !== undefined) {
      // featured may be "true"/"false" string from FormData
      if (typeof featured === "string") updatedApp.featured = featured === "true" || featured === "1";
      else updatedApp.featured = !!featured;
    }

    apps[idx] = updatedApp;
    apps.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const newContent = Buffer.from(JSON.stringify(apps, null, 2), "utf8").toString("base64");
    const putUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(appsJsonPath).replace(/%2F/g, "/")}`;
    const putBody = { message: `chore: update ${updatedApp.name} (${id}) metadata`, content: newContent, branch, sha: appsSha };
    console.log(`[update] putting ${appsJsonPath}`);
    let putRes = await ghFetch(putUrl, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(putBody) });
    if (putRes.status === 409) {
      console.error("[update] 409 retry");
      const fresh = await getFileSha(owner, repo, appsJsonPath, branch, token);
      if (fresh.exists) {
        const freshApps = JSON.parse(Buffer.from(fresh.content, "base64").toString("utf8"));
        const freshIdx = freshApps.findIndex(a => a.id === id);
        if (freshIdx !== -1) freshApps[freshIdx] = updatedApp;
        else freshApps.unshift(updatedApp);
        putBody.sha = fresh.sha;
        putBody.content = Buffer.from(JSON.stringify(freshApps, null, 2), "utf8").toString("base64");
        putRes = await ghFetch(putUrl, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(putBody) });
      }
    }
    if (!putRes.ok) {
      const t = await putRes.text();
      console.error(`[update] PUT failed ${putRes.status}: ${t}`);
      return jsonResponse(502, { error: `Failed to update ${appsJsonPath}: ${putRes.status} ${t}` });
    }
    console.log(`[update] SUCCESS ${id}`);
    return jsonResponse(200, { success: true, id, app: updatedApp });
  } catch (err) {
    console.error("[update] error", err.stack || err.message);
    return jsonResponse(500, { error: err.message || String(err) });
  }
}

exports.handler = handler;
module.exports.handler = handler;
