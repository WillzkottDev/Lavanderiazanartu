const API = "/api";
const state = {
  machines: [],
  selected: new Set(),
  identity: JSON.parse(localStorage.getItem("laundryIdentity") || "null"),
  towerFilter: "all",
  historyFilter: "all",
  alarmed: new Set(),
  refreshAfterEnd: new Set()
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function machineLabel(m){ return `${m.type === "washer" ? "Lavadora" : "Secadora"} ${m.number}`; }
function machineSvg(type){
  if(type === "dryer") return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="3.5" width="22" height="25" rx="3"/><path d="M9 8h14"/><circle cx="11" cy="6.2" r=".8" fill="currentColor" stroke="none"/><circle cx="21" cy="6.2" r=".8" fill="currentColor" stroke="none"/><circle cx="16" cy="18" r="6.2"/><path d="M12.2 17c1.3-2 3.7-2.5 5.7-1.2 1.1.7 1.8 1.8 2 3"/></svg>`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="3.5" width="22" height="25" rx="3"/><path d="M9 8h14"/><circle cx="11" cy="6.2" r=".8" fill="currentColor" stroke="none"/><circle cx="21" cy="6.2" r=".8" fill="currentColor" stroke="none"/><circle cx="16" cy="18" r="6.2"/><path d="M11.5 18c1.7 1.4 3.3 1.8 4.8 1.2 1.8-.7 2.6-2.3 4.2-1.5"/></svg>`;
}
function fmtRemaining(ms){
  const total=Math.max(0,Math.ceil(ms/1000));
  return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;
}
function fmtDate(iso){ return new Intl.DateTimeFormat("es-CL",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(iso)); }
function toast(msg){
  const el=$("#toast"); el.textContent=msg; el.classList.remove("hidden");
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add("hidden"),2600);
}
function isSameApartment(m){
  return m.session && state.identity && String(m.session.tower)===String(state.identity.tower) && String(m.session.apartment)===String(state.identity.apartment);
}
function canStop(m){ return !!(m.session && m.session.can_stop); }
function pickupActive(m, now=Date.now()){ return !!(!m.session && m.pickup && new Date(m.pickup.until).getTime()>now); }
function sortedMachines(list){
  return [...list].sort((a,b)=>{
    if(a.tower!==b.tower) return a.tower-b.tower;
    const rank={dryer:0,washer:1};
    if(rank[a.type]!==rank[b.type]) return rank[a.type]-rank[b.type];
    return a.number-b.number;
  });
}

