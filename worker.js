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

function getClientToken(request){
  return (request.headers.get("X-Laundry-Client") || "no-client-token").slice(0,200);
}

async function clientIPHash(request){
  return hashText(getClientIP(request));
}

async function clientOwnerHash(request){
  return hashText(`${getClientIP(request)}|${getClientToken(request)}`);
}

async function expireSessions(db){
  const now=isoNow();
  await db.prepare(`
    UPDATE sessions
    SET status='completed', finished_at=COALESCE(finished_at, ends_at)
    WHERE status='active' AND ends_at <= ?
  `).bind(now).run();
}

async function expireHolds(db){
  await db.prepare(`DELETE FROM machine_holds WHERE expires_at <= ?`).bind(isoNow()).run();
}

async function housekeeping(db){
  await expireSessions(db);
  await expireHolds(db);
}

async function getState(request, db){
  await housekeeping(db);

  const now=isoNow();
  const requesterIPHash=await clientIPHash(request);
  const requesterOwnerHash=await clientOwnerHash(request);

  const {results} = await db.prepare(`
    SELECT
      m.id, m.tower, m.type, m.number,
      s.id AS session_id,
      s.tower AS resident_tower,
      s.apartment,
      s.duration_minutes,
      s.started_at,
      s.ends_at,
      s.status,
      s.owner_ip_hash,
      h.apartment AS hold_apartment,
      h.resident_tower AS hold_resident_tower,
      h.owner_client_hash AS hold_owner_client_hash,
      h.created_at AS hold_created_at,
      h.expires_at AS hold_expires_at
    FROM machines m
    LEFT JOIN sessions s
      ON s.machine_id=m.id AND s.status='active'
    LEFT JOIN machine_holds h
      ON h.machine_id=m.id
    WHERE m.active=1
    ORDER BY m.tower, CASE m.type WHEN 'dryer' THEN 0 ELSE 1 END, m.number
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
      id:r.id,
      tower:r.tower,
      type:r.type,
      number:r.number,
      session:r.session_id ? {
        id:r.session_id,
        machine_tower:r.tower,
        resident_tower:r.resident_tower,
        apartment:r.apartment,
        duration_minutes:r.duration_minutes,
        started_at:r.started_at,
        ends_at:r.ends_at,
        status:r.status,
        can_stop:r.owner_ip_hash === requesterIPHash
      } : null,
      hold: !r.session_id && r.hold_expires_at ? {
        apartment:r.hold_apartment,
        resident_tower:r.hold_resident_tower,
        created_at:r.hold_created_at,
        expires_at:r.hold_expires_at,
        mine:r.hold_owner_client_hash === requesterOwnerHash
      } : null,
      pickup: !r.session_id && pickup ? {
        apartment:pickup.apartment,
        since:pickup.ends_at,
        until:pickup.pickup_until
      } : null
    };
  });
}

async function handleHold(req, env){
  const body=await req.json();
  const machineId=String(body.machine_id||"");
  const residentTower=Number(body.tower);
  const apartment=String(body.apartment||"").trim();

  if(!machineId) return json({error:"Máquina inválida."},400);
  if(![1,2].includes(residentTower)) return json({error:"Torre del departamento inválida."},400);
  if(!/^\d{3,4}$/.test(apartment)) return json({error:"Departamento inválido."},400);

  await housekeeping(env.DB);

  const machine=await env.DB.prepare(
    `SELECT id FROM machines WHERE id=? AND active=1`
  ).bind(machineId).first();

  if(!machine) return json({error:"La máquina no existe."},404);

  const activeSession=await env.DB.prepare(
    `SELECT id FROM sessions WHERE machine_id=? AND status='active'`
  ).bind(machineId).first();

  if(activeSession) return json({error:"La máquina acaba de ser ocupada."},409);

  const ownerClientHash=await clientOwnerHash(req);
  const ownerIPHash=await clientIPHash(req);
  const existing=await env.DB.prepare(
    `SELECT owner_client_hash FROM machine_holds WHERE machine_id=?`
  ).bind(machineId).first();

  if(existing && existing.owner_client_hash !== ownerClientHash){
    return json({error:"Otro usuario acaba de seleccionar esta máquina."},409);
  }

  const created=new Date();
  const expires=new Date(created.getTime()+2*60*1000);

  if(existing){
    await env.DB.prepare(`
      UPDATE machine_holds
      SET resident_tower=?, apartment=?, owner_ip_hash=?, created_at=?, expires_at=?
      WHERE machine_id=? AND owner_client_hash=?
    `).bind(
      residentTower,apartment,ownerIPHash,created.toISOString(),expires.toISOString(),
      machineId,ownerClientHash
    ).run();
  }else{
    try{
      await env.DB.prepare(`
        INSERT INTO machine_holds
        (machine_id,resident_tower,apartment,owner_client_hash,owner_ip_hash,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?)
      `).bind(
        machineId,residentTower,apartment,ownerClientHash,ownerIPHash,
        created.toISOString(),expires.toISOString()
      ).run();
    }catch{
      return json({error:"Otro usuario acaba de seleccionar esta máquina."},409);
    }
  }

  return json({ok:true,expires_at:expires.toISOString()});
}

async function handleReleaseHold(req, env){
  const body=await req.json();
  const machineId=String(body.machine_id||"");
  const ownerClientHash=await clientOwnerHash(req);

  await expireHolds(env.DB);

  const result=await env.DB.prepare(`
    DELETE FROM machine_holds
    WHERE machine_id=? AND owner_client_hash=?
  `).bind(machineId,ownerClientHash).run();

  if(!result.meta.changes){
    return json({error:"Esta selección ya no te pertenece o ya expiró."},409);
  }

  return json({ok:true});
}

async function handleStart(req, env){
  const body=await req.json();
  const residentTower=Number(body.tower);
  const apartment=String(body.apartment||"").trim();
  const machineIds=Array.isArray(body.machine_ids)?body.machine_ids:[];
  const duration=Number(body.duration_minutes);

  if(![1,2].includes(residentTower)) return json({error:"Torre del departamento inválida."},400);
  if(!/^\d{3,4}$/.test(apartment)) return json({error:"Departamento inválido."},400);
  if(![45,90].includes(duration)) return json({error:"Duración no permitida."},400);
  if(!machineIds.length || machineIds.length>12) return json({error:"Selecciona al menos una máquina."},400);

  await housekeeping(env.DB);

  const placeholders=machineIds.map(()=>"?").join(",");
  const machineRows=await env.DB.prepare(
    `SELECT id,tower FROM machines WHERE active=1 AND id IN (${placeholders})`
  ).bind(...machineIds).all();

  if(machineRows.results.length!==machineIds.length)
    return json({error:"Una o más máquinas no existen."},400);

  // Importante: la torre del departamento NO restringe la torre de la máquina.
  // Se pueden seleccionar máquinas de Torre 1 y Torre 2 desde la vista "Todas".

  const occupied=await env.DB.prepare(
    `SELECT machine_id FROM sessions WHERE status='active' AND machine_id IN (${placeholders})`
  ).bind(...machineIds).all();

  if(occupied.results.length)
    return json({error:"Una de las máquinas acaba de ser ocupada."},409);

  const ownerClientHash=await clientOwnerHash(req);
  const ownHolds=await env.DB.prepare(
    `SELECT machine_id FROM machine_holds
     WHERE owner_client_hash=? AND machine_id IN (${placeholders}) AND expires_at > ?`
  ).bind(ownerClientHash,...machineIds,isoNow()).all();

  const heldIds=new Set(ownHolds.results.map(r=>r.machine_id));
  if(machineIds.some(id=>!heldIds.has(id))){
    return json({error:"Una selección expiró o fue tomada por otro usuario. Selecciona nuevamente."},409);
  }

  const ownerIPHash=await clientIPHash(req);
  const started=new Date();
  const ends=new Date(started.getTime()+duration*60*1000);
  const pickupUntil=new Date(ends.getTime()+5*60*1000);

  const statements=[];
  for(const id of machineIds){
    statements.push(env.DB.prepare(`
      INSERT INTO sessions
      (id,machine_id,tower,apartment,duration_minutes,started_at,ends_at,pickup_until,status,created_at,owner_ip_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crypto.randomUUID(),id,residentTower,apartment,duration,
      started.toISOString(),ends.toISOString(),pickupUntil.toISOString(),
      "active",started.toISOString(),ownerIPHash
    ));
  }

  statements.push(
    env.DB.prepare(`
      DELETE FROM machine_holds
      WHERE owner_client_hash=? AND machine_id IN (${placeholders})
    `).bind(ownerClientHash,...machineIds)
  );

  try{
    await env.DB.batch(statements);
  }catch{
    return json({error:"Una máquina fue tomada por otro usuario. Actualiza e intenta nuevamente."},409);
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
  const ownerIPHash=await clientIPHash(req);
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
    ownerIPHash
  ).run();

  if(!result.meta.changes){
    return json({
      error:"Solo la misma IP que inició este uso puede finalizarlo antes."
    },403);
  }

  return json({ok:true,pickup_until:pickupUntil});
}

