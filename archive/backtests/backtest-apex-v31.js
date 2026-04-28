#!/usr/bin/env node
'use strict';
// APEX V31 — V16 ARCHITECTURE + REAL HISTORICAL INSTITUTIONAL DATA
// Data source: Binance Data Vision bulk archives (data.binance.vision/data/futures/um/daily/metrics)
// 300 days × 8 pairs of 5-minute resolution:
//   - sum_open_interest (OI in base asset)
//   - sum_open_interest_value (OI in USD)
//   - count_toptrader_long_short_ratio (top trader L/S accounts)
//   - sum_toptrader_long_short_ratio (top trader L/S positions)
//   - count_long_short_ratio (general L/S accounts)
//   - sum_taker_long_short_vol_ratio (taker buy/sell volume)
// NEW FEATURES added to V16's base (25): 10 institutional features → 35 total
// Hypothesis: REAL institutional flow data provides orthogonal alpha to OHLCV/Funding/Basis
const https=require('https');
const fs=require('fs');
const path=require('path');
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300,TRAIN_D=120,TEST_D=30,STEP_D=30;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const METRICS_DIR='/tmp/binance-metrics';
function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function gK(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}

// Load metrics CSVs for a pair, return sorted array of {t,oi,oiv,topAcct,topPos,lsAcct,taker}
function loadMetrics(pair,startTs,endTs){
  const dir=path.join(METRICS_DIR,pair);
  if(!fs.existsSync(dir))return[];
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')&&f.startsWith(`${pair}-metrics-`));
  const out=[];
  for(const f of files){
    const ds=f.match(/metrics-(\d{4}-\d{2}-\d{2})/);if(!ds)continue;
    const dayTs=new Date(ds[1]+'T00:00:00Z').getTime();
    if(dayTs<startTs-86400000||dayTs>endTs+86400000)continue;
    let content;try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch(e){continue;}
    const lines=content.split('\n');
    for(let i=1;i<lines.length;i++){
      const l=lines[i].trim();if(!l)continue;
      const p=l.split(',');if(p.length<8)continue;
      const ts=new Date(p[0].replace(' ','T')+'Z').getTime();
      if(ts<startTs||ts>endTs+86400000)continue;
      out.push({
        t:ts,
        oi:parseFloat(p[2])||0,
        oiv:parseFloat(p[3])||0,
        topAcct:parseFloat(p[4])||1,
        topPos:parseFloat(p[5])||1,
        lsAcct:parseFloat(p[6])||1,
        taker:parseFloat(p[7])||1
      });
    }
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}

function pa(k){const n=k.length,o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){t[i]=+k[i][0];o[i]=+k[i][1];h[i]=+k[i][2];l[i]=+k[i][3];c[i]=+k[i][4];v[i]=+k[i][5];}return{o,h,l,c,v,t,n};}
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bo=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const sk=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// V16 features (25) + 10 NEW institutional features = 35 total
function comp(d,fr,piKl,metrics){
  const{o,h,l,c,v,t,n}=d;const atr2=at(h,l,c),adx2=ax(h,l,c),mc2=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),vs=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  // Metrics lookup with binary search
  const mT=metrics.map(m=>m.t);
  function gM(bt,lookbackBars){let lo=0,hi=metrics.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b<0?null:{cur:metrics[b],prev:(b-lookbackBars>=0?metrics[b-lookbackBars]:null)};}
  // 12 bars of 5-min = 1h, 72 = 6h, 288 = 24h
  const fs=[],nm=[];const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)||!isFinite(v2)?0:v2;}fs.push(a);nm.push(name);};
  // === V16 baseline features (25) ===
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);
  F('StochK',i=>isNaN(stk[i])?0:(50-stk[i])/50);
  F('MACDh',i=>mc2.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc2.hist[i]-mc2.hist[i-1])/(atr2[i]||1):0);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vs[i]>0?(v[i]/vs[i]-1):0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('FRc3',i=>-gfrc(t[i],3)*1000);F('FRc6',i=>-gfrc(t[i],6)*1000);
  F('Basis',i=>-gB(t[i])*10000);F('BasisZ',i=>-gBz(t[i]));F('BasisSlp',i=>i>=6?-(gB(t[i])-gB(t[i-6]))*10000:0);
  F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('HLrange',i=>(h[i]-l[i])/(atr2[i]||1));F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);
  // === NEW INSTITUTIONAL FEATURES (10) ===
  F('OIchg1h',i=>{const m=gM(t[i],12);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIchg6h',i=>{const m=gM(t[i],72);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIchg24h',i=>{const m=gM(t[i],288);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIvsPrice',i=>{const m=gM(t[i],72);if(!m||!m.prev||m.prev.oi===0)return 0;const oiC=(m.cur.oi-m.prev.oi)/m.prev.oi*100;const pC=i>=6?(c[i]-c[i-6])/c[i-6]*100:0;return oiC-pC;}); // OI rising but price flat = accumulation
  F('TopPosLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topPos<=0)return 0;return(1/m.cur.topPos-1);}); // smart money L/S (positions) — extreme long = fade
  F('TopPosSlp',i=>{const m=gM(t[i],72);if(!m||!m.prev)return 0;return-(m.cur.topPos-m.prev.topPos)*5;}); // smart money shifting
  F('TopActLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topAcct<=0)return 0;return(1/m.cur.topAcct-1);}); // smart money L/S (accounts)
  F('LSAcct',i=>{const m=gM(t[i],0);if(!m||m.cur.lsAcct<=0)return 0;return(1/m.cur.lsAcct-1);}); // general retail L/S — extreme = fade
  F('TakerR',i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);}); // aggressive buy/sell flow
  F('TakerSlp',i=>{const m=gM(t[i],12);if(!m||!m.prev||m.prev.taker<=0||m.cur.taker<=0)return 0;return Math.log(m.cur.taker/m.prev.taker);}); // flow acceleration
  return{fs,nm,n,adx:adx2.adx};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];let pos=null;
  function cls(j){const pd=parsed[pos.pair];let ep2;if(pos.exit==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(pos.exit==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(pos.exit==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:pos.exit,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});pos=null;}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.n)continue;
    if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp&&pd.t[j]<=d.t[eb];j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){pos.exit='SL';cls(j);break;}if(hT){pos.exit='TP';cls(j);break;}pos.nc=j+1;}if(pos&&pos.nc>pos.exp){pos.exit='TO';cls(Math.min(pos.exp,parsed[pos.pair].n-1));}}
    if(pos)continue;if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=d.o[eb],atrA=at(d.h,d.l,d.c),ap=atrA[sig.bar]/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;
    let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));
    pos={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1,exit:null};
  }
  if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){pos.exit='SL';cls(j);break;}if(hT){pos.exit='TP';cls(j);break;}pos.nc=j+1;}if(pos){pos.exit='TO';cls(Math.min(pos.exp,pd.n-1));}}
  return{trades,cap,mdd};
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

