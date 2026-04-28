#!/usr/bin/env node
'use strict';
// 00 — Data audit + prep for V44 research
// Reutiliza /tmp/binance-klines-1m/ (ya descargados)
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const OUT_DIR=path.join(__dirname,'..','data');
if(!fs.existsSync(OUT_DIR))fs.mkdirSync(OUT_DIR,{recursive:true});

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','NEARUSDT','ARBUSDT','1000PEPEUSDT'];

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti});}return o;}

console.log('V44 Data Audit — 1m klines');
console.log('═'.repeat(80));
const summary={pairs:{},total_bars:0,date_range:{start:Infinity,end:0},date_start:null,date_end:null};
for(const pair of PAIRS){
  const b1m=load1m(pair);
  if(!b1m||b1m.length<10000){console.log(`${pair.padEnd(14)} SKIP`);continue;}
  const b1h=aggTF(b1m,60);
  const b4h=aggTF(b1m,240);
  summary.pairs[pair]={n_1m:b1m.length,n_1h:b1h.length,n_4h:b4h.length,start:new Date(b1m[0][0]).toISOString().slice(0,10),end:new Date(b1m[b1m.length-1][0]).toISOString().slice(0,10)};
  summary.total_bars+=b1m.length;
  summary.date_range.start=Math.min(summary.date_range.start,b1m[0][0]);
  summary.date_range.end=Math.max(summary.date_range.end,b1m[b1m.length-1][0]);
  console.log(`${pair.padEnd(14)} ${String(b1m.length).padStart(8)} 1m ${String(b1h.length).padStart(5)} 1h ${String(b4h.length).padStart(4)} 4h  ${summary.pairs[pair].start} → ${summary.pairs[pair].end}`);
}
summary.date_start=new Date(summary.date_range.start).toISOString();
summary.date_end=new Date(summary.date_range.end).toISOString();
summary.total_days=Math.floor((summary.date_range.end-summary.date_range.start)/86400000);
delete summary.date_range;
console.log('─'.repeat(80));
console.log(`Total: ${Object.keys(summary.pairs).length} pairs × ${summary.total_days}d span`);
console.log(`Range: ${summary.date_start.slice(0,10)} → ${summary.date_end.slice(0,10)}`);
fs.writeFileSync(path.join(OUT_DIR,'audit.json'),JSON.stringify(summary,null,2));
console.log(`\n✓ Saved: ${OUT_DIR}/audit.json`);
