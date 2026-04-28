#!/usr/bin/env node
'use strict';
// V46 T7 — Wavelet Decomposition of Funding Series
// Daubechies db2 wavelets aplicados a funding rate series.
// Separar low-frequency (signal) de high-frequency (noise).
// Usar serie limpia para z-score → mejores entries.
//
// Implementación: 2-level discrete wavelet transform (DWT) con Daubechies-2 (db2).
// Reconstruimos solo low-frequency component.

const fs = require('fs');
const path = require('path');
const KLINES_DIR = '/tmp/binance-klines-1h';
const FUND_DIR = '/tmp/binance-funding';
const OUT_DIR = path.join(__dirname, '..', 'results');
const CFG = process.argv[2] || 't7';

const FLAGS = {
  P11: process.env.APEX_V45_PAIR_SIZING !== '0',
  P7:  process.env.APEX_V45_TERM_STRUCTURE !== '0',
  T7: process.env.APEX_V46_T7 === '1'
};

const COSTS = { fee_taker: 0.0005, fee_maker: 0.0002, slip_entry: 0.0002, slip_sl: 0.0002, slip_timestop: 0.0005 };
const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];

console.log('═'.repeat(80));
console.log(`V46 T7 WAVELET — ${CFG.toUpperCase()}`);
console.log('═'.repeat(80));
console.log(`Flags: ${Object.entries(FLAGS).filter(([,v])=>v).map(([k])=>k).join(', ')}`);

const data = {}, funding = {};
for(const p of PAIRS){
  const fk = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(fk)) continue;
  data[p] = JSON.parse(fs.readFileSync(fk, 'utf8')).map(b => ({ t:b[0], o:b[1], h:b[2], l:b[3], c:b[4] }));
  const ff = path.join(FUND_DIR, `${p}.json`);
  if(fs.existsSync(ff)) funding[p] = JSON.parse(fs.readFileSync(ff, 'utf8'));
}
function proxyFunding(bars){
  const n=bars.length, c=bars.map(b=>b.c);
  const ema=new Float64Array(n); ema[0]=c[0]; const a=2/51;
  for(let i=1;i<n;i++) ema[i]=c[i]*a+ema[i-1]*(1-a);
  const prem=c.map((v,i)=>(v-ema[i])/ema[i]);
  const f=new Float64Array(n);
  for(let i=8;i<n;i++){ let s=0; for(let j=i-7;j<=i;j++) s+=prem[j]; f[i]=s/8; }
  return f;
}

// === T7 Daubechies-2 wavelet decomposition (no lookahead — only past data) ===
// db2 filters
const SQRT2 = Math.SQRT2;
const C = (1 + Math.sqrt(3)) / (4 * SQRT2);
const C1 = (3 + Math.sqrt(3)) / (4 * SQRT2);
const C2 = (3 - Math.sqrt(3)) / (4 * SQRT2);
const C3 = (1 - Math.sqrt(3)) / (4 * SQRT2);
const H = [C, C1, C2, C3];        // low-pass
const G = [C3, -C2, C1, -C];      // high-pass

// Single-level DWT applied to a signal of length N (must be even).
// Returns { lp, hp } where lp = approximation (low freq), hp = detail (high freq).
function dwt1(signal){
  const n = signal.length;
  const half = Math.floor(n/2);
  const lp = new Float64Array(half);
  const hp = new Float64Array(half);
  for(let k=0; k<half; k++){
    const i0 = (2*k) % n;
    const i1 = (2*k + 1) % n;
    const i2 = (2*k + 2) % n;
    const i3 = (2*k + 3) % n;
    lp[k] = H[0]*signal[i0] + H[1]*signal[i1] + H[2]*signal[i2] + H[3]*signal[i3];
    hp[k] = G[0]*signal[i0] + G[1]*signal[i1] + G[2]*signal[i2] + G[3]*signal[i3];
  }
  return { lp, hp };
}