async function api(path, options={}){
  const res=await fetch(API+path,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  if(!res.ok){ const body=await res.json().catch(()=>({error:"Error de servidor"})); throw new Error(body.error||"Error de servidor"); }
  return res.json();
}

function loadIdentity(){
  if(!state.identity){
    $("#identityPanel").classList.remove("collapsed");
    $("#residentSummary").textContent="Selecciona torre y departamento";
    return;
  }
  $("#towerSelect").value=state.identity.tower;
  $("#apartmentInput").value=state.identity.apartment;
  $("#identityStatus").textContent=`T${state.identity.tower} · Depto ${state.identity.apartment}`;
  $("#identityStatus").className="pill ok";
  $("#residentSummary").textContent=`Torre ${state.identity.tower} · Depto ${state.identity.apartment}`;
  $("#identityPanel").classList.add("collapsed");
}
function saveIdentity(){
  const tower=$("#towerSelect").value, apartment=$("#apartmentInput").value.trim();
  if(!tower || !/^\d{3,4}$/.test(apartment)){ toast("Selecciona torre e ingresa un departamento válido."); return; }
  state.identity={tower,apartment};
  localStorage.setItem("laundryIdentity",JSON.stringify(state.identity));
  loadIdentity(); render(); toast("Departamento guardado.");
}

function statusFor(m, now=Date.now()){
  if(m.session) return canStop(m)?"mine":"busy";
  if(pickupActive(m,now)) return "pickup";
  return "free";
}

function machineCard(m, now){
  const status=statusFor(m,now), selected=state.selected.has(m.id), sameApartment=isSameApartment(m), owner=canStop(m);
  const card=document.createElement("article");
  card.className=`machine-card ${status} ${selected?"selected":""}`;
  card.dataset.id=m.id;
  let bottom="";

  if(status==="free"){
    bottom=`<div class="status-line"><i class="status-light green"></i>Disponible</div><div class="tap-hint">Toca para seleccionar</div>`;
  } else if(status==="pickup"){
    bottom=`<div class="status-line"><i class="status-light amber"></i>Retirando ropa</div><div class="pickup-row"><span class="used-by">Máquina disponible</span><span class="pickup-countdown" data-pickup-until="${m.pickup.until}">${fmtRemaining(new Date(m.pickup.until).getTime()-now)}</span></div>`;
  } else {
    const remaining=new Date(m.session.ends_at).getTime()-now;
    bottom=`<div class="status-line"><i class="status-light ${owner?"blue":"red"}"></i>${owner?"En uso por ti":sameApartment?"En uso por tu depto":"Ocupada"}</div>
      <div class="used-by">Depto ${m.session.apartment} · ${m.session.duration_minutes} min</div>
      <div class="countdown" data-end="${m.session.ends_at}" data-session="${m.session.id}">${fmtRemaining(remaining)}</div>
      ${owner?`<button class="small-action" type="button" data-release="${m.id}">Finalizar antes</button>`:""}`;
  }

  card.innerHTML=`<div><div class="machine-top"><div class="machine-icon">${machineSvg(m.type)}</div><span class="machine-menu">•••</span></div><h3>${machineLabel(m)}</h3><div class="sub">Torre ${m.tower} · Nivel -1</div></div><div class="machine-bottom">${bottom}</div>`;
  if(!m.session) card.addEventListener("click",e=>{ if(!e.target.closest("button")) toggleMachine(m.id); });
  return card;
}

function render(){
  const now=Date.now();
  const visible=sortedMachines(state.machines.filter(m=>state.towerFilter==="all"||String(m.tower)===state.towerFilter));
  const groups=[1,2].filter(t=>state.towerFilter==="all"||String(t)===state.towerFilter);
  const root=$("#machineGroups"); root.innerHTML="";

  for(const tower of groups){
    const towerMachines=visible.filter(m=>m.tower===tower);
    const free=towerMachines.filter(m=>!m.session).length;
    const block=document.createElement("section"); block.className="tower-block";
    block.innerHTML=`<div class="tower-title"><div class="title-left"><h2>Torre ${tower}</h2><span class="level">Nivel -1</span></div><span class="availability">${free} de ${towerMachines.length} libres</span></div>`;

    for(const type of ["dryer","washer"]){
      const label=document.createElement("div"); label.className="machine-type-label"; label.textContent=type==="dryer"?"Secadoras":"Lavadoras"; block.appendChild(label);
      const grid=document.createElement("div"); grid.className="type-grid";
      towerMachines.filter(m=>m.type===type).forEach(m=>grid.appendChild(machineCard(m,now)));
      block.appendChild(grid);
    }
    root.appendChild(block);
  }
  updateSummary(); updateStartBar();
}

function updateSummary(){
  $("#freeCount").textContent=state.machines.filter(m=>!m.session).length;
  $("#busyCount").textContent=state.machines.filter(m=>m.session).length;
  $("#myCount").textContent=state.machines.filter(canStop).length;
}
function updateStartBar(){
  const selected=[...state.selected].map(id=>state.machines.find(m=>m.id===id)).filter(Boolean);
  const bar=$("#startBar"); if(!selected.length){bar.classList.add("hidden"); return;}
  bar.classList.remove("hidden");
  $("#selectedCount").textContent=`${selected.length} ${selected.length===1?"máquina seleccionada":"máquinas seleccionadas"}`;
  $("#selectedNames").textContent=selected.map(m=>`T${m.tower} · ${machineLabel(m)}`).join(" | ");
}
function toggleMachine(id){ state.selected.has(id)?state.selected.delete(id):state.selected.add(id); render(); }
function openStart(){
  if(!state.identity){ $("#identityPanel").classList.remove("collapsed"); toast("Primero guarda tu torre y departamento."); return; }
  const selected=[...state.selected].map(id=>state.machines.find(m=>m.id===id)).filter(Boolean); if(!selected.length)return;
  $("#dialogMachineList").innerHTML=selected.map(m=>`<span class="selected-tag ${m.type}"><span class="tag-machine-icon">${machineSvg(m.type)}</span>T${m.tower} · ${machineLabel(m)}</span>`).join("");
  $("#startDialog").showModal();
}
async function confirmStart(e){
  e.preventDefault();
  const duration=Number(document.querySelector('input[name="duration"]:checked').value), machine_ids=[...state.selected];
  try{
    $("#confirmStartBtn").disabled=true;
    await api("/start",{method:"POST",body:JSON.stringify({tower:Number(state.identity.tower),apartment:state.identity.apartment,machine_ids,duration_minutes:duration})});
    state.selected.clear(); $("#startDialog").close(); await refresh(); requestNotifications(); toast("Uso iniciado. Cuenta regresiva activa.");
  }catch(err){toast(err.message)} finally{$("#confirmStartBtn").disabled=false}
}
async function releaseMachine(id){
  const m=state.machines.find(x=>x.id===id);
  if(!m?.session?.can_stop){toast("Solo la misma conexión/IP que inició el uso puede finalizarlo antes.");return;}
  if(!confirm("¿Finalizar el uso de esta máquina antes de tiempo?"))return;
  try{await api("/stop",{method:"POST",body:JSON.stringify({machine_id:id})});await refresh();toast("Máquina liberada. Retira tu ropa.");}catch(err){toast(err.message)}
}
async function refresh(){
  try{
    const data=await api("/state"); state.machines=data.machines;
    for(const id of [...state.selected]){const m=state.machines.find(x=>x.id===id);if(!m||m.session)state.selected.delete(id)}
    render(); preselectFromQR();
  }catch(err){toast("No se pudo actualizar el estado.")}
}
function preselectFromQR(){
  const params=new URLSearchParams(location.search), qrTower=params.get("tower"), machine=params.get("machine");
  if(qrTower&&["1","2"].includes(qrTower)){
    state.towerFilter=qrTower; $$(".seg").forEach(b=>b.classList.toggle("active",b.dataset.filterTower===qrTower));
  }
  if(machine&&!state._qrHandled){state._qrHandled=true;const m=state.machines.find(x=>x.id===machine&&!x.session);if(m){state.selected.add(m.id);render()}}
}
function tick(){
  const now=Date.now(); let shouldRefresh=false;
  $$(".countdown").forEach(el=>{const remaining=new Date(el.dataset.end).getTime()-now;el.textContent=fmtRemaining(remaining);if(remaining<=0&&!state.refreshAfterEnd.has(el.dataset.session)){state.refreshAfterEnd.add(el.dataset.session);shouldRefresh=true}});
  $$(".pickup-countdown").forEach(el=>{const remain=new Date(el.dataset.pickupUntil).getTime()-now;el.textContent=fmtRemaining(remain);if(remain<=0)shouldRefresh=true});
  for(const m of state.machines){if(!m.session||!m.session.can_stop)continue;const end=new Date(m.session.ends_at).getTime();if(end<=now&&!state.alarmed.has(m.session.id)){state.alarmed.add(m.session.id);alarm(machineLabel(m))}}
  if(shouldRefresh)refresh();
}
function alarm(name){playBeep();if("Notification" in window&&Notification.permission==="granted")new Notification("Lavandería Zañartu 1100",{body:`Terminó el tiempo de ${name}. Tienes 5 minutos para retirar la ropa.`});toast(`⏰ Terminó ${name}. Retira tu ropa (5 min).`)}
function playBeep(){try{const AudioCtx=window.AudioContext||window.webkitAudioContext,ctx=new AudioCtx();[0,.22,.44].forEach(delay=>{const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.value=.08;o.start(ctx.currentTime+delay);o.stop(ctx.currentTime+delay+.15)})}catch{}}
function requestNotifications(){if("Notification" in window&&Notification.permission==="default")Notification.requestPermission().catch(()=>{})}
async function openHistory(){ $("#historyDialog").showModal(); await loadHistory(); }
async function loadHistory(){
  try{
    const params=state.historyFilter==="mine"&&state.identity?`?tower=${encodeURIComponent(state.identity.tower)}&apartment=${encodeURIComponent(state.identity.apartment)}`:"";
    const data=await api("/history"+params),root=$("#historyList");
    if(!data.history.length){root.innerHTML='<div class="notice">Todavía no hay registros.</div>';return}
    root.innerHTML=data.history.map(h=>{const running=h.status==="active";return `<div class="history-row ${running?"active":""}"><div class="history-row-main"><div class="history-machine-icon">${machineSvg(h.type)}</div><div><strong>${h.machine_label}</strong><span>Torre ${h.tower} · Depto ${h.apartment}</span><span>◷ ${h.duration_minutes} min</span></div></div><div class="history-date"><strong>${fmtDate(h.started_at)}</strong><span>${running?"En curso":`hasta ${fmtDate(h.ends_at)}`}</span></div><span class="history-status ${running?"running":""}">${running?"En curso":"Finalizado"}</span></div>`}).join("");
  }catch(err){toast(err.message)}
}

document.addEventListener("click",e=>{const rel=e.target.closest("[data-release]");if(rel){e.stopPropagation();releaseMachine(rel.dataset.release)}});
$("#saveIdentityBtn").addEventListener("click",saveIdentity);
$("#editIdentityBtn").addEventListener("click",()=>$("#identityPanel").classList.toggle("collapsed"));
$("#continueBtn").addEventListener("click",openStart);
$("#startForm").addEventListener("submit",confirmStart);
$("#historyBtn").addEventListener("click",openHistory);
$("#closeHistoryBtn").addEventListener("click",()=>$("#historyDialog").close());
$$(".seg").forEach(btn=>btn.addEventListener("click",()=>{state.towerFilter=btn.dataset.filterTower;$$(".seg").forEach(x=>x.classList.toggle("active",x===btn));render()}));
$$(".duration-option input").forEach(r=>r.addEventListener("change",()=>{$$(".duration-option").forEach(x=>x.classList.toggle("active",x.querySelector("input").checked))}));
$$("[data-history]").forEach(btn=>btn.addEventListener("click",()=>{state.historyFilter=btn.dataset.history;$$("[data-history]").forEach(x=>x.classList.toggle("active",x===btn));loadHistory()}));

loadIdentity(); refresh(); setInterval(tick,1000); setInterval(refresh,15000);
