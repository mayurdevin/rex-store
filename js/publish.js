// js/publish.js — handles publish dashboard
const $ = (s,r=document)=>r.querySelector(s);

function showToast(msg, type=''){
  const el=$('#toast');
  el.textContent=msg;
  el.style.borderColor = type==='error' ? 'rgba(239,68,68,.4)' : 'var(--border-strong)';
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), 3200);
}

function fileToBase64(file){
  return new Promise((res, rej)=>{
    const r=new FileReader();
    r.onload=()=> {
      const base64 = String(r.result).split(',')[1] || '';
      res(base64);
    };
    r.onerror=rej;
    r.readAsDataURL(file);
  });
}

function humanSize(bytes){
  if(bytes<1024) return bytes+' B';
  if(bytes<1024*1024) return (bytes/1024).toFixed(1)+' KB';
  return (bytes/1024/1024).toFixed(2)+' MB';
}

// drag & drop helpers
function wireDrop(dropEl, inputEl, onFiles){
  ['dragenter','dragover'].forEach(ev=> dropEl.addEventListener(ev, e=>{e.preventDefault(); dropEl.classList.add('drag')}));
  ['dragleave','drop'].forEach(ev=> dropEl.addEventListener(ev, e=>{e.preventDefault(); dropEl.classList.remove('drag')}));
  dropEl.addEventListener('drop', e=>{
    const files=e.dataTransfer.files;
    if(files.length){ inputEl.files=files; onFiles(files); }
  });
  dropEl.addEventListener('click', ()=> inputEl.click());
  inputEl.addEventListener('change', ()=> onFiles(inputEl.files));
}

// previews
const apkFile=$('#apkFile');
const iconFile=$('#iconFile');
const shotsFiles=$('#shotsFiles');

wireDrop($('#apkDrop'), apkFile, files=>{
  const f=files[0];
  if(!f) return;
  if(!f.name.endsWith('.apk')) showToast('Please select an .apk file','error');
  $('#apkName').textContent=`${f.name} • ${humanSize(f.size)}`;
  if(f.size>6*1024*1024) showToast('Heads up: Netlify Free limits function payload to ~6MB. Large APKs may fail — see README.', 'error');
});

wireDrop($('#iconDrop'), iconFile, files=>{
  const f=files[0];
  if(!f) return;
  const url=URL.createObjectURL(f);
  $('#iconPreviewImg').src=url;
  $('#iconPreview').style.display='block';
});

wireDrop($('#shotsDrop'), shotsFiles, files=>{
  const wrap=$('#shotsPreview');
  wrap.innerHTML='';
  [...files].slice(0,6).forEach(f=>{
    const url=URL.createObjectURL(f);
    const img=document.createElement('img');
    img.src=url;
    img.alt=f.name;
    wrap.appendChild(img);
  });
  if(files.length>6) showToast('Only first 6 screenshots will be used');
});

$('#resetBtn').addEventListener('click', ()=>{
  $('#publishForm').reset();
  $('#apkName').textContent='';
  $('#iconPreview').style.display='none';
  $('#shotsPreview').innerHTML='';
  hideAlerts();
});

function hideAlerts(){
  $('#alertSuccess').style.display='none';
  $('#alertError').style.display='none';
}
function showSuccess(html){
  const el=$('#alertSuccess');
  el.innerHTML=html;
  el.style.display='block';
  el.scrollIntoView({behavior:'smooth', block:'center'});
}
function showError(html){
  const el=$('#alertError');
  el.innerHTML=html;
  el.style.display='block';
  el.scrollIntoView({behavior:'smooth', block:'center'});
}

$('#publishForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  hideAlerts();

  const name=$('#appName').value.trim();
  const version=$('#version').value.trim();
  const category=$('#category').value;
  const shortDesc=$('#shortDesc').value.trim();
  const description=$('#description').value.trim();
  const whatsNew=$('#whatsNew').value.trim();
  const size=$('#size').value.trim();
  const publishKey=$('#publishKey').value.trim();
  const apk=apkFile.files[0];
  const icon=iconFile.files[0];
  const shots=[...shotsFiles.files].slice(0,6);

  if(!name || !version || !category || !shortDesc || !description || !whatsNew){
    showError('Please fill all required fields.');
    return;
  }
  if(!apk){ showError('APK file is required.'); return; }
  if(!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)){ showError('Version must be semver like 1.0.0'); return; }

  const btn=$('#submitBtn');
  const orig=btn.textContent;
  btn.disabled=true; btn.textContent='⏳ Publishing…';
  const progWrap=$('#progressWrap');
  const progBar=$('#progressBar');
  progWrap.style.display='block';
  progBar.style.width='15%';

  try{
    showToast('Reading files…');
    progBar.style.width='30%';
    const apkBase64=await fileToBase64(apk);
    progBar.style.width='45%';
    let iconData=null;
    if(icon){
      const b64=await fileToBase64(icon);
      iconData={ base64:b64, fileName:icon.name, mime:icon.type||'image/png' };
    }
    progBar.style.width='60%';
    const screenshots=[];
    for(const f of shots){
      const b64=await fileToBase64(f);
      screenshots.push({ base64:b64, fileName:f.name, mime:f.type||'image/jpeg' });
    }
    progBar.style.width='75%';
    showToast('Uploading to GitHub…');

    const payload={
      name, version, category, shortDesc, description, whatsNew, size,
      apkBase64, apkFileName: apk.name,
      icon: iconData,
      screenshots
    };

    const headers={'Content-Type':'application/json'};
    if(publishKey) headers['x-publish-key']=publishKey;

    const res=await fetch('/.netlify/functions/publish', {
      method:'POST',
      headers,
      body: JSON.stringify(payload)
    });

    progBar.style.width='90%';
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      throw new Error(data.error || data.message || `Publish failed (HTTP ${res.status})`);
    }

    progBar.style.width='100%';
    showSuccess(`
      <strong>✅ Published!</strong><br>
      <span class="small">Release <code>${data.tag||''}</code> created. APK asset: <a href="${data.apkUrl}" target="_blank" rel="noopener" style="color:#10b981">download link</a></span><br>
      <span class="small">App <strong>${name}</strong> is now live in <code>data/apps.json</code> and will appear on the store after refresh.</span><br>
      <a href="/" class="btn btn-ghost btn-small" style="margin-top:8px;display:inline-flex">View store</a>
      <a href="/app.html?id=${encodeURIComponent(data.id)}" class="btn btn-primary btn-small" style="margin-top:8px;display:inline-flex;margin-left:6px">View app</a>
    `);
    showToast('Published successfully!');
    setTimeout(()=>{ progWrap.style.display='none'; progBar.style.width='0'; }, 1500);

  }catch(err){
    console.error(err);
    let msg=err.message||String(err);
    if(msg.includes('PayloadTooLarge')||msg.includes('6MB')||msg.includes('LIMIT')){
      msg+='<br><br><strong>Large APK tip:</strong> Netlify Functions have a ~6MB payload limit on free tier. For APKs >6MB: upgrade to Pro, or deploy a tiny proxy server, or compress the APK, or manually create a Release and edit apps.json — see README.';
    }
    showError(`<strong>Publish failed</strong><br>${msg}`);
    showToast('Publish failed', 'error');
    progWrap.style.display='none';
  }finally{
    btn.disabled=false; btn.textContent=orig;
  }
});