// Inverse DWT (single level): reconstruct from lp + hp
function idwt1(lp, hp){
  const half = lp.length;
  const n = half * 2;
  const out = new Float64Array(n);
  for(let k=0; k<half; k++){
    out[2*k]   = (H[2]*lp[k] + G[2]*hp[k] + H[0]*lp[(k+1)%half] + G[0]*hp[(k+1)%half]);
    out[2*k+1] = (H[3]*lp[k] + G[3]*hp[k] + H[1]*lp[(k+1)%half] + G[1]*hp[(k+1)%half]);
  }
  return out;
}

// Denoise: 2-level DWT, zero-out high-freq detail at level 1, reconstruct.
// Aplicado a window de 64 samples cada vez (rolling, no lookahead).
function denoiseFundingAt(fundSeries, idx, windowSize = 64){
  if(idx < windowSize) return fundSeries[idx];
  const win = new Float64Array(windowSize);
  for(let k=0; k<windowSize; k++) win[k] = fundSeries[idx - windowSize + 1 + k];
  // Level 1
  const { lp: a1, hp: d1 } = dwt1(win);
  // Level 2 on a1
  const { lp: a2, hp: d2 } = dwt1(a1);
  // Soft-threshold d1 (suppress high freq)
  const sigma = medianAbs(d1) / 0.6745;
  const thresh = sigma * Math.sqrt(2 * Math.log(d1.length));
  const d1f = new Float64Array(d1.length);
  for(let k=0; k<d1.length; k++){
    const v = d1[k];
    if(Math.abs(v) > thresh) d1f[k] = Math.sign(v) * (Math.abs(v) - thresh);
    else d1f[k] = 0;
  }
  // Reconstruct: idwt(a1, d1f) gives denoised signal
  // (we keep a1 = idwt(a2, d2) but at level 1 we just use a1 unchanged)
  const denoised = idwt1(a1, d1f);
  return denoised[denoised.length - 1];  // return latest sample
}

function medianAbs(arr){
  const a = Array.from(arr).map(Math.abs).sort((x,y)=>x-y);
  return a[Math.floor(a.length/2)];
}

// Pre-compute denoised funding series (no lookahead — each point uses only past 64 samples)
const fundCache = {}, fundDenoised = {};
for(const p of PAIRS){
  if(!data[p]) continue;
  const f = proxyFunding(data[p]);
  fundCache[p] = f;
  if(FLAGS.T7){
    const fd = new Float64Array(f.length);
    for(let i=0; i<f.length; i++){
      fd[i] = denoiseFundingAt(f, i, 64);
    }
    fundDenoised[p] = fd;
  } else {
    fundDenoised[p] = f;
  }
}

function pairSizeMultV45(rpf){
  if(rpf===null) return 1.0;
  if(rpf>=2.5) return 1.6; if(rpf>=2.0) return 1.4; if(rpf>=1.5) return 1.2;
  if(rpf>=1.2) return 1.0; if(rpf>=1.0) return 0.85; if(rpf>=0.8) return 0.65;
  return 0.45;
}
function termStructureBoost(fund, idx, dir){
  if(idx<168) return 1.0;
  const f24=[]; for(let j=idx-24;j<idx;j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d=[]; for(let j=idx-168;j<idx;j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length<12 || f7d.length<80) return 1.0;
  const m24=f24.reduce((a,b)=>a+b,0)/f24.length;
  const m7d=f7d.reduce((a,b)=>a+b,0)/f7d.length;
  const std=Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2,0)/f7d.length);
  const aligned = dir===1 ? -(m24-m7d) : (m24-m7d);
  const norm = std>0 ? aligned/std : 0;
  return 1.0 + Math.max(0, Math.min(0.30, norm*0.15));
}
function realFundingPay(pair, dir, sizeUSD, openTs, closeTs){
  const arr=funding[pair]; if(!arr) return 0;
  let total=0;
  for(const [ft, rate] of arr) if(ft>=openTs && ft<=closeTs) total += rate;
  return -total*sizeUSD*dir;
}

