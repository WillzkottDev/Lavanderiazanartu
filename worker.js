const json = (data, status=200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store"
  }
});

function isoNow(){ return new Date().toISOString(); }

async function hashText(value){
  const bytes = new TextEncoder().encode(value || "unknown");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function getClientIP(request){
  return request.headers.get("CF-Connecting-IP")
      || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
      || "unknown";
}

async function clientIPHash(request){
  return hashText(getClientIP(request));
}

async function expireSessions(db){
  const now=isoNow();
  await db.prepare(`
    UPDATE sessions
    SET status='completed', finished_at=COALESCE(finished_at, ends_at)
    WHERE status='active' AND ends_at <= ?
  `).bind(now).run();
}

async function getState(request, db){
  await expireSessions(db);
  const now=isoNow();
  const requesterHash=await clientIPHash(request);

  const {results} = await db.prepare(`
    SELECT
      m.id, m.tower, m.type, m.number,
      s.id AS session_id, s.apartment, s.duration_minutes,
      s.started_at, s.ends_at, s.status, s.owner_ip_hash
    FROM machines m
    LEFT JOIN sessions s
      ON s.machine_id=m.id AND s.status='active'
    WHERE m.active=1
    ORDER BY m.tower, CASE m.type WHEN 'washer' THEN 0 ELSE 1 END, m.number
  `).all();

  const pickupResult = await db.prepare(`
    SELECT s.machine_id, s.apartment, s.ends_at, s.pickup_until
    FROM sessions s
    WHERE s.status='completed'
      AND s.ends_at <= ?
      AND s.pickup_until > ?
    ORDER BY s.ends_at DESC
  `).bind(now,now).all();

  const pickupByMachine = new Map();
  for(const p of pickupResult.results){
    if(!pickupByMachine.has(p.machine_id)) pickupByMachine.set(p.machine_id,p);
  }

  return results.map(r => {
    const pickup = pickupByMachine.get(r.id);
    return {
      id:r.id, tower:r.tower, type:r.type, number:r.number,
      session:r.session_id ? {
        id:r.session_id,
        tower:r.tower,
        apartment:r.apartment,
        duration_minutes:r.duration_minutes,
        started_at:r.started_at,
        ends_at:r.ends_at,
        status:r.status,
        can_stop: r.owner_ip_hash === requesterHash
      } : null,
      pickup: !r.session_id && pickup ? {
        apartment: pickup.apartment,
        since: pickup.ends_at,
        until: pickup.pickup_until
      } : null
    };
  });
}

async function handleStart(req, env){
  const body=await req.json();
  const tower=Number(body.tower);
  const apartment=String(body.apartment||"").trim();
  const machineIds=Array.isArray(body.machine_ids)?body.machine_ids:[];
  const duration=Number(body.duration_minutes);

  if(![1,2].includes(tower)) return json({error:"Torre inválida."},400);
  if(!/^\d{3,4}$/.test(apartment)) return json({error:"Departamento inválido."},400);
  if(![45,90].includes(duration)) return json({error:"Duración no permitida."},400);
  if(!machineIds.length || machineIds.length>6) return json({error:"Selecciona entre 1 y 6 máquinas."},400);

  await expireSessions(env.DB);

  const placeholders=machineIds.map(()=>"?").join(",");
  const machineRows=await env.DB.prepare(
    `SELECT id,tower FROM machines WHERE active=1 AND id IN (${placeholders})`
  ).bind(...machineIds).all();

  if(machineRows.results.length!==machineIds.length)
    return json({error:"Una o más máquinas no existen."},400);

  if(machineRows.results.some(m=>Number(m.tower)!==tower))
    return json({error:"Solo puedes iniciar máquinas de la torre seleccionada."},400);

  const occupied=await env.DB.prepare(
    `SELECT machine_id FROM sessions WHERE status='active' AND machine_id IN (${placeholders})`
  ).bind(...machineIds).all();

  if(occupied.results.length)
    return json({error:"Una de las máquinas acaba de ser ocupada. Actualiza e intenta nuevamente."},409);

  const ownerHash=await clientIPHash(req);
  const started=new Date();
  const ends=new Date(started.getTime()+duration*60*1000);
  const pickupUntil=new Date(ends.getTime()+5*60*1000);

  const statements=machineIds.map(id=>env.DB.prepare(`
    INSERT INTO sessions
    (id,machine_id,tower,apartment,duration_minutes,started_at,ends_at,pickup_until,status,created_at,owner_ip_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), id, tower, apartment, duration,
    started.toISOString(), ends.toISOString(), pickupUntil.toISOString(),
    "active", started.toISOString(), ownerHash
  ));

  try{
    await env.DB.batch(statements);
  }catch(e){
    return json({error:"Una máquina fue tomada por otro usuario. Intenta nuevamente."},409);
  }

  return json({
    ok:true,
    ends_at:ends.toISOString(),
    pickup_until:pickupUntil.toISOString()
  });
}

async function handleStop(req, env){
  const body=await req.json();
  const machineId=String(body.machine_id||"");
  const ownerHash=await clientIPHash(req);
  const now=new Date();
  const pickupUntil=new Date(now.getTime()+5*60*1000).toISOString();

  const result=await env.DB.prepare(`
    UPDATE sessions
    SET status='completed',
        finished_at=?,
        ends_at=?,
        pickup_until=?
    WHERE machine_id=?
      AND status='active'
      AND owner_ip_hash=?
  `).bind(
    now.toISOString(),
    now.toISOString(),
    pickupUntil,
    machineId,
    ownerHash
  ).run();

  if(!result.meta.changes){
    return json({
      error:"Solo la misma conexión/IP que inició este uso puede finalizarlo antes."
    },403);
  }

  return json({ok:true,pickup_until:pickupUntil});
}

async function handleHistory(url, env){
  await expireSessions(env.DB);
  const tower=url.searchParams.get("tower");
  const apartment=url.searchParams.get("apartment");
  let sql=`
    SELECT s.id,s.machine_id,s.tower,s.apartment,s.duration_minutes,
           s.started_at,s.ends_at,s.finished_at,s.pickup_until,s.status,m.type,m.number
    FROM sessions s JOIN machines m ON m.id=s.machine_id
  `;
  const args=[];
  if(tower && apartment){
    sql+=` WHERE s.tower=? AND s.apartment=?`;
    args.push(Number(tower),apartment);
  }
  sql+=` ORDER BY s.started_at DESC LIMIT 200`;
  const {results}=await env.DB.prepare(sql).bind(...args).all();

  return json({history:results.map(r=>({
    ...r,
    machine_label:`${r.type==="washer"?"Lavadora":"Secadora"} ${r.number}`
  }))});
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);

    if(url.pathname==="/api/state" && request.method==="GET"){
      return json({machines:await getState(request,env.DB)});
    }
    if(url.pathname==="/api/start" && request.method==="POST"){
      return handleStart(request,env);
    }
    if(url.pathname==="/api/stop" && request.method==="POST"){
      return handleStop(request,env);
    }
    if(url.pathname==="/api/history" && request.method==="GET"){
      return handleHistory(url,env);
    }
    if(url.pathname.startsWith("/api/")) return json({error:"Ruta no encontrada."},404);

    return env.ASSETS.fetch(request);
  }
};
