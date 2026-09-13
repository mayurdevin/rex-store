/**
 * Netlify Function: POST /.netlify/functions/publish
 * Creates a GitHub Release, uploads APK as asset, uploads icons/screenshots,
 * and updates data/apps.json — all server-side with GITHUB_TOKEN never exposed.
 *
 * Env vars (set in Netlify dashboard → Site settings → Environment variables):
 *  - GITHUB_TOKEN  (required) classic or fine-grained PAT with `repo` scope
 *  - GITHUB_OWNER  (required) e.g. "your-username"
 *  - GITHUB_REPO   (required) e.g. "rex-store"
 *  - GITHUB_BRANCH (optional) default "main"
 *  - APPS_JSON_PATH (optional) default "data/apps.json"
 *  - IMAGES_DIR     (optional) default "images/apps"
 *  - PUBLISH_KEY    (optional) if set, request must send header x-publish-key: <value>
 */

const GITHUB_API = "https://api.github.com";
const UPLOADS_API = "https://uploads.github.com";

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-publish-key, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  // keep as-is but ensure no spaces; tag will be slug-vVERSION
  return String(v).trim().replace(/\s+/g, "-");
}

async function ghFetch(url, token, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rex-store-publish",
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  return res;
}

async function getFileSha(owner, repo, path, branch, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return { sha: null, exists: false };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Failed to check ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha, exists: true, content: data.content, decoded: Buffer.from(data.content, "base64").toString("utf8") };
}

async function putFile(owner, repo, path, base64Content, message, branch, token, existingSha = null) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const body = {
    message,
    content: base64Content,
    branch,
  };
  if (existingSha) body.sha = existingSha;
  const res = await ghFetch(url, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    // if sha missing error, caller may retry with fetched sha
    throw new Error(`PUT ${path} failed ${res.status}: ${t}`);
  }
  return res.json();
}

