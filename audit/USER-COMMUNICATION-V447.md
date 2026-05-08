# V44.7 — User Communication Templates

**Audience:** users who paid for VIP/APEX expecting backtest performance (PF ~1.40 / WR ~68% claims).
**Goal:** disclose the V44.5/V44.6 implementation bug, explain the V44.7 fix, set the validation window, offer compensation.
**Tone:** honest, technical-enough to be credible, not apologetic to the point of sounding like the product is broken.

---

## A. Email — Spanish (primary)

**Subject:** `RX Trading — Update técnico importante sobre el motor APEX`

```
Hola [nombre],

Te escribo personalmente porque sos uno de los usuarios que confió en el
motor APEX. Necesito ser transparente con vos sobre algo que detectamos
revisando los datos en vivo, y qué estamos haciendo al respecto.

QUÉ PASÓ
========
El motor V44.5 y V44.6 — las versiones que estuvieron corriendo hasta
hace pocos días — usaba como señal de funding una aproximación interna
calculada con un EMA, en lugar del premium-index real publicado por
Binance. Era un atajo que hicimos cuando el endpoint público tenía
límites de rate, y nunca volvimos a la fuente real.

El backtest histórico (PF 1.40, WR 68%) se calculó con esa misma
aproximación, así que matemáticamente cerraba. Pero en mercado en vivo
el proxy se desincronizaba con el funding real lo suficiente como para
degradar el motor a ~coinflip (PF 1.05, WR 48% sobre ~750 trades en
42 días).

Resumen: la falla no era de estrategia; era una fuente de datos
incorrecta que hacía que el live no se pareciera al backtest.

QUÉ HICIMOS
===========
V44.7 — desplegada el 1 de mayo — usa el premium-index real de
Binance como fuente de funding. La lógica de la estrategia es
idéntica, solo cambia el dato de entrada. Cada señal que generamos
ahora trae explícito el campo "funding_source = premium_index_real",
que podés ver en los logs de la cuenta admin.

QUÉ NO PUEDO PROMETERTE
=======================
Solo tenemos 3 días de datos en vivo de V44.7 — estadísticamente, no
significa nada. Necesitamos entre 14 y 30 días (200+ trades cerrados
con outcome decisivo) para poder decir con honestidad si el motor
recuperó la performance del backtest, o si está en algún punto entre
1.05 y 1.40.

Hasta entonces, NO voy a publicar números nuevos, NO voy a prometer
PF específico, y NO voy a vender membresías nuevas con esos números
viejos. La página ya tiene un disclaimer de "motor en validación".

OPCIONES PARA VOS
=================
Sé que pagaste esperando los números del backtest, no esto. Tenés
tres opciones, y cualquiera está bien:

  1) ESPERAR LA VALIDACIÓN
     Te extiendo la membresía 30 días gratis (la cuenta no corre
     durante la ventana de validación). Cuando tengamos verdict
     GREEN o RED, te aviso y decidís.

  2) CRÉDITO TOTAL
     Crédito del 100% de lo pagado, aplicable a cualquier producto
     futuro de RX Trading (no expira). Útil si querés seguir el
     proyecto pero sin compromiso ahora.

  3) REEMBOLSO
     Reembolso del 100% al método de pago original. Sin preguntas.
     Procesamos en 5 días hábiles.

Respondé a este mail con "1", "2" o "3" y lo proceso.

DETALLES TÉCNICOS POR SI QUERÉS PROFUNDIZAR
===========================================
- Engine version actual (DB): apex-v44.7-funding-carry-real-1.0
- Fuente de funding: premium_index_real (verificable en logs)
- Endpoint para ver health en vivo:
  GET /api/admin/health-v447  (requiere admin secret)
- Documento técnico completo:
  audit/V447-VALIDATION-PROTOCOL.md
- Criterios de validación (gates):
  · ≥ 200 trades decisivos (Win+Loss, NO_HIT excluido)
  · WR Wilson 95% lower bound > 52%
  · PF bootstrap 95% lower CI ≥ 1.20
  · funding_source = premium_index_real ≥ 99%

Cualquier duda, respondé este mail directo. No hay automatización
acá, leo cada respuesta.

Gracias por la paciencia. Esto es un proyecto de 1 persona, y la
única forma de que esto sirva es siendo brutalmente honesto cuando
algo no funciona como prometí.

— [tu nombre]
RX Trading
```

