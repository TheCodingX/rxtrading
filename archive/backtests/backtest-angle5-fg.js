#!/usr/bin/env node
'use strict';
// ANGLE 5 — Fear & Greed + funding macro regime filter on Angle 4 best (Gate4H-P50)
// Layer 5 filters the direction sigs of the underlying engine:
//   EXTREME_FEAR (F&G<25) + funding<0 → LONG-only, size 1.5×
//   FEAR (25-45) → long:short 70:30 (block 30% of shorts randomly)
//   NEUTRAL (45-55) → balanced
//   GREED (55-75) → long:short 30:70 (block 70% of longs)
//   EXTREME_GREED (F&G>75) + funding>0.02% → SHORT-only, size 1.5×

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1',ETHUSDT:'L1',BNBUSDT:'L1',SOLUSDT:'L1alt',AVAXUSDT:'L1alt',NEARUSDT:'L1alt',APTUSDT:'L1alt',LTCUSDT:'POW',TRXUSDT:'L1other',XRPUSDT:'alt',ADAUSDT:'alt',DOTUSDT:'alt',ATOMUSDT:'alt',LINKUSDT:'defi',UNIUSDT:'defi',DOGEUSDT:'meme'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggToTF(b1m,minutes){const out=[];const stepMs=minutes*60000;let start=0;while(start<b1m.length&&(b1m[start][0]%stepMs)!==0)start++;for(let i=start;i<b1m.length;i+=minutes){const g=b1m.slice(i,i+minutes);if(g.length<minutes)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const tsv=v-tbv;const ti=v>0?(tbv-tsv)/v:0;out.push({t:g[0][0],o:g[0][1],h,l,c:g[g.length-1][4],v,tbv,tsv,ti});}return out;}
function loadMetrics(p){const d=path.join(METRICS_DIR,p);if(!fs.existsSync(d))return[];const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')&&f.startsWith(`${p}-metrics-`));const out=[];for(const f of fl){let ct;try{ct=fs.readFileSync(path.join(d,f),'utf8');}catch(e){continue;}const ln=ct.split('\n');for(let i=1;i<ln.length;i++){const l=ln[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<8)continue;const ts=new Date(p2[0].replace(' ','T')+'Z').getTime();out.push({t:ts,oi:parseFloat(p2[2])||0,topPos:parseFloat(p2[5])||1,lsAcct:parseFloat(p2[6])||1,taker:parseFloat(p2[7])||1});}}out.sort((a,b)=>a.t-b.t);return out;}

async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}

function loadFNG(){const raw=JSON.parse(fs.readFileSync('/tmp/fng.json','utf8'));return raw.data.map(d=>({t:+d.timestamp*1000,value:+d.value,cls:d.value_classification})).sort((a,b)=>a.t-b.t);}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

function build1H_Momentum(bars1h){const n=bars1h.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=bars1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}