async function uploadImageFile(owner, repo, branch, token, dirPrefix, fileName, base64, message) {
  // sanitize fileName
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const path = `${dirPrefix}/${safe}`;
  // try to get existing sha
  let sha = null;
  try {
    const info = await getFileSha(owner, repo, path, branch, token);
    if (info.exists) sha = info.sha;
  } catch (_) {
    // ignore, will try without sha
  }
  try {
    await putFile(owner, repo, path, base64, message, branch, token, sha);
  } catch (e) {
    // if sha required error, retry with fetched sha
    if (!sha && String(e.message).includes("sha")) {
      const info = await getFileSha(owner, repo, path, branch, token);
      await putFile(owner, repo, path, base64, message, branch, token, info.sha);
    } else {
      throw e;
    }
  }
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  return rawUrl;
}

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {}, {});
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." });
  }

  // Optional publish key protection
  const expectedKey = process.env.PUBLISH_KEY;
  if (expectedKey) {
    const got = event.headers["x-publish-key"] || event.headers["X-Publish-Key"] || event.headers["x-publish-key".toLowerCase()];
    // Netlify lowercases headers
    const headerKey = event.headers["x-publish-key"] || event.headers["x-publish-key".toLowerCase()] || "";
    // also check case-insensitive
    const actual = Object.entries(event.headers).find(([k]) => k.toLowerCase() === "x-publish-key")?.[1] || "";
    if (actual !== expectedKey) {
      return jsonResponse(401, { error: "Unauthorized — invalid publish key" });
    }
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  const appsJsonPath = process.env.APPS_JSON_PATH || "data/apps.json";
  const imagesDir = process.env.IMAGES_DIR || "images/apps";

  if (!token || !owner || !repo) {
    return jsonResponse(500, {
      error: "Server not configured: missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO env vars. See README.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { name, version, category, shortDesc, description, whatsNew, size, apkBase64, apkFileName, icon, screenshots } = payload;

  // Validate required
  const missing = [];
  if (!name) missing.push("name");
  if (!version) missing.push("version");
  if (!category) missing.push("category");
  if (!shortDesc) missing.push("shortDesc");
  if (!description) missing.push("description");
  if (!whatsNew) missing.push("whatsNew");
  if (!apkBase64) missing.push("apkBase64");
  if (!apkFileName) missing.push("apkFileName");
  if (missing.length) {
    return jsonResponse(400, { error: `Missing required fields: ${missing.join(", ")}` });
  }

  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(String(version).trim())) {
    return jsonResponse(400, { error: "Version must be semver like 1.0.0" });
  }

  // Size guard — Netlify Functions payload limit ~6MB; base64 adds 33% overhead
  // If body > ~5.5MB string length, warn but still try
  const bodySize = Buffer.byteLength(event.body || "", "utf8");
  if (bodySize > 6 * 1024 * 1024) {
    // still attempt, but may have been truncated by Netlify gateway
    console.warn(`Large payload ${Math.round(bodySize/1024/1024)}MB may exceed Netlify limit`);
  }

  const id = slugify(name);
  const cleanVersion = sanitizeVersion(version);
  const tag = `${id}-v${cleanVersion}`;
  const apkBuffer = Buffer.from(apkBase64, "base64");
  if (!apkBuffer.length) {
    return jsonResponse(400, { error: "APK base64 decode failed or empty" });
  }
  // Basic APK magic check: APK is ZIP (PK\x03\x04)
  if (apkBuffer[0] !== 0x50 || apkBuffer[1] !== 0x4b) {
    console.warn("APK does not start with PK header — may not be a valid APK/ZIP, continuing anyway");
  }

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
      }
    } catch (e) {
      // if 404, apps stays []
      if (!String(e.message).includes("404")) throw e;
    }

    // Check duplicate tag
    const tagCheckUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const tagRes = await ghFetch(tagCheckUrl, token);
    if (tagRes.ok) {
      return jsonResponse(409, { error: `Tag ${tag} already exists — bump version` });
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
    const relRes = await ghFetch(releaseUrl, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(releaseBody),
    });
    if (!relRes.ok) {
      const t = await relRes.text();
      return jsonResponse(502, { error: `GitHub release creation failed: ${relRes.status} ${t}` });
    }
    const release = await relRes.json();
    const releaseId = release.id;
    const uploadUrlTemplate = release.upload_url; // e.g. https://uploads.github.com/.../releases/ID/assets{?name,label}
    const uploadBase = uploadUrlTemplate.split("{")[0];

    // 3. Upload APK as release asset
    const apkUploadUrl = `${uploadBase}?name=${encodeURIComponent(apkFileName)}`;
    const apkRes = await fetch(apkUploadUrl, {
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
      // cleanup: attempt to delete release? best effort, ignore
      return jsonResponse(502, { error: `APK asset upload failed: ${apkRes.status} ${t}` });
    }
    const asset = await apkRes.json();
    const apkUrl = asset.browser_download_url || asset.url;
    if (!apkUrl) {
      return jsonResponse(502, { error: "APK upload succeeded but no download URL returned" });
    }

    // 4. Upload icon & screenshots via Contents API
    let iconUrl = null;
    const dirForApp = `${imagesDir}/${id}`;
    if (icon && icon.base64) {
      try {
        iconUrl = await uploadImageFile(owner, repo, branch, token, dirForApp, icon.fileName || "icon.png", icon.base64, `feat: add icon for ${id} v${cleanVersion}`);
      } catch (e) {
        console.warn("Icon upload failed:", e.message);
        // non-fatal
      }
    }
    const screenshotUrls = [];
    if (Array.isArray(screenshots) && screenshots.length) {
      for (let i = 0; i < screenshots.length; i++) {
        const s = screenshots[i];
        if (!s.base64) continue;
        try {
          const url = await uploadImageFile(owner, repo, branch, token, dirForApp, s.fileName || `screenshot-${i + 1}.jpg`, s.base64, `feat: add screenshot ${i + 1} for ${id} v${cleanVersion}`);
          screenshotUrls.push(url);
        } catch (e) {
          console.warn(`Screenshot ${i} upload failed`, e.message);
        }
      }
    }

    // 5. Merge into apps.json
    const now = new Date().toISOString().slice(0, 10);
    const computedSize = size || `${(apkBuffer.length / 1024 / 1024).toFixed(1)} MB`;
    const existingIdx = apps.findIndex((a) => a.id === id);
    const existing = existingIdx >= 0 ? apps[existingIdx] : null;

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
      featured: existing?.featured ?? false,
      updatedAt: now,
    };

    if (existingIdx >= 0) apps[existingIdx] = { ...existing, ...newApp };
    else apps.unshift(newApp); // newest first

    // Sort by updatedAt desc
    apps.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const newContent = Buffer.from(JSON.stringify(apps, null, 2), "utf8").toString("base64");

    // Re-fetch sha in case it changed between first fetch and now (race)
    if (!appsSha) {
      try {
        const fresh = await getFileSha(owner, repo, appsJsonPath, branch, token);
        if (fresh.exists) appsSha = fresh.sha;
      } catch (_) {}
    }

    const putBody = {
      message: existing ? `chore: update ${name} to v${cleanVersion}` : `feat: publish ${name} v${cleanVersion}`,
      content: newContent,
      branch,
    };
    if (appsSha) putBody.sha = appsSha;

    const putUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(appsJsonPath).replace(/%2F/g, "/")}`;
    let putRes = await ghFetch(putUrl, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });

    // If sha mismatch (409), refetch and retry once
    if (putRes.status === 409) {
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
      return jsonResponse(502, { error: `Failed to update ${appsJsonPath}: ${putRes.status} ${t}. Release ${tag} and APK were created, but catalog not updated — please update manually.` });
    }

    return jsonResponse(200, {
      success: true,
      id,
      tag,
      apkUrl,
      app: newApp,
      releaseUrl: release.html_url,
    });
  } catch (err) {
    console.error("publish handler error", err);
    return jsonResponse(500, { error: err.message || String(err) });
  }
}

export default { handler };