---

## B. Email — English (translation, same structure)

**Subject:** `RX Trading — Important technical update about the APEX engine`

```
Hi [name],

I'm writing to you personally because you're one of the users who
trusted the APEX engine. I owe you full transparency about something
we found while reviewing live data, and what we're doing about it.

WHAT HAPPENED
=============
V44.5 and V44.6 — the engine versions running until a few days ago —
used an internal EMA-based approximation as the funding signal,
instead of Binance's real premium-index. It started as a workaround
during a rate-limit incident on the public endpoint, and we never
returned to the real source.

The historical backtest (PF 1.40, WR 68%) used that same approximation,
so the math worked. But in live markets, the proxy desynced from real
funding enough to degrade the engine to ~coinflip (PF 1.05, WR 48%
across ~750 trades over 42 days).

In short: the failure was not the strategy; it was an incorrect data
source making live performance diverge from the backtest.

WHAT WE DID
===========
V44.7 — deployed May 1 — uses Binance's real premium-index as the
funding source. The strategy logic is identical; only the input data
changed. Every signal we generate now carries an explicit
"funding_source = premium_index_real" field, visible in admin logs.

WHAT I CANNOT PROMISE
=====================
We only have 3 days of V44.7 live data — statistically meaningless.
We need 14–30 days (200+ closed trades with decisive outcome) to say
honestly whether the engine recovered backtest performance, or sits
somewhere between 1.05 and 1.40.

Until then, I will NOT publish new numbers, will NOT promise a
specific PF, and will NOT sell new memberships under the old numbers.
The site already shows an "engine in validation" disclaimer.

YOUR OPTIONS
============
You paid expecting the backtest numbers, not this. You have three
options. Any of them is fine.

  1) WAIT FOR VALIDATION
     I extend your membership 30 days free (the timer does not
     run during the validation window). When we hit GREEN or RED,
     I notify you and you decide.

  2) FULL CREDIT
     100% credit usable on any future RX Trading product (no
     expiry). Useful if you want to follow the project without
     commitment right now.

  3) REFUND
     100% refund to the original payment method. No questions
     asked. Processed within 5 business days.

Reply with "1", "2", or "3" and I'll handle it.

TECHNICAL DETAILS IF YOU WANT TO DIG IN
=======================================
- Current engine version (DB): apex-v44.7-funding-carry-real-1.0
- Funding source: premium_index_real (verifiable in logs)
- Live health endpoint:
  GET /api/admin/health-v447  (admin secret required)
- Full technical doc:
  audit/V447-VALIDATION-PROTOCOL.md
- Validation gates:
  · ≥ 200 decisive trades (Win+Loss, NO_HIT excluded)
  · WR Wilson 95% lower bound > 52%
  · PF bootstrap 95% lower CI ≥ 1.20
  · funding_source = premium_index_real ≥ 99%

Any questions, reply directly. There's no automation here — I read
every reply personally.

Thanks for your patience. This is a 1-person project, and the only
way it works is by being brutally honest when something didn't go
the way I promised.

— [your name]
RX Trading
```

---

## C. In-app banner (top of dashboard, persistent until validation ends)

**Spanish:**
```
ⓘ Motor APEX V44.7 en período de validación (14–30 días).
   Detectamos un bug en V44.5/V44.6 (fuente de funding incorrecta) y lo corregimos.
   Hasta que tengamos 200+ trades cerrados, no publicamos métricas live.
   [Ver detalles]  [Opciones para tu cuenta]
```

