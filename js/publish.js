// js/publish.js — Publish dashboard with manage (list/edit/delete), monochrome premium
const $ = (s, r = document) => r.querySelector(s);

function showToast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.style.background = type === "error" ? "#dc2626" : "var(--text)";
  el.style.borderColor = type === "error" ? "#dc2626" : "var(--text)";
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function wireDrop(dropEl, inputEl, onFiles) {
  ["dragenter", "dragover"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.classList.remove("drag");
    })
  );
  dropEl.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files.length) {
      inputEl.files = files;
      onFiles(files);
    }
  });
  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", () => onFiles(inputEl.files));
}

// State
let editingId = null;
let editingApp = null;
let pendingDeleteId = null;
let allApps = [];

// Elements
const apkFile = $("#apkFile");
const iconFile = $("#iconFile");
const shotsFiles = $("#shotsFiles");
const editBanner = $("#editBanner");
const editNameEl = $("#editName");
const editIdEl = $("#editId");
const apkLabel = $("#apkLabel");
const apkDropText = $("#apkDropText");
const apkCurrent = $("#apkCurrent");
const iconCurrent = $("#iconCurrent");
const shotsCurrent = $("#shotsCurrent");
const fileModeHint = $("#fileModeHint");
const versionHint = $("#versionHint");

wireDrop($("#apkDrop"), apkFile, (files) => {
  const f = files[0];
  if (!f) return;
  if (!f.name.toLowerCase().endsWith(".apk")) showToast("Please select an .apk file", "error");
  $("#apkName").textContent = `${f.name} • ${humanSize(f.size)}`;
  if (f.size > 6 * 1024 * 1024) showToast("Netlify Free ~6MB limit — large APK may fail. See README.", "error");
  apkCurrent.style.display = "none";
});

wireDrop($("#iconDrop"), iconFile, (files) => {
  const f = files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  $("#iconPreviewImg").src = url;
  $("#iconPreview").style.display = "block";
  iconCurrent.style.display = "none";
});

wireDrop($("#shotsDrop"), shotsFiles, (files) => {
  const wrap = $("#shotsPreview");
  wrap.innerHTML = "";
  [...files].slice(0, 6).forEach((f) => {
    const url = URL.createObjectURL(f);
    const img = document.createElement("img");
    img.src = url;
    img.alt = f.name;
    wrap.appendChild(img);
  });
  if (files.length > 6) showToast("Only first 6 screenshots will be used");
  shotsCurrent.style.display = "none";
});

$("#resetBtn").addEventListener("click", () => resetForm());
$("#cancelEditBtn").addEventListener("click", () => resetForm());
$("#refreshBtn").addEventListener("click", () => loadManage());

function hideAlerts() {
  $("#alertSuccess").style.display = "none";
  $("#alertError").style.display = "none";
}
function showSuccess(html) {
  const el = $("#alertSuccess");
  el.innerHTML = html;
  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}
