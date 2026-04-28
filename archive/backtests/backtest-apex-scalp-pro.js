#!/usr/bin/env node
'use strict';
// APEX SCALP-PRO — 10-Indicator Scoring + RSI Divergence + MTF Gating
// RSI/Stoch/BB/MACD/EMA/VWAP/Vol/Keltner/PSAR/MFI each vote -1/0/+1
// Require min score 5 + bullish/bearish divergence + 1H gate + 15m confirm
// TP 3.0×ATR / SL 1.2×ATR (ratio 2.5:1 optimized for WR 40-48% → PF 1.6-2.0)

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,minutes){const out=[];const stepMs=minutes*60000;let s=0;while(s<b1m.length&&(b1m[s][0]%stepMs)!==0)s++;for(let i=s;i<b1m.length;i+=minutes){const g=b1m.slice(i,i+minutes);if(g.length<minutes)break;let h=-Infinity,l=Infinity,v=0,tbv=0,qv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];qv+=b[7];}out.push({t:g[0][0],o:g[0][1],h,l,c:g[g.length-1][4],v,qv,tbv});}return out;}

// === INDICATORS (10) ===
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const stoch=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{macd:li,signal:si,hist:hi};};
const atr=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};
// VWAP running (daily reset approx: use rolling 24 bars at 1H)
const vwap=(h,l,c,v,p=24)=>{const n=c.length,r=new Float64Array(n).fill(NaN);for(let i=p-1;i<n;i++){let tpv=0,tv=0;for(let j=i-p+1;j<=i;j++){const tp=(h[j]+l[j]+c[j])/3;tpv+=tp*v[j];tv+=v[j];}r[i]=tv>0?tpv/tv:c[i];}return r;};
// Keltner channel
const keltner=(h,l,c,p=20,mult=2)=>{const mid=em(c,p),a=atr(h,l,c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){up[i]=mid[i]+a[i]*mult;dn[i]=mid[i]-a[i]*mult;}return{mid,up,dn};};
// PSAR (simplified)
const psar=(h,l,c,step=0.02,maxStep=0.2)=>{const n=c.length,r=new Float64Array(n),trend=new Int8Array(n);if(n<3)return{r,trend};r[0]=l[0];trend[0]=1;let af=step,ep=h[0];for(let i=1;i<n;i++){const prev=r[i-1];if(trend[i-1]===1){r[i]=prev+af*(ep-prev);if(h[i]>ep){ep=h[i];af=Math.min(af+step,maxStep);}if(l[i]<r[i]){trend[i]=-1;r[i]=ep;ep=l[i];af=step;}else trend[i]=1;}else{r[i]=prev+af*(ep-prev);if(l[i]<ep){ep=l[i];af=Math.min(af+step,maxStep);}if(h[i]>r[i]){trend[i]=1;r[i]=ep;ep=h[i];af=step;}else trend[i]=-1;}}return{r,trend};};
// MFI (Money Flow Index)
const mfi=(h,l,c,v,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);if(n<p+1)return r;for(let i=p;i<n;i++){let pmf=0,nmf=0;for(let j=i-p+1;j<=i;j++){const tp=(h[j]+l[j]+c[j])/3,tpPrev=j>0?(h[j-1]+l[j-1]+c[j-1])/3:tp;if(tp>tpPrev)pmf+=tp*v[j];else if(tp<tpPrev)nmf+=tp*v[j];}r[i]=nmf===0?100:100-100/(1+pmf/nmf);}return r;};

// ADX for regime detection
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const a=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=a[i]?sp[i]/a[i]*100:0,ni=a[i]?sn[i]/a[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return em(dx,p);};

// RSI Divergence: looking back 5-15 bars, find bullish/bearish divergence
function detectDivergence(h,l,c,rsi,i,lbMin=5,lbMax=15){
  if(i<lbMax+1)return{bull:false,bear:false};
  let bull=false,bear=false;
  for(let lb=lbMin;lb<=lbMax;lb++){
    const j=i-lb;
    // Bullish: price LL + RSI HL (with RSI currently <40 to be meaningful)
    if(l[i]<l[j] && rsi[i]>rsi[j] && rsi[i]<45 && rsi[j]<35)bull=true;
    // Bearish: price HH + RSI LH (with RSI currently >60)
    if(h[i]>h[j] && rsi[i]<rsi[j] && rsi[i]>55 && rsi[j]>65)bear=true;
  }
  return{bull,bear};
}