**English:**
```
ⓘ APEX V44.7 engine is in validation window (14–30 days).
   We found a bug in V44.5/V44.6 (incorrect funding source) and fixed it.
   No live metrics will be published until we have 200+ closed trades.
   [See details]  [Account options]
```

`[Ver detalles]` → modal with the same content as the email's "QUÉ PASÓ / QUÉ HICIMOS".
`[Opciones para tu cuenta]` → modal with the 3 options + a button per option that fires `POST /api/account/v447-option` with `{ choice: 1|2|3 }`.

Backend hook (when you implement it):
- Choice 1: extend `license_keys.expires_at` by 30 days, write `account_actions` row.
- Choice 2: cancel subscription, mark `account_credits` table with `amount=paid` and `usable_for=any_future_product`.
- Choice 3: refund flow (Stripe/MercadoPago/whatever); mark license revoked when refund settles.

---

## D. Refund policy update (legal page)

Add to `frontend/refund.html` a new section:

> **V44.7 Validation Window — Special Refund Policy (May 2026)**
>
> Users who purchased VIP/APEX access between [date V44.5 deployed] and [date V44.7 deployed] are entitled to:
> - Full refund (100%, original payment method), OR
> - Full credit (100%, applicable to any future RX Trading product, no expiry), OR
> - 30-day membership extension (timer pauses during validation window).
>
> This policy applies regardless of whether the engine validates GREEN, YELLOW, or RED. The trigger is the V44.5/V44.6 implementation bug, not future performance.
>
> To exercise this option, email support@rxtrading.[tld] with your license key and choice. Processing time: 5 business days.

---

## E. Public post (optional — Twitter/blog)

Only post this *after* sending the personal emails to existing paying users. Order matters: paying users first, public second.

```
Update técnico — RX Trading APEX engine.

Versión corta: detectamos en V44.5/V44.6 que la señal de funding era
una aproximación EMA en vez del premium-index real de Binance. Eso
explica por qué el backtest 1.40 PF no se replicó en live (1.05 PF
sobre 750 trades).

V44.7 (deploy 1 de mayo) usa el premium-index real. Lógica de
estrategia idéntica.

No vamos a publicar números nuevos hasta 14–30 días o 200 trades
cerrados, lo que llegue después. Hasta entonces, sin promociones.

Usuarios pagos ya recibieron mail con opciones (refund / crédito /
extensión 30d). Si no llegó: support@rxtrading.[tld].

Documento técnico: [link a V447-VALIDATION-PROTOCOL.md]
```

---

## F. What NOT to say in any of the above

- ❌ "El motor ahora es mejor" → no lo sabemos todavía.
- ❌ "PF esperado 1.30" → no podés afirmarlo sin 200 trades live.
- ❌ "El bug afectaba poco" → no minimizar.
- ❌ "Va a estar todo bien" → no lo prometás.
- ❌ "El backtest sigue siendo válido" → tampoco. El backtest tenía el mismo proxy.
- ❌ "Otros lo hacen igual" → irrelevante.

The honesty *is* the strategy here. Users tolerate bugs; they don't tolerate spin.

---

## G. Operational checklist before sending

- [ ] List of users who paid in the V44.5/V44.6 window (SQL: `SELECT email, key_code, amount_usd, completed_at FROM payments WHERE status='completed' AND completed_at BETWEEN $deploy_v445 AND $deploy_v447`).
- [ ] Personal email per user (or merge mail with `[nombre]` filled). NOT a generic newsletter blast.
- [ ] Backend endpoint `POST /api/account/v447-option` implemented and tested.
- [ ] In-app banner deployed.
- [ ] `frontend/refund.html` updated with the special policy.
- [ ] Public post staged but not published until 24h after personal emails.
- [ ] Health-check endpoint reachable from admin dashboard so you can answer the inevitable "what does the live data say right now?" replies.

Estimated effort: 2–4 hours to write personalized emails (~50 users at 5 min each) + 1 hour banner/refund-page edits + 1 hour endpoint implementation. Total: half a workday.
