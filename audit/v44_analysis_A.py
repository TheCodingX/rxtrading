"""
ANÁLISIS A — Distribución de PnL por ventana 7d rolling
Fuente: archive/research/research-v44/apex-x/results/01_backtest_274d.json (stream_b = V44 funding carry)

Genera estadísticas reales sobre las 261 ventanas rolling de 7d.
"""
import json
from datetime import datetime, timedelta
from collections import defaultdict

with open('audit/v44_baseline_daily.json') as f:
    d = json.load(f)

daily = d['dailyPnL']  # dict: {"YYYY-MM-DD": pnl}

# Ordenar por fecha
dates = sorted(daily.keys())
date_objs = [datetime.strptime(s, "%Y-%m-%d") for s in dates]

# Construir series completa con días faltantes = 0
start = date_objs[0]
end = date_objs[-1]
all_days = []
cur = start
while cur <= end:
    key = cur.strftime("%Y-%m-%d")
    all_days.append((cur, daily.get(key, 0.0)))
    cur += timedelta(days=1)

print(f"Date range: {start.date()} → {end.date()}")
print(f"Total days (filled): {len(all_days)}")
print(f"Days with non-zero PnL: {sum(1 for _,p in all_days if p != 0)}")

# Capital inicial: el script original usa $10k (estándar V44 backtest config)
INITIAL_CAP = 10000

# Generar ventanas rolling de 7d
windows_7d = []
for i in range(len(all_days) - 6):
    window = all_days[i:i+7]
    pnl = sum(p for _,p in window)
    wins = sum(1 for _,p in window if p > 0)
    losses = sum(1 for _,p in window if p < 0)
    flat = sum(1 for _,p in window if p == 0)
    gross_profit = sum(p for _,p in window if p > 0)
    gross_loss = -sum(p for _,p in window if p < 0)
    pf = gross_profit / gross_loss if gross_loss > 0 else float('inf')
    pct = (pnl / INITIAL_CAP) * 100
    windows_7d.append({
        'start': window[0][0].strftime("%Y-%m-%d"),
        'end': window[6][0].strftime("%Y-%m-%d"),
        'pnl': pnl,
        'pct': pct,
        'wins': wins,
        'losses': losses,
        'flat': flat,
        'gross_profit': gross_profit,
        'gross_loss': gross_loss,
        'pf': pf if pf != float('inf') else 999.0,
    })

# === MÉTRICAS DE DISTRIBUCIÓN ===
n_windows = len(windows_7d)
positive_pnl = sum(1 for w in windows_7d if w['pnl'] > 0)
negative_pnl = sum(1 for w in windows_7d if w['pnl'] < 0)
flat_pnl = sum(1 for w in windows_7d if w['pnl'] == 0)
positive_pct = (positive_pnl / n_windows) * 100
pf_above_1 = sum(1 for w in windows_7d if w['pf'] > 1.0)
pf_above_1_pct = (pf_above_1 / n_windows) * 100

pnls = sorted([w['pnl'] for w in windows_7d])
pcts = sorted([w['pct'] for w in windows_7d])
pfs = sorted([w['pf'] for w in windows_7d if w['pf'] < 999])

def percentile(arr, p):
    if not arr: return 0
    k = (len(arr) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(arr) - 1)
    return arr[f] + (arr[c] - arr[f]) * (k - f)

# Worst y best
worst = min(windows_7d, key=lambda w: w['pnl'])
best = max(windows_7d, key=lambda w: w['pnl'])