// Generate 10-indicator score + divergence for 1H
function computeSignals(b1h){
  const n=b1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}
  const R14=rsI(c,14),R7=rsI(c,7),S=stoch(h,l,c,14),BBD=bb(c,20,2),MC=mcd(c);
  const E9=em(c,9),E21=em(c,21),E50=em(c,50);
  const VW=vwap(h,l,c,v,24);
  const VS=sm(v,20);
  const KC=keltner(h,l,c,20,2);
  const PSR=psar(h,l,c);
  const MF=mfi(h,l,c,v,14);
  const ATR=atr(h,l,c,14);const ADX=ax(h,l,c,14);
  // Score per bar
  const scores=new Int8Array(n);
  const divSig=new Int8Array(n);
  for(let i=30;i<n;i++){
    let s=0;
    // 1. RSI
    if(R14[i]<35)s++;if(R14[i]>65)s--;
    // 2. Stoch
    if(S[i]<20)s++;if(S[i]>80)s--;
    // 3. BB position
    if(c[i]<BBD.dn[i])s++;if(c[i]>BBD.up[i])s--;
    // 4. MACD
    if(MC.hist[i]>0)s++;if(MC.hist[i]<0)s--;
    // 5. EMA trend
    if(c[i]>E21[i]&&E21[i]>E50[i])s++;if(c[i]<E21[i]&&E21[i]<E50[i])s--;
    // 6. VWAP position
    if(c[i]>VW[i])s++;if(c[i]<VW[i])s--;
    // 7. Volume surge
    if(v[i]>VS[i]*1.5)s++;
    // 8. Keltner
    if(c[i]<KC.dn[i])s++;if(c[i]>KC.up[i])s--;
    // 9. PSAR
    if(PSR.trend[i]===1)s++;if(PSR.trend[i]===-1)s--;
    // 10. MFI
    if(MF[i]<25)s++;if(MF[i]>75)s--;
    scores[i]=s;
    // Divergence
    const div=detectDivergence(h,l,c,R14,i,5,15);
    divSig[i]=div.bull?1:(div.bear?-1:0);
  }
  return{scores,divSig,ADX,ATR,o,h,l,c,t,v,E21,E50,R14,BBD,MC};
}

// 4H and 15m trend
function computeTrendDir(bars){
  const n=bars.length;const c=Float64Array.from(bars.map(b=>b.c));
  const e9=em(c,9),e21=em(c,21);
  const r=new Int8Array(n);for(let i=0;i<n;i++){r[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}
  return r;
}

function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}