const INIT_CAP=500, SIZE_PCT=0.10, TP_BPS=30, SL_BPS=25, HOLD_H=4;
const trades=[], dailyPnL={};
let cap=INIT_CAP, totalFees=0, totalSlip=0, totalFund=0;
const tradesByPair={}; PAIRS.forEach(p=>tradesByPair[p]=[]);
function rollingPF(arr, ts){
  if(!FLAGS.P11) return null;
  const cE=ts-7*86400000, cS=cE-90*86400000;
  const w=arr.filter(t=>t.ts>=cS && t.ts<=cE);
  if(w.length<30) return null;
  const wins=w.filter(t=>t.pnl>0);
  const gp=wins.reduce((s,t)=>s+t.pnl,0);
  const gl=-w.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0);
  return gl>0?gp/gl:999;
}

const stream=[];
for(const pair of PAIRS){
  if(!data[pair]) continue;
  for(let i=50;i<data[pair].length-HOLD_H;i++) stream.push({ pair, i, t:data[pair][i].t });
}
stream.sort((a,b)=>a.t-b.t);

const posBy={}; PAIRS.forEach(p=>posBy[p]=null);
const t0=Date.now();

for(const evt of stream){
  const { pair, i, t } = evt;
  const bars=data[pair];
  // Use denoised funding for SIGNAL detection if T7 on, else raw
  const fundSig = FLAGS.T7 ? fundDenoised[pair] : fundCache[pair];
  // Always use raw for term-structure boost (P7) to avoid double-smoothing
  const fundRaw = fundCache[pair];
  const hr=new Date(t).getUTCHours();
  const pos=posBy[pair];

  if(pos){
    const dir=pos.dir, h=bars[i].h, l=bars[i].l;
    const hitTP=(dir===1 && h>=pos.tpP) || (dir===-1 && l<=pos.tpP);
    const hitSL=(dir===1 && l<=pos.slP) || (dir===-1 && h>=pos.slP);
    const elapsed=i-pos.entryI;
    if(hitTP || hitSL || elapsed>=HOLD_H){
      let exitP, exitFee, type;
      if(hitTP){ exitP=pos.tpP; exitFee=pos.size*COSTS.fee_taker; type='TP'; }
      else if(hitSL){ exitP=dir===1?pos.slP*(1-COSTS.slip_sl):pos.slP*(1+COSTS.slip_sl); exitFee=pos.size*COSTS.fee_taker; totalSlip+=pos.size*COSTS.slip_sl; type='SL'; }
      else { const c=bars[i].c; exitP=dir===1?c*(1-COSTS.slip_timestop):c*(1+COSTS.slip_timestop); exitFee=pos.size*COSTS.fee_taker; totalSlip+=pos.size*COSTS.slip_timestop; type='TIMESTOP'; }
      const pnlPct=dir===1?(exitP-pos.entryFill)/pos.entryFill:(pos.entryFill-exitP)/pos.entryFill;
      const gross=pos.size*pnlPct;
      const fp=realFundingPay(pair,dir,pos.size,pos.openTs,bars[i].t);
      totalFund+=fp;
      const net=gross-exitFee+fp-pos.fee_entry;
      cap+=net; totalFees+=exitFee;
      const dk=new Date(bars[i].t).toISOString().slice(0,10);
      dailyPnL[dk]=(dailyPnL[dk]||0)+net;
      const tr={ pnl:net, ts:bars[i].t, pair, dir, type };
      trades.push(tr); tradesByPair[pair].push(tr);
      posBy[pair]=null;
    }
    if(posBy[pair]) continue;
  }

  if(posBy[pair]) continue;
  if(hr!==0 && hr!==8 && hr!==16) continue;
  if(!isFinite(fundSig[i])) continue;
  const fW=[]; for(let j=Math.max(0,i-168); j<i; j++) if(isFinite(fundSig[j])) fW.push(fundSig[j]);
  if(fW.length<50) continue;
  const sorted=[...fW].sort((a,b)=>a-b);
  const p80=sorted[Math.floor(sorted.length*0.8)]||0;
  const p20=sorted[Math.floor(sorted.length*0.2)]||0;
  let dir=0;
  if(fundSig[i]>p80 && fundSig[i]>0.005) dir=-1;
  else if(fundSig[i]<p20 && fundSig[i]<-0.002) dir=1;
  if(dir===0) continue;

  let sizeMult=1.0;
  if(FLAGS.P11) sizeMult*=pairSizeMultV45(rollingPF(tradesByPair[pair], t));
  if(FLAGS.P7) sizeMult*=termStructureBoost(fundRaw, i, dir);
  sizeMult=Math.min(2.0, sizeMult);

  const eR=bars[i].c;
  const eF=dir===1?eR*(1+COSTS.slip_entry):eR*(1-COSTS.slip_entry);
  const finalSize=cap*SIZE_PCT*sizeMult;
  const tpP=dir===1?eF*(1+TP_BPS/10000):eF*(1-TP_BPS/10000);
  const slP=dir===1?eF*(1-SL_BPS/10000):eF*(1+SL_BPS/10000);
  const fee=finalSize*COSTS.fee_taker;
  totalFees+=fee; totalSlip+=finalSize*COSTS.slip_entry;
  posBy[pair]={ entryRaw:eR, entryFill:eF, dir, entryI:i, size:finalSize, sizeMult, tpP, slP, fee_entry:fee, pair, openTs:bars[i].t };
}

