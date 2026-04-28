#!/usr/bin/env node
'use strict';
// APEX V16 MODEL EXPORTER — trains V16 on last 150d and exports per-pair models as JSON
// This JSON is embedded in the frontend for live paper trading & interactive backtest
const https=require('https');const fs=require('fs');
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const TRAIN_D=150;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
// V16 BEST CONFIG (validated: PF 1.87, WR 47.1%, $3790 OOS 300d)
const CFG={slM:2.5,tpR:3.0,fwd:2,thrP:65,maxPos:1,timeout:60,adxF:25,mc:0.005};
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

// Feature extraction — IDENTICAL to V16
function compF(d,fr,piKl){
  const{c,h,l,v,t,n}=d;const r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),mc2=mcd(c);
  const adx2=ax(h,l,c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vs=sm(v,20);
  const atr2=new Float64Array(n);for(let i=1;i<n;i++){const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));atr2[i]=i===1?tr:(atr2[i-1]*13+tr)/14;}
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function getBasis(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function getBasisMA(bt,lookback){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<lookback)return 0;let s=0;for(let j=b-lookback+1;j<=b;j++)s+=piC[j];return s/lookback;}
  function getBasisZ(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const fs=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)?0:v2;}fs.push(a);nm.push(name);};
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);F('StochK',i=>isNaN(stk[i])?0:(50-stk[i])/50);F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('MACDh',i=>mc2.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc2.hist[i]-mc2.hist[i-1])/(atr2[i]||1):0);F('ADXv',i=>(adx2.adx[i]-25)/25);
  F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vs[i]>0?(v[i]/vs[i]-1):0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('FRc3',i=>-gfrc(t[i],3)*1000);F('FRc6',i=>-gfrc(t[i],6)*1000);
  F('Basis',i=>-getBasis(t[i])*10000);F('BasisMA',i=>-getBasisMA(t[i],24)*10000);F('BasisZ',i=>-getBasisZ(t[i]));
  F('BasisSlope',i=>{const b1=getBasis(t[i]),b2=i>=6?getBasis(t[i-6*3600000]):b1;return-(b1-b2)*10000;});
  F('BasisVsFR',i=>(-getBasis(t[i])*10000)+(-gfr(t[i])*1000));F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  return{fs,nm,n,adx:adx2.adx,atr:atr2};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

(async ()=>{
  console.log('═'.repeat(70));
  console.log(' APEX V16 PRODUCTION MODEL EXPORTER');
  console.log('═'.repeat(70));
  console.log(` Training: last ${TRAIN_D} days`);console.log(` Config: ${JSON.stringify(CFG)}`);console.log('');
  const startTs=END_TS-TRAIN_D*864e5;
  const models={config:CFG,features:null,pairs:{},trainedAt:new Date(END_TS).toISOString(),trainDays:TRAIN_D};
  for(const pair of PAIRS){
    process.stdout.write(` ${pair}: fetching...`);
    const kl=await gK(pair,'1h',startTs,END_TS);const fr=await gF(pair,startTs,END_TS);const pi=await gPI(pair,'1h',startTs,END_TS);
    process.stdout.write(` kl=${kl.length} fr=${fr.length} pi=${pi.length}`);
    const d=pa(kl);const{fs,nm,adx:adxArr}=compF(d,fr,pi);
    if(!models.features)models.features=nm;
    const fwd=new Float64Array(d.n).fill(NaN);for(let i=50;i<d.n-CFG.fwd;i++)fwd[i]=(d.c[i+CFG.fwd]-d.c[i])/d.c[i]*100;
    const co=pearson(fs,fwd,50,d.n-CFG.fwd);
    const sel=co.map((c,i)=>({idx:i,name:nm[i],corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=CFG.mc).sort((a,b)=>b.abs-a.abs).slice(0,12);
    if(sel.length<2){console.log(' SKIPPED (not enough features)');continue;}
    let tc=[];for(let i=55;i<d.n;i++){if(CFG.adxF>0&&adxArr[i]<CFG.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];tc.push(Math.abs(comp));}
    tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*CFG.thrP/100)]||0.001;
    models.pairs[pair]={features:sel.map(x=>({name:x.name,idx:x.idx,corr:+x.corr.toFixed(6)})),threshold:+thr.toFixed(6),count:sel.length};
    console.log(` | ${sel.length} feat, thr=${thr.toFixed(4)}`);
  }
  const out='/Users/rocki/Documents/rxtrading/apex-v16-model.json';
  fs.writeFileSync(out,JSON.stringify(models,null,2));
  console.log('');console.log('═'.repeat(70));console.log(` EXPORTED → ${out}`);console.log('═'.repeat(70));
  console.log(` Pairs: ${Object.keys(models.pairs).length}/${PAIRS.length}`);
  console.log(` Total features defined: ${models.features.length}`);
  for(const[p,m]of Object.entries(models.pairs)){console.log(` ${p.padEnd(10)}: top-${m.count} features | thr=${m.threshold}`);}
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