async function handleHistory(url, env){
  await expireSessions(env.DB);
  const residentTower=url.searchParams.get("tower");
  const apartment=url.searchParams.get("apartment");

  let sql=`
    SELECT
      s.id,s.machine_id,s.tower AS resident_tower,s.apartment,s.duration_minutes,
      s.started_at,s.ends_at,s.finished_at,s.pickup_until,s.status,
      m.tower AS machine_tower,m.type,m.number
    FROM sessions s
    JOIN machines m ON m.id=s.machine_id
  `;
  const args=[];

  if(residentTower && apartment){
    sql+=` WHERE s.tower=? AND s.apartment=?`;
    args.push(Number(residentTower),apartment);
  }

  sql+=` ORDER BY s.started_at DESC LIMIT 200`;
  const {results}=await env.DB.prepare(sql).bind(...args).all();

  return json({history:results.map(r=>({
    ...r,
    tower:r.machine_tower,
    machine_label:`${r.type==="washer"?"Lavadora":"Secadora"} ${r.number}`
  }))});
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);

    if(url.pathname==="/api/state" && request.method==="GET"){
      return json({machines:await getState(request,env.DB)});
    }
    if(url.pathname==="/api/hold" && request.method==="POST"){
      return handleHold(request,env);
    }
    if(url.pathname==="/api/hold/release" && request.method==="POST"){
      return handleReleaseHold(request,env);
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
