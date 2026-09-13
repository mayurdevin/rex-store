// js/store.js — Rex Store public homepage logic
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const state = { apps: [], q:"", cat:"All", sort:"updated" };

function slugify(t){
  return t.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

function formatDate(d){
  try { return new Date(d).toLocaleDateString('en-US',{month:'short', day:'numeric', year:'numeric'});} catch { return d }
}

function showToast(msg, ms=3200){
  const el=$('#toast'); el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), ms);
}

function appCard(app){
  const div=document.createElement('article');
  div.className='card';
  div.innerHTML=`
    <span class="category">${escapeHtml(app.category||'App')}</span>
    <div class="card-top">
      <div class="app-icon"><img loading="lazy" src="${escapeAttr(app.icon)}" alt="${escapeAttr(app.name)} icon" onerror="this.src='https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4e6.png'"></div>
      <div class="app-meta">
        <h3 title="${escapeAttr(app.name)}">${escapeHtml(app.name)}</h3>
        <div class="meta-line"><span>v${escapeHtml(app.version)}</span><span class="dot"></span><span>${escapeHtml(app.size||'APK')}</span></div>
        <div class="meta-line" style="color:var(--muted-2);margin-top:2px">${escapeHtml(app.category)} • ${formatDate(app.updatedAt)}</div>
      </div>
    </div>
    <p class="card-desc">${escapeHtml(app.shortDesc||app.description||'')}</p>
    <div class="card-actions">
      <a class="btn btn-primary" href="${escapeAttr(app.apkUrl)}" download onclick="event.stopPropagation()" title="Download APK">⬇ Download</a>
      <a class="btn btn-ghost btn-small" href="/app.html?id=${encodeURIComponent(app.id)}">Details</a>
    </div>
  `;
  div.style.cursor='pointer';
  div.addEventListener('click', ()=> location.href=`/app.html?id=${encodeURIComponent(app.id)}`);
  return div;
}

function featuredCard(app){
  const div=document.createElement('article');
  div.className='featured-card';
  div.style.cursor='pointer';
  div.innerHTML=`
    <div class="app-icon"><img loading="lazy" src="${escapeAttr(app.icon)}" alt="" onerror="this.src='https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2b50.png'"></div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge">Featured</span><span class="pill" style="padding:4px 8px">${escapeHtml(app.category)}</span></div>
      <h3 style="margin:6px 0 4px">${escapeHtml(app.name)} <span style="color:var(--muted);font-weight:500;font-size:.86rem">v${escapeHtml(app.version)}</span></h3>
      <p style="margin:0;color:var(--muted);font-size:.84rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(app.shortDesc||'')}</p>
    </div>
    <a class="btn btn-primary btn-small" href="${escapeAttr(app.apkUrl)}" download onclick="event.stopPropagation()">⬇ Download</a>
  `;
  div.addEventListener('click', ()=> location.href=`/app.html?id=${encodeURIComponent(app.id)}`);
  return div;
}

function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }
function escapeAttr(s){ return escapeHtml(s).replace(/`/g,'&#96;') }

async function loadApps(){
  const grid=$('#appGrid');
  // skeleton
  grid.innerHTML=Array.from({length:8}).map(()=>`<div class="skeleton"></div>`).join('');
  try{
    const res= await fetch('/data/apps.json', {cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data= await res.json();
    state.apps= Array.isArray(data) ? data : [];
  }catch(e){
    console.error(e);
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1">Failed to load apps.json<br><span class="small muted">${escapeHtml(e.message)}</span></div>`;
    showToast('Failed to load apps');
    return;
  }
  buildPills();
  updateHeroStats();
  render();
}

function buildPills(){
  const cats=['All', ...new Set(state.apps.map(a=>a.category).filter(Boolean))];
  const wrap=$('#filterPills');
  wrap.innerHTML='';
  cats.forEach(c=>{
    const b=document.createElement('button');
    b.className='chip'+(state.cat===c?' active':'');
    b.textContent=c;
    b.addEventListener('click', ()=>{
      state.cat=c; $$('.chip',wrap).forEach(x=>x.classList.toggle('active', x.textContent===c));
      render();
    });
    wrap.appendChild(b);
  });
}

function updateHeroStats(){
  $('#statTotal').textContent= String(state.apps.length);
  const cats=new Set(state.apps.map(a=>a.category)).size;
  $('#statCategories').textContent= String(cats||'—');
  const latest=[...state.apps].sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt))[0];
  $('#statUpdated').textContent= latest ? formatDate(latest.updatedAt) : '—';
  $('#appCount').textContent=`${state.apps.length} apps`;
  $('#appCount').style.display='inline-flex';
}

function getFiltered(){
  let list=[...state.apps];
  if(state.cat!=='All') list=list.filter(a=>a.category===state.cat);
  if(state.q){
    const q=state.q.toLowerCase();
    list=list.filter(a=>
      a.name.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      (a.shortDesc||'').toLowerCase().includes(q) ||
      (a.description||'').toLowerCase().includes(q)
    );
  }
  if(state.sort==='name') list.sort((a,b)=>a.name.localeCompare(b.name));
  else if(state.sort==='category') list.sort((a,b)=>a.category.localeCompare(b.category));
  else list.sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt));
  return list;
}

function render(){
  const list=getFiltered();
  const grid=$('#appGrid');
  const empty=$('#emptyState');
  const featuredSec=$('#featuredSection');
  const fGrid=$('#featuredGrid');
  const countEl=$('#resultCount');

  countEl.textContent= `${list.length} ${list.length===1?'app':'apps'}${state.q?` for “${state.q}”`:''}`;

  // Featured: only when no search/filter sorting default and on first page
  const showFeatured = state.q==='' && state.cat==='All' && state.sort==='updated';
  if(showFeatured){
    const featured= state.apps.filter(a=>a.featured).slice(0,4);
    if(featured.length){
      featuredSec.style.display='block';
      fGrid.innerHTML='';
      featured.forEach(a=> fGrid.appendChild(featuredCard(a)));
    } else featuredSec.style.display='none';
  } else featuredSec.style.display='none';

  if(!list.length){
    grid.innerHTML='';
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  grid.innerHTML='';
  list.forEach(a=> grid.appendChild(appCard(a)));
}

function attachEvents(){
  const onSearch=(v)=>{ state.q=v.trim(); render(); };
  $('#searchDesktop')?.addEventListener('input', e=> onSearch(e.target.value));
  $('#searchMobile')?.addEventListener('input', e=> {
    const v=e.target.value;
    $('#searchDesktop').value=v;
    onSearch(v);
  });
  $('#searchDesktop')?.addEventListener('input', e=>{
    const v=e.target.value; $('#searchMobile').value=v;
  });
  $('#sortSelect')?.addEventListener('change', e=>{ state.sort=e.target.value; render(); });

  // sync query param ?q
  const params=new URLSearchParams(location.search);
  if(params.get('q')){ state.q=params.get('q'); $('#searchDesktop').value=state.q; $('#searchMobile').value=state.q; }
  if(params.get('category')) state.cat=params.get('category');
}

attachEvents();
loadApps();