async function main(){
  console.log('═'.repeat(80));
  console.log('APEX V31 — REAL HISTORICAL INSTITUTIONAL DATA (Binance Data Vision)');
  console.log('35 features = 25 V16 baseline + 10 NEW (OI/TopTrader/L-S/Taker)');
  console.log('Goal: unlock PF>=1.7 AND 2+ trades/day');
  console.log('═'.repeat(80));
  const startTs=END_TS-DAYS*864e5;const allData={};
  console.log('\nDownloading OHLCV + FR + PI from API + loading metrics CSVs from disk...');
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const kl=await gK(pair,'1h',startTs,END_TS);
    const fr=await gF(pair,startTs,END_TS);
    const pi=await gPI(pair,'1h',startTs,END_TS);
    const metrics=loadMetrics(pair,startTs,END_TS);
    allData[pair]={kl,fr,pi,metrics};
    process.stdout.write(`(k:${kl.length} m:${metrics.length}) `);
  }
  console.log('\n');
  const nW=Math.floor((DAYS-TRAIN_D-TEST_D)/STEP_D)+1;

  const cfgs=[
    {name:'V16-real',fwd:2,thrP:68,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P68',fwd:2,thrP:68,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P65',fwd:2,thrP:65,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P60',fwd:2,thrP:60,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P55',fwd:2,thrP:55,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P50',fwd:2,thrP:50,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P45',fwd:2,thrP:45,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P40',fwd:2,thrP:40,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P35',fwd:2,thrP:35,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P30',fwd:2,thrP:30,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P50-MC15',fwd:2,thrP:50,slM:2,tpR:3,mc:0.015,adxF:22,to:84},
    {name:'V31-P45-MC15',fwd:2,thrP:45,slM:2,tpR:3,mc:0.015,adxF:22,to:84},
    {name:'V31-P40-MC15',fwd:2,thrP:40,slM:2,tpR:3,mc:0.015,adxF:22,to:84},
    {name:'V31-P50-ADX25',fwd:2,thrP:50,slM:2,tpR:3,mc:0.011,adxF:25,to:84},
    {name:'V31-P45-ADX25',fwd:2,thrP:45,slM:2,tpR:3,mc:0.011,adxF:25,to:84},
    {name:'V31-P40-TO60',fwd:2,thrP:40,slM:2,tpR:3,mc:0.011,adxF:22,to:60},
    {name:'V31-P45-F1',fwd:1,thrP:45,slM:2,tpR:3,mc:0.011,adxF:22,to:84},
    {name:'V31-P45-F3',fwd:3,thrP:45,slM:2,tpR:3,mc:0.011,adxF:22,to:84}
  ];

  const results=[];
  for(const cfg of cfgs){
    // For V16-base, we ONLY use V16 features (first 25 from comp())
    const useOnlyBase=cfg.name==='V16-base'||cfg.name==='V16-real';
    const allOOS=[];
    for(let w=0;w<nW;w++){
      const trs=startTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;if(tee>END_TS)break;
      const pm={};
      for(const pair of PAIRS){
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);if(tkl.length<200)continue;
        const d=pa(tkl);
        // filter metrics to training window + some lookback
        const tMetrics=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
        const{fs,adx:adxArr}=comp(d,allData[pair].fr,allData[pair].pi,tMetrics);
        const featsToUse=useOnlyBase?fs.slice(0,25):fs;
        const fwd=new Float64Array(d.n).fill(NaN);for(let i=50;i<d.n-cfg.fwd;i++)fwd[i]=(d.c[i+cfg.fwd]-d.c[i])/d.c[i]*100;
        const co=pearson(featsToUse,fwd,50,d.n-cfg.fwd);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,12);
        if(sel.length<2)continue;
        let tc=[];for(let i=55;i<d.n;i++){if(adxArr[i]<cfg.adxF)continue;let comp2=0;for(const{idx,corr}of sel)comp2+=corr*featsToUse[idx][i];tc.push(Math.abs(comp2));}
        tc.sort((a,b)=>a-b);pm[pair]={sel,thr:tc[Math.floor(tc.length*cfg.thrP/100)]||0.001,useOnlyBase};
      }
      if(Object.keys(pm).length<5)continue;
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);if(tkl.length<50||!pm[pair])continue;
        const d=pa(tkl);tPar[pair]=d;
        const tMetrics=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
        const{fs,adx:adxArr}=comp(d,allData[pair].fr,allData[pair].pi,tMetrics);
        const featsToUse=useOnlyBase?fs.slice(0,25):fs;
        const{sel,thr}=pm[pair];
        let last=-3;
        for(let i=55;i<d.n-cfg.to-1;i++){if(i-last<3)continue;if(adxArr[i]<cfg.adxF)continue;let comp2=0;for(const{idx,corr}of sel)comp2+=corr*featsToUse[idx][i];if(Math.abs(comp2)<thr)continue;sigs.push({bar:i,dir:comp2>0?1:-1,ts:d.t[i],pair});last=i;}
      }
      allOOS.push(...engine(sigs,tPar,P(SEED+w),cfg).trades);
    }
    if(!allOOS.length){results.push({cfg,s:{n:0,pf:0,wr:0,pnl:0},tpd:0});continue;}
    const s=st(allOOS);const tpd=s.n/(nW*TEST_D);
    const pairsStat={};for(const t of allOOS){if(!pairsStat[t.pair])pairsStat[t.pair]=[];pairsStat[t.pair].push(t);}
    let pp=0;for(const p of Object.keys(pairsStat)){const s2=st(pairsStat[p]);if(s2.pnl>0)pp++;}
    const mos={};for(const t of allOOS){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    let pm2=0;for(const m of Object.keys(mos)){const s2=st(mos[m]);if(s2.pnl>0)pm2++;}
    results.push({cfg,s,tpd,pp,pm:pm2,np:Object.keys(pairsStat).length,nm:Object.keys(mos).length,trades:allOOS});
    console.log(`${cfg.name.padEnd(14)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(4)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2).padStart(5)} $${s.pnl.toFixed(0).padStart(6)} P${pp}/${Object.keys(pairsStat).length} M${pm2}/${Object.keys(mos).length}`);
  }
  console.log('\n'+'═'.repeat(80));
  console.log('ANALYSIS:');console.log('═'.repeat(80));
  const valid=results.filter(r=>r.s.n>=80);
  const viable=valid.filter(r=>r.tpd>=1.8&&r.s.pf>=1.7);
  const viable2=valid.filter(r=>r.tpd>=2.0&&r.s.pf>=1.5);
  const best2pd=[...valid.filter(r=>r.tpd>=2.0)].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const bestPF=[...valid].sort((a,b)=>b.s.pf-a.s.pf)[0];
  if(bestPF)console.log(`Highest PF:     ${bestPF.cfg.name.padEnd(14)} PF${bestPF.s.pf.toFixed(2)} @ ${bestPF.tpd.toFixed(2)} t/d (${bestPF.s.n}t $${bestPF.s.pnl.toFixed(0)})`);
  if(best2pd)console.log(`Best @ 2+ t/d:  ${best2pd.cfg.name.padEnd(14)} PF${best2pd.s.pf.toFixed(2)} @ ${best2pd.tpd.toFixed(2)} t/d (${best2pd.s.n}t $${best2pd.s.pnl.toFixed(0)})`);
  if(viable.length){
    console.log(`\n★★★ ${viable.length} configs achieve 2+ t/d AND PF>=1.7 (TARGET MET!):`);
    for(const r of viable)console.log(`  ${r.cfg.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d ($${r.s.pnl.toFixed(0)}) pairs ${r.pp}/${r.np} months ${r.pm}/${r.nm}`);
  }
  if(viable2.length){
    console.log(`\n${viable2.length} configs achieve 2+ t/d AND PF>=1.5:`);
    for(const r of viable2)console.log(`  ${r.cfg.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d ($${r.s.pnl.toFixed(0)}) pairs ${r.pp}/${r.np} months ${r.pm}/${r.nm}`);
  }
  if(!viable.length&&!viable2.length)console.log('\n✗ No config hit target');
  if(best2pd&&best2pd.s.pf>=1.5){
    console.log('\n'+'═'.repeat(80));
    console.log(`BEST 2+ T/D: ${best2pd.cfg.name}`);
    console.log('═'.repeat(80));
    const tr=best2pd.trades;
    const mos={};for(const t of tr){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    console.log('Monthly:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
    const pairsR={};for(const t of tr){if(!pairsR[t.pair])pairsR[t.pair]=[];pairsR[t.pair].push(t);}
    console.log('\nPer Pair:');for(const p of Object.keys(pairsR).sort()){const s2=st(pairsR[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  }
  console.log('\n'+'═'.repeat(80)+'\n');
}
main().catch(e=>{console.error('FATAL:',e.message,e.stack);process.exit(1);});