# === REPORTE ===
report = []
report.append("=" * 70)
report.append("ANÁLISIS A — Distribución de PnL en ventanas 7d rolling")
report.append("=" * 70)
report.append(f"\nFuente: V44 stream_b funding carry (production engine)")
report.append(f"Período: {start.date()} → {end.date()}")
report.append(f"Capital base: ${INITIAL_CAP:,}")
report.append(f"\nTotal ventanas 7d generadas: {n_windows}")
report.append(f"\n--- DISTRIBUCIÓN PnL ---")
report.append(f"Ventanas con PnL > 0:    {positive_pnl} ({positive_pct:.1f}%)")
report.append(f"Ventanas con PnL < 0:    {negative_pnl} ({negative_pnl/n_windows*100:.1f}%)")
report.append(f"Ventanas con PnL = 0:    {flat_pnl} ({flat_pnl/n_windows*100:.1f}%)")
report.append(f"Ventanas con PF > 1.0:   {pf_above_1} ({pf_above_1_pct:.1f}%)")
report.append(f"\n--- PERCENTILES PnL (USD) ---")
report.append(f"P5 (worst 5%):    ${percentile(pnls, 5):.2f}")
report.append(f"P10:              ${percentile(pnls, 10):.2f}")
report.append(f"P25:              ${percentile(pnls, 25):.2f}")
report.append(f"P50 (median):     ${percentile(pnls, 50):.2f}")
report.append(f"P75:              ${percentile(pnls, 75):.2f}")
report.append(f"P90:              ${percentile(pnls, 90):.2f}")
report.append(f"P95 (best 5%):    ${percentile(pnls, 95):.2f}")
report.append(f"\n--- PERCENTILES PnL (% capital) ---")
report.append(f"P5:    {percentile(pcts, 5):.3f}%")
report.append(f"P10:   {percentile(pcts, 10):.3f}%")
report.append(f"P25:   {percentile(pcts, 25):.3f}%")
report.append(f"P50:   {percentile(pcts, 50):.3f}%")
report.append(f"P75:   {percentile(pcts, 75):.3f}%")
report.append(f"P90:   {percentile(pcts, 90):.3f}%")
report.append(f"P95:   {percentile(pcts, 95):.3f}%")
report.append(f"\n--- PERCENTILES PF ---")
report.append(f"P5 PF:     {percentile(pfs, 5):.3f}")
report.append(f"P25 PF:    {percentile(pfs, 25):.3f}")
report.append(f"P50 PF:    {percentile(pfs, 50):.3f}")
report.append(f"P75 PF:    {percentile(pfs, 75):.3f}")
report.append(f"P95 PF:    {percentile(pfs, 95):.3f}")
report.append(f"\n--- PEORES 5 VENTANAS 7d ---")
worst_5 = sorted(windows_7d, key=lambda w: w['pnl'])[:5]
for w in worst_5:
    report.append(f"  {w['start']} → {w['end']}: PnL ${w['pnl']:+.2f} ({w['pct']:+.2f}%) | wins={w['wins']} losses={w['losses']} PF={w['pf']:.2f}")
report.append(f"\n--- MEJORES 5 VENTANAS 7d ---")
best_5 = sorted(windows_7d, key=lambda w: w['pnl'], reverse=True)[:5]
for w in best_5:
    report.append(f"  {w['start']} → {w['end']}: PnL ${w['pnl']:+.2f} ({w['pct']:+.2f}%) | wins={w['wins']} losses={w['losses']} PF={w['pf']:.2f}")

# === DECISIÓN ===
report.append(f"\n{'='*70}")
report.append("CONCLUSIÓN ANÁLISIS A")
report.append(f"{'='*70}")
target_85 = 85.0
target_95 = 95.0
gap_85 = target_85 - positive_pct
gap_95 = target_95 - positive_pct
report.append(f"\nTarget user: 85% mínimo, 95% ideal de ventanas 7d positivas")
report.append(f"Actual V44: {positive_pct:.1f}% positivas")
report.append(f"Gap a target 85%: {gap_85:+.1f}pp")
report.append(f"Gap a target 95%: {gap_95:+.1f}pp")

if positive_pct >= 95:
    report.append("\n✅ V44 YA cumple target 95%. NO hay problema 7d. UI debe mostrar 7d sin disclaimer.")
elif positive_pct >= 85:
    report.append("\n⚠️  V44 cumple 85% pero no 95%. Mejoras pueden cerrar gap.")
else:
    report.append(f"\n❌ V44 NO cumple 85%. Gap de {gap_85:.1f}pp requiere intervención.")

# Worst-case analysis (CRÍTICO para target "min 7d ≥-1%")
worst_pct = worst['pct']
if worst_pct >= -1:
    report.append(f"✅ Worst 7d ({worst_pct:.2f}%) cumple target -1%")
else:
    report.append(f"❌ Worst 7d ({worst_pct:.2f}%) viola target -1% por {abs(worst_pct + 1):.2f}pp")

text = '\n'.join(report)
print(text)

# Save
with open('audit/V44-ANALYSIS-A-7d-distribution.md', 'w') as f:
    f.write("# ANÁLISIS A — Distribución 7d rolling\n\n```\n" + text + "\n```\n")

# Save raw windows for follow-up analyses
with open('audit/v44_windows_7d.json', 'w') as f:
    json.dump({
        'baseline_stats': {
            'pf': d['pf'],
            'wr': d['wr'],
            'sharpe': d['sharpe'],
            'mddPct': d['mddPct'],
            'n': d['n'],
            'tpd': d['tpd'],
        },
        'distribution': {
            'positive_pct': positive_pct,
            'pf_above_1_pct': pf_above_1_pct,
            'p5_pnl': percentile(pnls, 5),
            'p50_pnl': percentile(pnls, 50),
            'p95_pnl': percentile(pnls, 95),
            'p5_pct': percentile(pcts, 5),
            'p50_pct': percentile(pcts, 50),
            'p95_pct': percentile(pcts, 95),
            'worst_pnl': worst['pnl'],
            'worst_pct': worst['pct'],
            'worst_dates': [worst['start'], worst['end']],
        },
        'windows': windows_7d
    }, f, indent=2)
