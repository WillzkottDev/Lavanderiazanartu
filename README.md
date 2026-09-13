# Lavandería Zañartu 1100

MVP mobile-first para 2 torres, cada una con:
- 3 lavadoras
- 3 secadoras
- selección de una o varias máquinas
- duración 45 / 90 minutos
- bloqueo de máquina ocupada
- cuenta regresiva
- alarma al terminar
- liberación automática al terminar el tiempo
- aviso de 5 minutos "Retirando ropa"
- historial de uso
- QR por torre o por máquina
- finalización anticipada protegida por IP

## Regla de propiedad por IP

Cuando un usuario inicia una máquina, el Worker toma la IP que Cloudflare entrega en
`CF-Connecting-IP`, la convierte a SHA-256 y guarda solamente el hash.

La aplicación NO entrega ese hash ni la IP en las respuestas públicas.

Solo una solicitud proveniente de la misma IP puede usar "Finalizar antes".
El departamento por sí solo no autoriza a detener una máquina.

IMPORTANTE: dos personas detrás de la misma IP pública (por ejemplo, el mismo Wi-Fi/NAT)
serán vistas como la misma IP. Si quieres identificación realmente individual, la siguiente
versión debería combinar IP + token secreto del navegador o autenticación por departamento.

## Fin automático + retiro de ropa

Al llegar el contador principal a 00:00:
1. La sesión pasa automáticamente a `completed`.
2. La máquina vuelve a quedar disponible.
3. Se muestra durante 5 minutos un contador pequeño: `Retirando ropa 04:59`.
4. La máquina puede ser tomada por otro usuario durante esos 5 minutos; el contador solo
   sirve como aviso de retiro de la carga anterior.
5. Si el dueño termina antes manualmente, el aviso de retiro de 5 minutos comienza desde
   ese instante.

## Arquitectura
Cloudflare Workers + Static Assets + D1.

## Instalación nueva

```bash
npm install -g wrangler
wrangler login
wrangler d1 create zanartu-lavanderia
```

Copia el `database_id` entregado por Cloudflare en `wrangler.toml`.

Luego:

```bash
wrangler d1 execute zanartu-lavanderia --remote --file=schema.sql
wrangler deploy
```

## Si ya habías desplegado la versión anterior

Ejecuta primero:

```bash
wrangler d1 execute zanartu-lavanderia --remote --file=migration_ip_pickup.sql
wrangler deploy
```

## QR sugeridos

General:
`https://TU-DOMINIO/`

Torre 1:
`https://TU-DOMINIO/?tower=1`

Torre 2:
`https://TU-DOMINIO/?tower=2`

Máquinas:
`https://TU-DOMINIO/?tower=1&machine=T1-W1`
...
`https://TU-DOMINIO/?tower=2&machine=T2-D3`

## Interfaz V3
La vista principal replica el concepto visual aprobado:
- Secadoras siempre arriba y lavadoras debajo, por torre.
- Verde: disponible.
- Rojo: ocupada.
- Amarillo: terminó el ciclo y está en los 5 minutos de "Retirando ropa"; la máquina ya se puede seleccionar.
- Azul: uso activo iniciado desde la misma IP/dispositivo visible para el usuario.
- Barra flotante inferior para iniciar una o varias máquinas.
- Modal visual para 45/90 minutos.
- Historial en formato móvil con estados.