function st(trades){if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=trades.filter(x=>x.pnl>0),lo=trades.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of trades){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of trades){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe,mdd};}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP;const trades=[];const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=POS_SIZE*FEE_E+POS_SIZE*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});slots[si]=null;}
  function advance(upTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;const slPct=Math.max(0.003,Math.min(0.03,ap*cfg.slM));const tpPct=Math.max(0.005,Math.min(0.08,slPct*cfg.tpR));slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

async function main(){
  console.log('═'.repeat(80));console.log('APEX SCALP-PRO — 10-indicator scoring + divergence + MTF gate');console.log('TP 3×ATR / SL 1.2×ATR (ratio 2.5:1) · 16 pairs · OOS 274d');console.log('═'.repeat(80));
  const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);const b15m=aggTF(b1m,15);allData[pair]={b1h,b4h,b15m};}
  console.log('\n');

  const configs=[
    // RATIO 2.5:1 (TP 3.0 SL 1.2) — as user specified
    {name:'SP-score5-div-gate+15m',minScore:5,needDiv:true,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score4-div-gate+15m',minScore:4,needDiv:true,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score6-div-gate+15m',minScore:6,needDiv:true,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score5-nodiv-gate+15m',minScore:5,needDiv:false,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score4-nodiv-gate+15m',minScore:4,needDiv:false,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score3-nodiv-gate+15m',minScore:3,needDiv:false,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score3-noGate',minScore:3,needDiv:false,gate4h:false,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score4-only4H',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:3,adxF:22},
    {name:'SP-score3-only4H-mp5',minScore:3,needDiv:false,gate4h:true,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:5,adxF:22},
    {name:'SP-score4-only4H-mp5',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:5,adxF:22},
    // Alternative TP:SL ratios
    {name:'SP-s4-rr3.0',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.0,tpR:3.0,to:60,maxPos:5,adxF:22},
    {name:'SP-s4-rr2.0',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.5,tpR:2.0,to:48,maxPos:5,adxF:22},
    {name:'SP-s3-rr2.0-mp6',minScore:3,needDiv:false,gate4h:true,gate15m:false,slM:1.5,tpR:2.0,to:48,maxPos:6,adxF:22},
    // Div-only (no scoring)
    {name:'SP-div-only-gate',minScore:-99,needDiv:true,gate4h:true,gate15m:true,slM:1.2,tpR:2.5,to:48,maxPos:5,adxF:22},
    // Stricter ADX
    {name:'SP-s4-ADX25',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:5,adxF:25},
    {name:'SP-s4-ADX28',minScore:4,needDiv:false,gate4h:true,gate15m:false,slM:1.2,tpR:2.5,to:48,maxPos:5,adxF:28},
  ];

  const results=[];
  for(const cfg of configs){
    const allTrades=[];
    const signals=[];
    const parsed={};
    for(const pair of PAIRS){
      if(!allData[pair])continue;
      const b1h=allData[pair].b1h;
      const b4h=allData[pair].b4h;
      const b15m=allData[pair].b15m;
      const sc=computeSignals(b1h);
      parsed[pair]={t:sc.t,o:sc.o,h:sc.h,l:sc.l,c:sc.c,atr:sc.ATR};
      const trend4=computeTrendDir(b4h);
      const t4=b4h.map(b=>b.t);
      const trend15=computeTrendDir(b15m);
      const t15=b15m.map(b=>b.t);
      let last=-3;
      for(let i=50;i<sc.scores.length-cfg.to-1;i++){
        if(i-last<2)continue;
        if(sc.ADX[i]<cfg.adxF)continue;
        const score=sc.scores[i];const div=sc.divSig[i];
        let dir=0;
        if(cfg.minScore===-99){
          // Div only mode
          if(div===1)dir=1;else if(div===-1)dir=-1;
        }else{
          if(score>=cfg.minScore)dir=1;
          else if(score<=-cfg.minScore)dir=-1;
          if(cfg.needDiv){
            if(dir===1&&div!==1)dir=0;
            if(dir===-1&&div!==-1)dir=0;
          }
        }
        if(dir===0)continue;
        if(cfg.gate4h){const b4=findPrev(t4,sc.t[i]);if(b4<0||trend4[b4]!==dir)continue;}
        if(cfg.gate15m){const b15=findPrev(t15,sc.t[i]);if(b15<0||trend15[b15]!==dir)continue;}
        signals.push({bar:i,dir,ts:sc.t[i],pair,score});
        last=i;
      }
    }
    const r=engine(signals,parsed,P(SEED),cfg);
    const s=st(r.trades);
    const totalDays=274;
    const tpd=s.n/totalDays;
    const hit=s.pf>=1.6&&s.wr>=50&&tpd>=3;
    const hitLoose=s.pf>=1.5&&s.wr>=48;
    results.push({cfg,s,tpd,trades:r.trades,hit,hitLoose});
    const marker=hit?' ★★★':(hitLoose?' ★':'');
    console.log(`${cfg.name.padEnd(30)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(5)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2)} Sh${s.sharpe.toFixed(1).padStart(5)} DD$${s.mdd.toFixed(0).padStart(4)} $${s.pnl.toFixed(0).padStart(6)}${marker}`);
  }
  console.log('\n'+'═'.repeat(80));
  const winners=results.filter(r=>r.hit);
  const nearWins=results.filter(r=>r.hitLoose);
  if(winners.length){console.log(`★★★ TARGET (PF≥1.6, WR≥50%, 3+ t/d):`);winners.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} WR${r.s.wr.toFixed(1)}% ${r.tpd.toFixed(2)}t/d $${r.s.pnl.toFixed(0)} Sh${r.s.sharpe.toFixed(1)}`));}
  else if(nearWins.length){console.log(`★ NEAR (PF≥1.5, WR≥48%):`);nearWins.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} WR${r.s.wr.toFixed(1)}% ${r.tpd.toFixed(2)}t/d $${r.s.pnl.toFixed(0)} Sh${r.s.sharpe.toFixed(1)}`));}
  else console.log('✗ NO config hit targets');
  // Top 5 by PF
  console.log('\nTop 5 by PF (n>=80):');
  const top=results.filter(r=>r.s.n>=80).sort((a,b)=>b.s.pf-a.s.pf).slice(0,5);
  for(const r of top)console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} WR${r.s.wr.toFixed(1)}% ${r.tpd.toFixed(2)}t/d $${r.s.pnl.toFixed(0)}`);
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
