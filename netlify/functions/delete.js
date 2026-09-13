/**
 * Netlify Function: POST /.netlify/functions/delete
 * Deletes an app from data/apps.json and its GitHub Release (with tag).
 * Body: { id: "app-slug" } or { id: "slug", version: "1.0.0" } — version optional, resolved from apps.json if missing.
 * Also handles multipart? Only JSON expected.
 */

const GITHUB_API = "https://api.github.com";

function getFetch() {
  const f = (typeof global !== "undefined" && global.fetch) || (typeof globalThis !== "undefined" && globalThis.fetch);
  if (!f) console.error("[delete] FATAL: fetch not available");
  return f;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-publish-key, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS, DELETE",
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
    "User-Agent": "rex-store-delete",
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
    console.error(`[delete] getFileSha ${path} ${res.status}: ${t}`);
    throw new Error(`Failed to check ${path}: ${res.status} ${t}`);
  }
  const data = await res.json();
  return { sha: data.sha, exists: true, content: data.content };
}

async function handler(event) {
  console.log("[delete] invoked", { method: event.httpMethod, hasBody: !!event.body, ct: getHeader(event.headers, "content-type") });
  try {
    if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
    if (!["POST", "DELETE"].includes(event.httpMethod)) return jsonResponse(405, { error: "Use POST" });

    const token = (process.env.GITHUB_TOKEN || "").trim();
    const owner = (process.env.GITHUB_OWNER || "").trim();
    const repo = (process.env.GITHUB_REPO || "").trim();
    const branch = (process.env.GITHUB_BRANCH || "main").trim();
    const appsJsonPath = (process.env.APPS_JSON_PATH || "data/apps.json").trim();
    const expectedKey = (process.env.PUBLISH_KEY || "").trim();

    console.log("[delete] env", { hasToken: !!token, owner, repo, branch });

    if (expectedKey) {
      const actual = getHeader(event.headers, "x-publish-key");
      if (actual !== expectedKey) {
        console.error("[delete] invalid publish key");
        return jsonResponse(401, { error: "Unauthorized — invalid publish key" });
      }
    }

    if (!token || !owner || !repo) {
      console.error("[delete] missing env vars");
      return jsonResponse(500, { error: "Server not configured: missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO" });
    }

    const _fetch = getFetch();
    if (typeof _fetch !== "function") return jsonResponse(500, { error: "fetch not available" });

    let bodyStr = event.body || "";
    if (event.isBase64Encoded) {
      try { bodyStr = Buffer.from(bodyStr, "base64").toString("utf8"); } catch (e) { console.error("[delete] base64 decode failed", e.message); }
    }
    let payload;
    try { payload = JSON.parse(bodyStr || "{}"); } catch (e) {
      console.error("[delete] JSON parse failed", e.message);
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const id = (payload.id || "").trim();
    if (!id) {
      console.error("[delete] missing id");
      return jsonResponse(400, { error: "Missing required field: id" });
    }

    // Load apps.json
    let apps = [];
    let appsSha = null;
    try {
      const info = await getFileSha(owner, repo, appsJsonPath, branch, token);
      if (info.exists) {
        appsSha = info.sha;
        const decoded = Buffer.from(info.content, "base64").toString("utf8");
        apps = JSON.parse(decoded);
        if (!Array.isArray(apps)) apps = [];
        console.log(`[delete] loaded apps.json ${apps.length} apps sha=${appsSha.slice(0,7)}`);
      } else {
        console.error(`[delete] apps.json not found`);
        return jsonResponse(404, { error: "apps.json not found" });
      }
    } catch (e) {
      console.error("[delete] load apps.json failed", e.message);
      return jsonResponse(500, { error: e.message });
    }

    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1) {
      console.error(`[delete] app not found id=${id}`);
      return jsonResponse(404, { error: `App not found: ${id}` });
    }
    const app = apps[idx];
    const version = (payload.version || app.version || "").trim();
    const tag = payload.tag ? String(payload.tag).trim() : `${id}-v${version}`;
    console.log(`[delete] deleting app id=${id} version=${version} tag=${tag}`);

    // Try to delete GitHub Release and tag — non-fatal if not found, but log
    let releaseDeleted = false;
    let tagDeleted = false;
    try {
      const tagUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
      console.log(`[delete] fetching release by tag ${tag}`);
      const relRes = await ghFetch(tagUrl, token);
      if (relRes.status === 404) {
        console.log(`[delete] release not found for tag ${tag}, skipping release delete`);
      } else if (!relRes.ok) {
        const t = await relRes.text();
        console.error(`[delete] get release by tag failed ${relRes.status}: ${t}`);
      } else {
        const release = await relRes.json();
        const releaseId = release.id;
        console.log(`[delete] found release id=${releaseId} for tag ${tag}, deleting...`);
        const delRes = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`, token, { method: "DELETE" });
        if (delRes.status === 204 || delRes.ok) {
          console.log(`[delete] release deleted id=${releaseId}`);
          releaseDeleted = true;
        } else {
          const t = await delRes.text();
          console.error(`[delete] release delete failed ${delRes.status}: ${t}`);
        }
        // Delete tag ref
        try {
          const refUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(tag)}`;
          console.log(`[delete] deleting tag ref ${tag}`);
          const refRes = await ghFetch(refUrl, token, { method: "DELETE" });
          if (refRes.status === 204 || refRes.ok) {
            console.log(`[delete] tag ref deleted`);
            tagDeleted = true;
          } else if (refRes.status === 404) {
            console.log(`[delete] tag ref not found (already deleted)`);
            tagDeleted = true;
          } else {
            const t = await refRes.text();
            console.error(`[delete] tag ref delete failed ${refRes.status}: ${t}`);
          }
        } catch (e) {
          console.error("[delete] tag ref delete error", e.message);
        }
      }
    } catch (e) {
      console.error("[delete] release cleanup error (non-fatal)", e.message);
    }

    // Remove from apps.json
    const removed = apps.splice(idx, 1)[0];
    console.log(`[delete] removed ${removed.id} from catalog, ${apps.length} remaining`);
    const newContent = Buffer.from(JSON.stringify(apps, null, 2), "utf8").toString("base64");
    const putUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(appsJsonPath).replace(/%2F/g, "/")}`;
    const putBody = { message: `chore: delete ${removed.name} (${removed.id})`, content: newContent, branch, sha: appsSha };
    console.log(`[delete] updating ${appsJsonPath}`);
    let putRes = await ghFetch(putUrl, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(putBody) });
    if (putRes.status === 409) {
      console.error("[delete] 409 sha mismatch, refetching");
      const fresh = await getFileSha(owner, repo, appsJsonPath, branch, token);
      if (fresh.exists) {
        putBody.sha = fresh.sha;
        // Rebuild apps without the deleted one (in case fresh has it)
        const freshDecoded = Buffer.from(fresh.content, "base64").toString("utf8");
        let freshApps = JSON.parse(freshDecoded);
        freshApps = freshApps.filter(a => a.id !== id);
        putBody.content = Buffer.from(JSON.stringify(freshApps, null, 2), "utf8").toString("base64");
        putRes = await ghFetch(putUrl, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(putBody) });
      }
    }
    if (!putRes.ok) {
      const t = await putRes.text();
      console.error(`[delete] apps.json update failed ${putRes.status}: ${t}`);
      return jsonResponse(502, { error: `Failed to update ${appsJsonPath}: ${putRes.status} ${t}` });
    }
    console.log(`[delete] SUCCESS deleted ${id}`);

    return jsonResponse(200, { success: true, id, tag, releaseDeleted, tagDeleted, remaining: apps.length });
  } catch (err) {
    console.error("[delete] top-level error", err.stack || err.message);
    return jsonResponse(500, { error: err.message || String(err) });
  }
}

exports.handler = handler;
module.exports.handler = handler;