function showError(html) {
  const el = $("#alertError");
  el.innerHTML = html;
  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetForm() {
  editingId = null;
  editingApp = null;
  $("#publishForm").reset();
  $("#apkName").textContent = "";
  apkCurrent.style.display = "none";
  apkCurrent.textContent = "";
  $("#iconPreview").style.display = "none";
  $("#iconPreviewImg").src = "";
  iconCurrent.style.display = "none";
  $("#shotsPreview").innerHTML = "";
  shotsCurrent.style.display = "none";
  editBanner.classList.remove("show");
  $("#submitBtn").textContent = "🚀 Publish to GitHub";
  apkLabel.innerHTML = `APK file * <span class="hint">— required for new publish</span>`;
  apkDropText.textContent = "Drop APK here or click to browse";
  fileModeHint.textContent = "— APK stored as Release asset";
  versionHint.textContent = "Semver — new version creates new GitHub Release";
  $("#appName").removeAttribute("readonly");
  hideAlerts();
  $("#progressWrap").style.display = "none";
  $("#progressBar").style.width = "0";
}

function enterEditMode(app) {
  editingId = app.id;
  editingApp = app;
  editBanner.classList.add("show");
  editNameEl.textContent = app.name;
  editIdEl.textContent = app.id;

  $("#appName").value = app.name;
  $("#version").value = app.version;
  $("#category").value = app.category;
  $("#shortDesc").value = app.shortDesc || "";
  $("#description").value = app.description || "";
  $("#whatsNew").value = app.whatsNew || "";
  $("#size").value = app.size || "";
  $("#featured").checked = !!app.featured;

  apkLabel.innerHTML = `APK file <span class="hint">— keep empty to retain existing APK</span>`;
  apkDropText.textContent = "Drop new APK to create new Release";
  fileModeHint.textContent = "— leave APK empty to keep existing Release";
  versionHint.textContent = "Same version → metadata only; bump version + new APK → new Release";
  apkCurrent.style.display = "block";
  apkCurrent.innerHTML = `Current: <a href="${app.apkUrl}" target="_blank" rel="noopener" style="text-decoration:underline;word-break:break-all">${app.apkUrl}</a> • v${app.version} • ${app.size || ""}`;
  $("#apkName").textContent = "";

  if (app.icon) {
    iconCurrent.style.display = "block";
    iconCurrent.innerHTML = `Current: <span style="word-break:break-all">${app.icon}</span>`;
    $("#iconPreview").style.display = "block";
    $("#iconPreviewImg").src = app.icon;
    $("#iconPreviewImg").onerror = () => { $("#iconPreview").style.display = "none"; };
  }
  if (app.screenshots && app.screenshots.length) {
    shotsCurrent.style.display = "block";
    shotsCurrent.textContent = `Current: ${app.screenshots.length} screenshot(s) — select new files to replace`;
  }
  $("#submitBtn").textContent = "💾 Update app";
  $("#appName").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
  showToast(`Editing ${app.name}`);
}

// Manage list
async function loadManage() {
  const listEl = $("#manageList");
  const emptyEl = $("#manageEmpty");
  const skel = $("#manageSkeleton");
  const totalEl = $("#manageTotal");
  const countEl = $("#manageCount");

  skel.style.display = "grid";
  listEl.innerHTML = "";
  emptyEl.style.display = "none";

  try {
    const res = await fetch("/data/apps.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const apps = await res.json();
    allApps = Array.isArray(apps) ? apps : [];
    totalEl.textContent = `${allApps.length} ${allApps.length === 1 ? "app" : "apps"}`;
    countEl.textContent = `${allApps.length} published`;
    countEl.style.display = allApps.length ? "inline-flex" : "none";

    skel.style.display = "none";

    if (!allApps.length) {
      emptyEl.style.display = "block";
      listEl.innerHTML = "";
      return;
    }

    emptyEl.style.display = "none";
    listEl.innerHTML = "";
    allApps
      .slice()
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .forEach((app) => {
        const card = document.createElement("div");
        card.className = "manage-card";
        card.innerHTML = `
          <div class="app-icon"><img src="${escapeAttr(app.icon)}" alt="" onerror="this.src='https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4e6.png'"></div>
          <div class="manage-info">
            <h4 title="${escapeAttr(app.name)}">${escapeHtml(app.name)} <span style="font-weight:500;color:var(--muted);font-size:.82rem">v${escapeHtml(app.version)}</span></h4>
            <div class="sub"><span>${escapeHtml(app.category)}</span><span>•</span><span>${escapeHtml(app.size || "APK")}</span><span>•</span><span>${escapeHtml(app.updatedAt || "")}</span> ${app.featured ? '<span class="pill" style="padding:2px 6px;font-size:.62rem;background:var(--text);color:#fff;border-color:var(--text)">Featured</span>' : ''}</div>
            <div class="sub" style="margin-top:3px"><a href="/app.html?id=${encodeURIComponent(app.id)}" target="_blank" style="text-decoration:underline;text-underline-offset:2px">View</a> <span>•</span> <a href="${escapeAttr(app.apkUrl)}" target="_blank" rel="noopener" style="text-decoration:underline">APK</a></div>
          </div>
          <div class="manage-actions">
            <button class="btn btn-ghost btn-small" data-edit="${escapeAttr(app.id)}">Edit</button>
            <button class="btn btn-ghost btn-small" data-delete="${escapeAttr(app.id)}" style="border-color:#e5e5e5">Delete</button>
          </div>
        `;
        card.querySelector("[data-edit]")?.addEventListener("click", () => enterEditMode(app));
        card.querySelector("[data-delete]")?.addEventListener("click", () => openDeleteDialog(app));
        listEl.appendChild(card);
      });
  } catch (e) {
    console.error(e);
    skel.style.display = "none";
    listEl.innerHTML = `<div class="manage-empty" style="display:block">Failed to load apps.json: ${escapeHtml(e.message)}<br><button class="btn btn-ghost btn-small" style="margin-top:8px" onclick="location.reload()">Retry</button></div>`;
    showToast("Failed to load published apps", "error");
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, "&#96;"); }

// Delete dialog
const confirmOverlay = $("#confirmOverlay");
const confirmAppName = $("#confirmAppName");
const confirmDeleteBtn = $("#confirmDelete");

function openDeleteDialog(app) {
  pendingDeleteId = app.id;
  confirmAppName.textContent = `${app.name} (${app.id} v${app.version})`;
  $("#confirmText").innerHTML = `This will remove <strong>${escapeHtml(app.name)}</strong> from <code>data/apps.json</code> and delete its GitHub Release <code>${escapeHtml(app.id)}-v${escapeHtml(app.version)}</code> and tag. The APK will no longer be downloadable.`;
  confirmOverlay.classList.add("show");
  confirmDeleteBtn.focus();
}
function closeDeleteDialog() {
  confirmOverlay.classList.remove("show");
  pendingDeleteId = null;
}
$("#confirmCancel").addEventListener("click", closeDeleteDialog);
confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) closeDeleteDialog(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && confirmOverlay.classList.contains("show")) closeDeleteDialog(); });

