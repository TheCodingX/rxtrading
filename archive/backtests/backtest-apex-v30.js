#!/usr/bin/env node
'use strict';
// APEX V30 — MULTI-TIMEFRAME CONFLUENCE (new architecture V16 never used)
// Concept: same V16 feature set computed on 3 timeframes, trade only when all align
// 1H = primary signal (quality)
// 4H = trend context (filter out counter-trend setups)
// 15m = entry timing (catches early, reduces slippage)
// This should let us LOWER the primary threshold (more signals) without losing PF
// because false positives are filtered by the 4H trend + 15m timing layers.
const https=require('https');
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300,TRAIN_D=120,TEST_D=30,STEP_D=30;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function gK(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}
function pa(k){const n=k.length,o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){t[i]=+k[i][0];o[i]=+k[i][1];h[i]=+k[i][2];l[i]=+k[i][3];c[i]=+k[i][4];v[i]=+k[i][5];}return{o,h,l,c,v,t,n};}
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bo=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const sk=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// Same V16 feature set — now called on any timeframe
function comp(d,fr,piKl){
  const{o,h,l,c,v,t,n}=d;const atr2=at(h,l,c),adx2=ax(h,l,c),mc2=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),vs=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const fs=[],nm=[];const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)||!isFinite(v2)?0:v2;}fs.push(a);nm.push(name);};
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
  return{fs,nm,n,adx:adx2.adx};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// MTF composite: trade on 1H when direction agrees with 4H AND 15m
// Build per-bar composite on each TF, then align 15m→1H and 4H→1H (look-back only, no look-ahead)
function buildComposites(d1h,d4h,d15m,fr,pi,cfg){
  const c1=comp(d1h,fr,pi),c4=comp(d4h,fr,pi),c15=comp(d15m,fr,pi);
  // Compute fwd returns per timeframe
  const fwd1=new Float64Array(d1h.n).fill(NaN);for(let i=50;i<d1h.n-cfg.fwd;i++)fwd1[i]=(d1h.c[i+cfg.fwd]-d1h.c[i])/d1h.c[i]*100;
  const fwd4=new Float64Array(d4h.n).fill(NaN);for(let i=50;i<d4h.n-1;i++)fwd4[i]=(d4h.c[i+1]-d4h.c[i])/d4h.c[i]*100;
  const fwd15=new Float64Array(d15m.n).fill(NaN);for(let i=50;i<d15m.n-2;i++)fwd15[i]=(d15m.c[i+2]-d15m.c[i])/d15m.c[i]*100;
  return{c1,c4,c15,fwd1,fwd4,fwd15};
}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];let pos=null;
  function cls(j){const pd=parsed[pos.pair];let ep2;if(pos.exit==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(pos.exit==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(pos.exit==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:pos.exit,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});pos=null;}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.n)continue;
    if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp&&pd.t[j]<=d.t[eb];j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){pos.exit='SL';cls(j);break;}if(hT){pos.exit='TP';cls(j);break;}pos.nc=j+1;}if(pos&&pos.nc>pos.exp){pos.exit='TO';cls(Math.min(pos.exp,pd.n-1));}}
    if(pos)continue;if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=d.o[eb],atrA=at(d.h,d.l,d.c),ap=atrA[sig.bar]/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;
    let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));
    pos={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1,exit:null};
  }
  if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){pos.exit='SL';cls(j);break;}if(hT){pos.exit='TP';cls(j);break;}pos.nc=j+1;}if(pos){pos.exit='TO';cls(Math.min(pos.exp,pd.n-1));}}
  return{trades,cap,mdd};
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

// bisect: find the 4H or 15m bar whose closeTime is <= given ts
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}