function compute4HTrend(bars4h){const n=bars4h.length;const c=Float64Array.from(bars4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}

// Regime classifier based on F&G + avg funding
// Returns: 'xfear', 'fear', 'neutral', 'greed', 'xgreed'
function classifyRegime(fngVal,avgFunding){
  if(fngVal<25&&avgFunding<0)return 'xfear';
  if(fngVal<45)return 'fear';
  if(fngVal<55)return 'neutral';
  if(fngVal<75)return 'greed';
  if(avgFunding>0.0002)return 'xgreed';
  return 'greed';
}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=pos.sz*FEE_E+pos.sz*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz,regime:pos.regime});slots[si]=null;}
  function advance(upTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;const clCnt={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clCnt[CLUSTERS[slots[si].pair]]=(clCnt[CLUSTERS[slots[si].pair]]||0)+1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;const cl=CLUSTERS[sig.pair]||'o';if((clCnt[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));const sizeMult=(cfg.dynSize?Math.max(0.5,Math.min(2.0,sig.conf)):1.0)*(sig.regimeMult||1.0);const sz=POS_SIZE*sizeMult;slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:sz/ep,eb,exp:eb+cfg.to,nc:eb+1,sz,regime:sig.regime};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

async function main(){
  console.log('═'.repeat(80));console.log('ANGLE 5 — F&G + FUNDING MACRO REGIME FILTER (on top of Gate4H)');console.log('═'.repeat(80));
  const fng=loadFNG();
  console.log(`F&G history: ${fng.length} days (${new Date(fng[0].t).toISOString().slice(0,10)} → ${new Date(fng[fng.length-1].t).toISOString().slice(0,10)})`);
  const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}const b1h=aggToTF(b1m,60);const b4h=aggToTF(b1m,240);const metrics=loadMetrics(pair);const fTs=b1h[0].t,lTs=b1h[b1h.length-1].t;const fr=await gF(pair,fTs,lTs);allData[pair]={b1h,b4h,metrics,fr};}
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const totalDays=274;const TRAIN_D=120,TEST_D=30,STEP_D=30;const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;

  // Compute avg funding across pairs at each time (macro)
  // Simpler: use BTC funding as proxy for macro
  const btcFr=allData['BTCUSDT'].fr.map(f=>({t:+f.fundingTime,rate:parseFloat(f.fundingRate)})).sort((a,b)=>a.t-b.t);
  const btcFrt=btcFr.map(x=>x.t),btcFrr=btcFr.map(x=>x.rate);
  function getFunding(ts){const b=findPrev(btcFrt,ts);return b>=0?btcFrr[b]:0;}
  const fngT=fng.map(x=>x.t),fngV=fng.map(x=>x.value);
  function getFNG(ts){const b=findPrev(fngT,ts);return b>=0?fngV[b]:50;}

  // Regime stats over test period
  const regimeStats={xfear:0,fear:0,neutral:0,greed:0,xgreed:0};
  // Run: Gate4H + Regime filter
  const variants=[
    {name:'Gate4H-P50-NoReg',thrP:50,mc:0.011,adxF:22,maxPos:5,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:false},
    {name:'Gate4H-P50-Reg-soft',thrP:50,mc:0.011,adxF:22,maxPos:5,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:true,regimeMode:'soft'},
    {name:'Gate4H-P50-Reg-hard',thrP:50,mc:0.011,adxF:22,maxPos:5,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:true,regimeMode:'hard'},
    {name:'Gate4H-P45-Reg-hard',thrP:45,mc:0.011,adxF:22,maxPos:6,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:true,regimeMode:'hard'},
    {name:'Gate4H-P40-Reg-hard',thrP:40,mc:0.011,adxF:22,maxPos:6,maxCluster:5,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:true,regimeMode:'hard'},
    {name:'Gate4H-P35-Reg-hard',thrP:35,mc:0.011,adxF:22,maxPos:6,maxCluster:5,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:true,useRegime:true,regimeMode:'hard'},
    // Regime only (no 4H gate)
    {name:'NoGate-P50-Reg-hard',thrP:50,mc:0.011,adxF:22,maxPos:5,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:false,useRegime:true,regimeMode:'hard'},
    {name:'NoGate-P45-Reg-hard',thrP:45,mc:0.011,adxF:22,maxPos:6,maxCluster:4,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:false,useRegime:true,regimeMode:'hard'},
    {name:'NoGate-P40-Reg-hard',thrP:40,mc:0.011,adxF:22,maxPos:6,maxCluster:5,slM:2,tpR:3,to:84,fwd:2,dynSize:true,gate4h:false,useRegime:true,regimeMode:'hard'},
  ];

  const results=[];
  for(const cfg of variants){
    const allOOS=[];
    for(let w=0;w<nW;w++){
      const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      const pm={};
      for(const pair of PAIRS){
        if(!allData[pair])continue;
        const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;
        const F=build1H_Momentum(tB);
        const fwd=new Float64Array(F.n).fill(NaN);for(let i=50;i<F.n-cfg.fwd;i++)fwd[i]=(F.c[i+cfg.fwd]-F.c[i])/F.c[i]*100;
        const co=pearson(F.fs,fwd,50,F.n-cfg.fwd);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
        if(sel.length<2)continue;
        let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
        pm[pair]={sel,thr};
      }
      if(Object.keys(pm).length<4)continue;
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        if(!pm[pair]||!allData[pair])continue;
        const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;
        const te4h=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);
        const F=build1H_Momentum(teB);
        tPar[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
        const{sel,thr}=pm[pair];
        const trend4h=compute4HTrend(te4h);const t4h=te4h.map(b=>b.t);
        let last=-3;
        const rngReg=P(SEED+w+100);
        for(let i=55;i<F.n-cfg.to-1;i++){
          if(i-last<2)continue;if(F.adx[i]<cfg.adxF)continue;
          let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
          const ac=Math.abs(comp);if(ac<thr)continue;
          const dir=comp>0?1:-1;
          if(cfg.gate4h){const b4=findPrev(t4h,F.t[i]);if(b4<0||trend4h[b4]!==dir)continue;}
          let regimeMult=1.0,regimeLabel='n/a';
          if(cfg.useRegime){
            const fngV=getFNG(F.t[i]),fundV=getFunding(F.t[i]);
            regimeLabel=classifyRegime(fngV,fundV);
            if(pair==='BTCUSDT'&&i%100===0)regimeStats[regimeLabel]++;
            if(cfg.regimeMode==='hard'){
              // Hard filter: skip opposite direction in extreme regimes
              if(regimeLabel==='xfear'&&dir===-1)continue;
              if(regimeLabel==='xgreed'&&dir===1)continue;
              // Regular fear/greed bias
              if(regimeLabel==='fear'&&dir===-1&&rngReg()<0.3)continue;
              if(regimeLabel==='greed'&&dir===1&&rngReg()<0.7)continue;
              if(regimeLabel==='xfear'||regimeLabel==='xgreed')regimeMult=1.5;
            }else if(cfg.regimeMode==='soft'){
              // Soft: just adjust sizing
              if(regimeLabel==='xfear'&&dir===1)regimeMult=1.5;
              if(regimeLabel==='xgreed'&&dir===-1)regimeMult=1.5;
              if(regimeLabel==='fear'&&dir===1)regimeMult=1.2;
              if(regimeLabel==='greed'&&dir===-1)regimeMult=1.2;
            }
          }
          const conf=Math.max(0.5,Math.min(2.0,ac/thr));
          sigs.push({bar:i,dir,ts:F.t[i],pair,conf,regimeMult,regime:regimeLabel});last=i;
        }
      }
      allOOS.push(...engine(sigs,tPar,P(SEED+w),cfg).trades);
    }
    const s=st(allOOS);const tpd=s.n/(nW*TEST_D);
    results.push({cfg,s,tpd,trades:allOOS});
    console.log(`${cfg.name.padEnd(22)} ${s.n}t ${tpd.toFixed(2).padStart(4)}t/d PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1).padStart(4)}% Sh${s.sharpe.toFixed(1).padStart(4)} DD$${s.mdd.toFixed(0).padStart(4)} $${s.pnl.toFixed(0).padStart(5)}`);
  }
  console.log('\nTop 5 by PF (tpd>=2):');
  const sorted=results.filter(r=>r.tpd>=2).sort((a,b)=>b.s.pf-a.s.pf);
  for(const r of sorted.slice(0,5))console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d WR${r.s.wr.toFixed(1)}% Sh${r.s.sharpe.toFixed(1)}`);
  const tier3=results.filter(r=>r.s.pf>=1.45&&r.tpd>=3.0&&r.s.wr>=40);
  const tier2=results.filter(r=>r.s.pf>=1.55&&r.tpd>=3.0&&r.s.wr>=42);
  const tier1=results.filter(r=>r.s.pf>=1.65&&r.tpd>=3.0&&r.s.wr>=45);
  console.log('\n'+'═'.repeat(80));
  if(tier1.length){console.log('★★★ TIER 1 MET:');tier1.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d WR${r.s.wr.toFixed(1)}%`));}
  else if(tier2.length){console.log('★★ TIER 2 MET:');tier2.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d WR${r.s.wr.toFixed(1)}%`));}
  else if(tier3.length){console.log('★ TIER 3 MET:');tier3.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d WR${r.s.wr.toFixed(1)}%`));}
  else console.log('✗ No tier met');
  const best=sorted[0]||results[0];
  if(best)fs.writeFileSync('/tmp/angle5-trades.json',JSON.stringify(best.trades));
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
