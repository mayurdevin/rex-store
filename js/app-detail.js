// js/app-detail.js — detail page
const $ = (s, r=document)=>r.querySelector(s);
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escapeAttr(s){return escapeHtml(s)}
function showToast(m){const e=$('#toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3000)}
function formatDate(d){try{return new Date(d).toLocaleDateString('en-US',{dateStyle:'long'})}catch{return d}}

async function main(){
  const params=new URLSearchParams(location.search);
  const id=params.get('id');
  if(!id){ showNotFound('Missing app id'); return; }
  try{
    const res=await fetch('/data/apps.json',{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const apps=await res.json();
    const app=apps.find(a=>a.id===id);
    if(!app){ showNotFound(); return; }
    render(app);
  }catch(e){
    console.error(e);
    showNotFound(e.message);
  }
}

function showNotFound(msg){
  $('#detailSkeleton').style.display='none';
  $('#notFound').style.display='block';
  if(msg) $('#notFound').querySelector('p').textContent=msg;
}

function render(app){
  document.title=`${app.name} — Rex Store`;
  $('#crumbName').textContent=app.name;
  $('#detailSkeleton').style.display='none';
  const hero=$('#detailHero');
  hero.style.display='grid';
  hero.innerHTML=`
    <div class="detail-icon"><img src="${escapeAttr(app.icon)}" alt="${escapeAttr(app.name)}" onerror="this.src='https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4e6.png'"></div>
    <div class="detail-main">
      <h1>${escapeHtml(app.name)} <span style="color:var(--muted);font-weight:600;font-size:.9rem">v${escapeHtml(app.version)}</span></h1>
      <div class="detail-meta">
        <span class="badge">${escapeHtml(app.category)}</span>
        <span class="pill">${escapeHtml(app.size||'APK')}</span>
        <span class="pill">Updated ${escapeHtml(formatDate(app.updatedAt))}</span>
      </div>
      <p>${escapeHtml(app.shortDesc||'')}</p>
    </div>
    <div class="detail-actions" style="flex-direction:column;align-items:stretch">
      <a id="downloadBtn" class="btn btn-primary" href="${escapeAttr(app.apkUrl)}" download>⬇ Download APK</a>
      <span class="hint" style="text-align:center">${escapeHtml(app.size||'')} • via GitHub Releases</span>
    </div>
  `;
  // wire download tracking / toast
  const dl=$('#downloadBtn');
  dl?.addEventListener('click', ()=> showToast('Starting download…'));

  $('#descPanel').style.display='block';
  $('#infoPanel').style.display='block';
  $('#appDesc').textContent=app.description||app.shortDesc||'';
  $('#whatsNew').textContent=app.whatsNew||'No changelog provided.';
  const scWrap=$('#screenshots');
  scWrap.innerHTML='';
  if(app.screenshots?.length){
    app.screenshots.forEach(src=>{
      const img=document.createElement('img');
      img.loading='lazy';
      img.src=src;
      img.alt=`${app.name} screenshot`;
      img.onerror=()=> img.style.display='none';
      scWrap.appendChild(img);
    });
  } else {
    scWrap.innerHTML=`<span class="muted small">No screenshots</span>`;
  }

  const info=$('#infoList');
  info.innerHTML=`
    <div class="info-row"><span>Package</span><span>${escapeHtml(app.id)}</span></div>
    <div class="info-row"><span>Version</span><span>${escapeHtml(app.version)}</span></div>
    <div class="info-row"><span>Category</span><span>${escapeHtml(app.category)}</span></div>
    <div class="info-row"><span>Size</span><span>${escapeHtml(app.size||'—')}</span></div>
    <div class="info-row"><span>Updated</span><span>${escapeHtml(formatDate(app.updatedAt))}</span></div>
    <div class="info-row"><span>Source</span><span><a href="${escapeAttr(app.apkUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">GitHub Release</a></span></div>
  `;
  const dl2=$('#downloadBtn2');
  if(dl2){ dl2.href=app.apkUrl; dl2.addEventListener('click',()=>showToast('Starting download…')); }

  // also update og? not needed
}

main();