const dt=((Date.now()-t0)/1000).toFixed(1);
const w=trades.filter(t=>t.pnl>0), l=trades.filter(t=>t.pnl<=0);
const gp=w.reduce((s,t)=>s+t.pnl,0), gl=-l.reduce((s,t)=>s+t.pnl,0);
const days=Object.keys(dailyPnL).sort();
const dr=days.map(d=>dailyPnL[d]/INIT_CAP);
const m=dr.reduce((a,b)=>a+b,0)/Math.max(1,dr.length);
const v=dr.reduce((s,r)=>s+(r-m)**2,0)/Math.max(1,dr.length);
const sh=Math.sqrt(v)>0?(m/Math.sqrt(v))*Math.sqrt(365):0;
let pk=0,mdd=0,cum=0;
for(const d of days){ cum+=dailyPnL[d]; if(cum>pk) pk=cum; if(pk-cum>mdd) mdd=pk-cum; }
const pf=gl>0?gp/gl:999, wr=(w.length/trades.length)*100, tpd=days.length>0?trades.length/days.length:0;
const win7d=[];
for(let i=0; i+6<days.length; i++) win7d.push(days.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d],0));
const pos7d=win7d.filter(p=>p>0).length;
const positivePct=win7d.length>0?(pos7d/win7d.length)*100:0;
const sortedW=[...win7d].sort((a,b)=>a-b);
const worstWin=sortedW[0]||0;

console.log('');
console.log(`Trades: ${trades.length}  PF: ${pf.toFixed(3)}  WR: ${wr.toFixed(2)}%  PnL: $${trades.reduce((s,t)=>s+t.pnl,0).toFixed(2)}  DD: ${(mdd/INIT_CAP*100).toFixed(2)}%  Sharpe: ${sh.toFixed(2)}  t/d: ${tpd.toFixed(2)}`);
console.log(`7d windows: ${positivePct.toFixed(1)}% pos | worst $${worstWin.toFixed(2)} (${(worstWin/INIT_CAP*100).toFixed(2)}%)`);

const out={ config:CFG, flags:FLAGS, trades:trades.length, pf, wr, pnl:trades.reduce((s,t)=>s+t.pnl,0), mddPct:mdd/INIT_CAP*100, sharpe:sh, tpd, positivePct, worstWin, worstPct:worstWin/INIT_CAP*100, runtime_s:parseFloat(dt) };
fs.writeFileSync(path.join(OUT_DIR, `v46_t7_${CFG}.json`), JSON.stringify(out, null, 2));
console.log(`✓ Saved (${dt}s)`);