async function main(){
  console.log('═'.repeat(78));
  console.log('APEX V30 — MULTI-TIMEFRAME CONFLUENCE (1H + 4H + 15m)');
  console.log('Hypothesis: MTF alignment filters false positives → lower threshold safely');
  console.log('═'.repeat(78));
  const startTs=END_TS-DAYS*864e5;const allData={};
  console.log('\nDownloading 1H + 4H + 15m + FR + PI for 8 pairs...');
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const k1=await gK(pair,'1h',startTs,END_TS);
    const k4=await gK(pair,'4h',startTs,END_TS);
    const k15=await gK(pair,'15m',startTs,END_TS);
    const fr=await gF(pair,startTs,END_TS);
    const pi=await gPI(pair,'1h',startTs,END_TS);
    allData[pair]={k1,k4,k15,fr,pi};
    process.stdout.write(`(1h:${k1.length} 4h:${k4.length} 15m:${k15.length}) `);
  }
  console.log('\n');
  const nW=Math.floor((DAYS-TRAIN_D-TEST_D)/STEP_D)+1;

  const cfgs=[
    {name:'V16-baseline',mode:'1h',fwd:2,thrP:65,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'none'},
    // MTF with 4H trend filter ONLY
    {name:'MTF-4H-P60',mode:'mtf',fwd:2,thrP:60,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'4h'},
    {name:'MTF-4H-P55',mode:'mtf',fwd:2,thrP:55,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'4h'},
    {name:'MTF-4H-P50',mode:'mtf',fwd:2,thrP:50,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'4h'},
    {name:'MTF-4H-P45',mode:'mtf',fwd:2,thrP:45,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'4h'},
    {name:'MTF-4H-P40',mode:'mtf',fwd:2,thrP:40,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'4h'},
    // MTF with 15m timing filter ONLY
    {name:'MTF-15-P55',mode:'mtf',fwd:2,thrP:55,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'15m'},
    {name:'MTF-15-P50',mode:'mtf',fwd:2,thrP:50,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'15m'},
    // MTF with BOTH 4H + 15m (triple confluence)
    {name:'MTF-ALL-P55',mode:'mtf',fwd:2,thrP:55,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    {name:'MTF-ALL-P50',mode:'mtf',fwd:2,thrP:50,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    {name:'MTF-ALL-P45',mode:'mtf',fwd:2,thrP:45,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    {name:'MTF-ALL-P40',mode:'mtf',fwd:2,thrP:40,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    {name:'MTF-ALL-P35',mode:'mtf',fwd:2,thrP:35,slM:2.5,tpR:1.2,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    // MTF-ALL with tighter SL (more trades fit)
    {name:'MTF-ALL-P45T',mode:'mtf',fwd:2,thrP:45,slM:2.0,tpR:1.5,mc:0.05,adxF:25,to:60,mtfMode:'all'},
    {name:'MTF-ALL-P40T',mode:'mtf',fwd:2,thrP:40,slM:2.0,tpR:1.5,mc:0.05,adxF:25,to:60,mtfMode:'all'},
  ];
  const results=[];
  for(const cfg of cfgs){
    const allOOS=[];
    for(let w=0;w<nW;w++){
      const trs=startTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;if(tee>END_TS)break;
      const pm={};
      // TRAIN: per-pair, per-TF feature selection
      for(const pair of PAIRS){
        const tkl1=allData[pair].k1.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
        const tkl4=allData[pair].k4.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
        const tkl15=allData[pair].k15.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
        if(tkl1.length<200||tkl4.length<50||tkl15.length<500)continue;
        const d1=pa(tkl1),d4=pa(tkl4),d15=pa(tkl15);
        const{c1,c4,c15,fwd1,fwd4,fwd15}=buildComposites(d1,d4,d15,allData[pair].fr,allData[pair].pi,cfg);
        const co1=pearson(c1.fs,fwd1,50,d1.n-cfg.fwd);
        const sel1=co1.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,10);
        if(sel1.length<3)continue;
        let tc=[];for(let i=55;i<d1.n;i++){if(c1.adx[i]<cfg.adxF)continue;let comp2=0;for(const{idx,corr}of sel1)comp2+=corr*c1.fs[idx][i];tc.push(Math.abs(comp2));}
        tc.sort((a,b)=>a-b);
        const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
        // For MTF: also select top features on 4H and 15m (only for direction, not threshold)
        let sel4=null,sel15=null;
        if(cfg.mtfMode==='4h'||cfg.mtfMode==='all'){
          const co4=pearson(c4.fs,fwd4,50,d4.n-1);
          sel4=co4.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc*0.7).sort((a,b)=>b.abs-a.abs).slice(0,6);
        }
        if(cfg.mtfMode==='15m'||cfg.mtfMode==='all'){
          const co15=pearson(c15.fs,fwd15,50,d15.n-2);
          sel15=co15.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc*0.5).sort((a,b)=>b.abs-a.abs).slice(0,6);
        }
        pm[pair]={sel1,sel4,sel15,thr};
      }
      if(Object.keys(pm).length<5)continue;
      // TEST
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        if(!pm[pair])continue;
        const tkl1=allData[pair].k1.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);
        const tkl4=allData[pair].k4.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);
        const tkl15=allData[pair].k15.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);
        if(tkl1.length<50)continue;
        const d1=pa(tkl1),d4=tkl4.length?pa(tkl4):null,d15=tkl15.length?pa(tkl15):null;
        tPar[pair]=d1;
        const c1=comp(d1,allData[pair].fr,allData[pair].pi);
        const c4=d4?comp(d4,allData[pair].fr,allData[pair].pi):null;
        const c15=d15?comp(d15,allData[pair].fr,allData[pair].pi):null;
        const{sel1,sel4,sel15,thr}=pm[pair];
        let last=-3;
        for(let i=55;i<d1.n-cfg.to-1;i++){
          if(i-last<3)continue;if(c1.adx[i]<cfg.adxF)continue;
          let comp1=0;for(const{idx,corr}of sel1)comp1+=corr*c1.fs[idx][i];
          if(Math.abs(comp1)<thr)continue;
          const dir1=comp1>0?1:-1;
          // MTF checks
          if((cfg.mtfMode==='4h'||cfg.mtfMode==='all')&&sel4&&c4){
            const b4=findPrev(c4.fs.length?Array.from({length:c4.n},(_,j)=>d4.t[j]):[],d1.t[i]);
            if(b4<50){continue;}
            let comp4=0;for(const{idx,corr}of sel4)comp4+=corr*c4.fs[idx][b4];
            if(Math.sign(comp4)!==dir1)continue; // 4H must agree
          }
          if((cfg.mtfMode==='15m'||cfg.mtfMode==='all')&&sel15&&c15){
            const b15=findPrev(Array.from({length:c15.n},(_,j)=>d15.t[j]),d1.t[i]);
            if(b15<50){continue;}
            let comp15=0;for(const{idx,corr}of sel15)comp15+=corr*c15.fs[idx][b15];
            if(Math.sign(comp15)!==dir1)continue; // 15m must agree
          }
          sigs.push({bar:i,dir:dir1,ts:d1.t[i],pair});last=i;
        }
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
    console.log(`${cfg.name.padEnd(15)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(4)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2).padStart(5)} $${s.pnl.toFixed(0).padStart(6)} P${pp}/${Object.keys(pairsStat).length} M${pm2}/${Object.keys(mos).length}`);
  }
  console.log('\n'+'═'.repeat(78));
  console.log('ANALYSIS:');console.log('═'.repeat(78));
  const valid=results.filter(r=>r.s.n>=80);
  const viable=valid.filter(r=>r.tpd>=1.8&&r.s.pf>=1.5);
  const best2pd=[...valid.filter(r=>r.tpd>=1.8)].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const best15=[...valid.filter(r=>r.tpd>=1.5)].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const bestPF=[...valid].sort((a,b)=>b.s.pf-a.s.pf)[0];
  if(bestPF)console.log(`Highest PF:       ${bestPF.cfg.name.padEnd(15)} PF${bestPF.s.pf.toFixed(2)} @ ${bestPF.tpd.toFixed(2)} t/d (${bestPF.s.n}t $${bestPF.s.pnl.toFixed(0)})`);
  if(best15)console.log(`Best @ 1.5+ t/d:  ${best15.cfg.name.padEnd(15)} PF${best15.s.pf.toFixed(2)} @ ${best15.tpd.toFixed(2)} t/d (${best15.s.n}t $${best15.s.pnl.toFixed(0)})`);
  if(best2pd)console.log(`Best @ 2+ t/d:    ${best2pd.cfg.name.padEnd(15)} PF${best2pd.s.pf.toFixed(2)} @ ${best2pd.tpd.toFixed(2)} t/d (${best2pd.s.n}t $${best2pd.s.pnl.toFixed(0)})`);
  if(viable.length){
    console.log(`\n★★★ ${viable.length} configs achieve 2+ t/d AND PF >= 1.5:`);
    for(const r of viable)console.log(`  ${r.cfg.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d ($${r.s.pnl.toFixed(0)}) pairs ${r.pp}/${r.np} months ${r.pm}/${r.nm}`);
  }else console.log('\n✗ No config achieved 2+ t/d AND PF>=1.5');
  // Detailed breakdown of best 2+ t/d
  if(best2pd&&best2pd.s.pf>=1.4){
    console.log('\n'+'═'.repeat(78));
    console.log(`BEST 2+ T/D BREAKDOWN: ${best2pd.cfg.name}`);
    console.log('═'.repeat(78));
    const tr=best2pd.trades;
    const mos={};for(const t of tr){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    console.log('Monthly:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
    const pairsR={};for(const t of tr){if(!pairsR[t.pair])pairsR[t.pair]=[];pairsR[t.pair].push(t);}
    console.log('\nPer Pair:');for(const p of Object.keys(pairsR).sort()){const s2=st(pairsR[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  }
  console.log('\n'+'═'.repeat(78)+'\n');
}
main().catch(e=>{console.error('FATAL:',e.message,e.stack);process.exit(1);});
