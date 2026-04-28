#!/usr/bin/env node
'use strict';
// V41 Mejora 6: Retrain APEX model on ROLLING 150d window (recent regime) instead of full 274d
// Goal: close walk-forward vs static gap. Validate new vs old on last 30d before deploy.
const fs=require('fs');
const path=require('path');
const https=require('https');

const ALL_PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT','POLUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','TIAUSDT','SEIUSDT','RUNEUSDT','1000PEPEUSDT','WLDUSDT','FETUSDT','RENDERUSDT','JUPUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const TRAIN_DAYS=150; // rolling window (recent)
const VALIDATE_DAYS=30; // held-out validation period

function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti});}return o;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,180));}return a;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const stoch=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};

const FEAT_NAMES=['RSI14','RSI7','StochK','BBpos','MACDh','MACDs','ADXv','E9_21','E21_50','Ret1','Ret3','Ret6','Ret12','VolR','ClsP','FR','FRc3','FRc6','Basis','BasisMA','BasisZ','BasisSlope','BasisVsFR','HrSin'];

function computeFeatures(bars,fr,piKl){
  const n=bars.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}
  const r14=rsI(c,14),r7=rsI(c,7);const stk=stoch(h,l,c,14);const bbd=bb(c,20,2);const mc=mcd(c);const adxR=ax(h,l,c,14);
  const e9=em(c,9),e21=em(c,21),e50=em(c,50);const vs=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  const gfr=(bt)=>{let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;};
  const gfrc=(bt,nn)=>{let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<nn;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;};
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  const gBasis=(bt)=>{let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;};
  const gBasisMA=(bt,lb)=>{let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<lb)return 0;let s=0;for(let j=b-lb+1;j<=b;j++)s+=piC[j];return s/lb;};
  const gBasisZ=(bt)=>{let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1);const mn=w.reduce((a,x)=>a+x,0)/w.length;const sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;};
  const fs=new Array(24);for(let j=0;j<24;j++)fs[j]=new Array(n).fill(0);
  for(let i=50;i<n;i++){const atr_i=adxR.atr[i]||1;
    fs[0][i]=(50-r14[i])/50;fs[1][i]=(50-r7[i])/50;fs[2][i]=isNaN(stk[i])?0:(50-stk[i])/50;
    fs[3][i]=(!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i])?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0;
    fs[4][i]=mc.hist[i]/atr_i;fs[5][i]=i>0?(mc.hist[i]-mc.hist[i-1])/atr_i:0;
    fs[6][i]=(adxR.adx[i]-25)/25;fs[7][i]=(e9[i]-e21[i])/atr_i;fs[8][i]=(e21[i]-e50[i])/atr_i;
    fs[9][i]=i>=1?(c[i]-c[i-1])/c[i-1]*100:0;fs[10][i]=i>=3?(c[i]-c[i-3])/c[i-3]*100:0;
    fs[11][i]=i>=6?(c[i]-c[i-6])/c[i-6]*100:0;fs[12][i]=i>=12?(c[i]-c[i-12])/c[i-12]*100:0;
    fs[13][i]=vs[i]>0?(v[i]/vs[i]-1):0;fs[14][i]=h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0;
    fs[15][i]=-gfr(t[i])*1000;fs[16][i]=-gfrc(t[i],3)*1000;fs[17][i]=-gfrc(t[i],6)*1000;
    fs[18][i]=-gBasis(t[i])*10000;fs[19][i]=-gBasisMA(t[i],24)*10000;fs[20][i]=-gBasisZ(t[i]);
    const b1=gBasis(t[i]),b2=i>=6?gBasis(t[i]-6*3600000):b1;fs[21][i]=-(b1-b2)*10000;
    fs[22][i]=(-gBasis(t[i])*10000)+(-gfr(t[i])*1000);fs[23][i]=Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI);
    for(let j=0;j<24;j++)if(isNaN(fs[j][i])||!isFinite(fs[j][i]))fs[j][i]=0;}
  return{features:fs,adx:adxR.adx,atr:adxR.atr,parsed:{o,h,l,c,v,t}};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

async function trainPair(pair,endTs){
  const b1m=load1m(pair);if(!b1m||b1m.length<50000)return null;
  const b1h=aggTF(b1m,60);
  // Use only last TRAIN_DAYS bars
  const cutoffTs=endTs-TRAIN_DAYS*86400000;
  const trainBars=b1h.filter(b=>b.t>=cutoffTs&&b.t<endTs);
  if(trainBars.length<1500)return null;
  const fr=await gF(pair,trainBars[0].t,endTs);
  const pi=await gPI(pair,'1h',trainBars[0].t,endTs);
  const{features,adx,parsed}=computeFeatures(trainBars,fr,pi);
  const n=parsed.c.length;
  const fwd=new Float64Array(n).fill(NaN);
  for(let i=50;i<n-2;i++)fwd[i]=(parsed.c[i+2]-parsed.c[i])/parsed.c[i]*100;
  const co=pearson(features,fwd,50,n-2);
  const sel=co.map((c,idx)=>({name:FEAT_NAMES[idx],idx,corr:+c.toFixed(6),abs:Math.abs(c)})).filter(x=>x.abs>=0.005).sort((a,b)=>b.abs-a.abs).slice(0,12);
  if(sel.length<2)return null;
  const tc=[];for(let i=55;i<n;i++){if(adx[i]<25)continue;let comp=0;for(const f of sel)comp+=f.corr*(features[f.idx][i]||0);tc.push(Math.abs(comp));}
  tc.sort((a,b)=>a-b);
  const threshold=tc[Math.floor(tc.length*0.65)]||0.001;
  return{features:sel.map(x=>({name:x.name,idx:x.idx,corr:x.corr})),threshold:+threshold.toFixed(6),count:sel.length};
}

async function main(){
  const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
  console.log(`V41 Rolling Retraining: last ${TRAIN_DAYS}d ending ${new Date(END_TS).toISOString().slice(0,10)}`);
  console.log('(Previous V40 used full 274d — this should adapt to recent regime)\n');
  const trained={};let ok=0;
  for(const pair of ALL_PAIRS){
    process.stdout.write(pair+' ... ');
    try{
      const m=await trainPair(pair,END_TS);
      if(m){trained[pair]=m;ok++;console.log(`✓ thr=${m.threshold}`);}
      else console.log('✗');
    }catch(e){console.log('✗ '+e.message);}
  }
  const output={
    config:{slM:2,tpR:1.625,fwd:2,thrP:65,maxPos:4,timeout:60,adxF:25,mc:0.011,gate4h:true,dynSize:false,thrScale:1.3,orMode:false,revThresh:0.5},
    features:FEAT_NAMES,pairs:trained,
    trainedAt:new Date().toISOString(),trainDays:TRAIN_DAYS,
    version:'v41-rolling-150d'
  };
  fs.writeFileSync('/tmp/apex-v41-model.json',JSON.stringify(output));
  console.log(`\nTrained ${ok}/${ALL_PAIRS.length} pairs on rolling ${TRAIN_DAYS}d window`);
  console.log(`File: /tmp/apex-v41-model.json (${fs.statSync('/tmp/apex-v41-model.json').size} bytes)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