confirmDeleteBtn.addEventListener("click", async () => {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  const app = allApps.find(a => a.id === id);
  confirmDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = "Deleting…";
  try {
    const publishKey = $("#publishKey").value.trim();
    const headers = { "Content-Type": "application/json" };
    if (publishKey) headers["x-publish-key"] = publishKey;
    const res = await fetch("/.netlify/functions/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ id, version: app?.version })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`Deleted ${app ? app.name : id}`);
    if (editingId === id) resetForm();
    closeDeleteDialog();
    await loadManage();
    // Also trigger store to reflect? It fetches apps.json directly, so will be updated after GitHub commits (may need few seconds)
  } catch (err) {
    console.error(err);
    showToast(`Delete failed: ${err.message}`, "error");
    showError(`<strong>Delete failed</strong><br>${escapeHtml(err.message)}`);
  } finally {
    confirmDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = "Delete & unpublish";
  }
});

// Submit — publish or update
$("#publishForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlerts();

  const name = $("#appName").value.trim();
  const version = $("#version").value.trim();
  const category = $("#category").value;
  const shortDesc = $("#shortDesc").value.trim();
  const description = $("#description").value.trim();
  const whatsNew = $("#whatsNew").value.trim();
  const size = $("#size").value.trim();
  const publishKey = $("#publishKey").value.trim();
  const featured = $("#featured").checked;
  const apk = apkFile.files[0];
  const icon = iconFile.files[0];
  const shots = [...shotsFiles.files].slice(0, 6);

  if (!name || !version || !category || !shortDesc || !description || !whatsNew) {
    showError("Please fill all required fields.");
    return;
  }
  if (!editingId && !apk) { showError("APK file is required for new publish."); return; }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) { showError("Version must be semver like 1.0.0"); return; }

  const isEditing = !!editingId;
  const hasNewApk = !!apk;
  const versionChanged = isEditing && editingApp && version !== editingApp.version;

  // Decide flow: if editing and no new APK → use update (metadata only)
  // If editing and has new APK (and possibly version bump) → use publish with id override (creates new Release)
  // If new publish → use publish
  const useUpdate = isEditing && !hasNewApk;

  const btn = $("#submitBtn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = useUpdate ? "⏳ Updating…" : "⏳ Publishing…";
  const progWrap = $("#progressWrap");
  const progBar = $("#progressBar");
  progWrap.style.display = "block";
  progBar.style.width = "18%";

  try {
    let res;
    let endpoint;

    if (useUpdate) {
      // Update without new Release — send FormData (or JSON if no files? Use FormData for consistency)
      showToast("Updating metadata…");
      progBar.style.width = "40%";
      const formData = new FormData();
      formData.append("id", editingId);
      formData.append("name", name);
      formData.append("version", version);
      formData.append("category", category);
      formData.append("shortDesc", shortDesc);
      formData.append("description", description);
      formData.append("whatsNew", whatsNew);
      if (size) formData.append("size", size);
      formData.append("featured", featured ? "true" : "false");
      if (icon) formData.append("icon", icon, icon.name);
      shots.forEach(f => formData.append("screenshots", f, f.name));

      progBar.style.width = "65%";
      endpoint = "/.netlify/functions/update";
      const headers = {};
      if (publishKey) headers["x-publish-key"] = publishKey;
      res = await fetch(endpoint, { method: "POST", headers, body: formData });
    } else {
      // Publish (new app or edit with new APK/version → new Release)
      showToast(useUpdate ? "Updating…" : "Publishing to GitHub…");
      progBar.style.width = "35%";
      const formData = new FormData();
      if (isEditing) formData.append("id", editingId); // keep slug stable
      formData.append("name", name);
      formData.append("version", version);
      formData.append("category", category);
      formData.append("shortDesc", shortDesc);
      formData.append("description", description);
      formData.append("whatsNew", whatsNew);
      if (size) formData.append("size", size);
      formData.append("featured", featured ? "true" : "false");
      // APK required in this branch
      if (!apk) throw new Error("APK is required to create a new Release");
      formData.append("apk", apk, apk.name);
      if (icon) formData.append("icon", icon, icon.name);
      shots.forEach(f => formData.append("screenshots", f, f.name));

      progBar.style.width = "60%";
      endpoint = "/.netlify/functions/publish";
      const headers = {};
      if (publishKey) headers["x-publish-key"] = publishKey;
      res = await fetch(endpoint, { method: "POST", headers, body: formData });
    }

    progBar.style.width = "85%";
    const data = await res.json().catch(async () => {
      const txt = await res.text().catch(() => "");
      return { error: txt || `HTTP ${res.status}` };
    });
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    progBar.style.width = "100%";

    if (useUpdate) {
      showSuccess(`
        <strong>✅ Updated!</strong> <span class="small">${escapeHtml(name)} metadata saved — no new Release (APK unchanged).</span><br>
        <span class="small">Changes live in <code>data/apps.json</code> after refresh.</span><br>
        <a href="/" class="btn btn-ghost btn-small" style="margin-top:8px;display:inline-flex" target="_blank">View store</a>
        <a href="/app.html?id=${encodeURIComponent(data.id || editingId)}" class="btn btn-primary btn-small" style="margin-top:8px;display:inline-flex;margin-left:6px" target="_blank">View app</a>
      `);
      showToast("Updated successfully");
      resetForm();
    } else {
      const isEditPublish = isEditing;
      showSuccess(`
        <strong>✅ ${isEditPublish ? "Updated with new Release!" : "Published!"}</strong><br>
        <span class="small">Release <code>${escapeHtml(data.tag || "")}</code> ${isEditPublish ? "created" : "created"} • APK: <a href="${escapeAttr(data.apkUrl || "")}" target="_blank" rel="noopener" style="text-decoration:underline">download</a></span><br>
        <span class="small">App <strong>${escapeHtml(name)}</strong> ${isEditPublish ? "updated" : "is live"} in <code>data/apps.json</code>.</span><br>
        <a href="/" class="btn btn-ghost btn-small" style="margin-top:8px;display:inline-flex" target="_blank">View store</a>
        <a href="/app.html?id=${encodeURIComponent(data.id)}" class="btn btn-primary btn-small" style="margin-top:8px;display:inline-flex;margin-left:6px" target="_blank">View app</a>
      `);
      showToast(isEditPublish ? "Updated with new Release" : "Published successfully!");
      resetForm();
    }

    setTimeout(() => { progWrap.style.display = "none"; progBar.style.width = "0"; }, 1400);
    await loadManage();

  } catch (err) {
    console.error(err);
    let msg = err.message || String(err);
    if (msg.includes("6MB") || msg.toLowerCase().includes("too large")) {
      msg += '<br><br><strong>Large APK tip:</strong> Netlify Free ~6MB limit. For larger, use Pro, compress, or manual Release.';
    }
    if (msg.includes("GITHUB_TOKEN") || msg.includes("not configured")) {
      msg += '<br><br><em>Fix: Set GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO in Netlify → Site settings → Environment variables, then redeploy.</em>';
    }
    showError(`<strong>${useUpdate ? "Update" : "Publish"} failed</strong><br>${msg}`);
    showToast(`${useUpdate ? "Update" : "Publish"} failed`, "error");
    progWrap.style.display = "none";
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Init
loadManage();
