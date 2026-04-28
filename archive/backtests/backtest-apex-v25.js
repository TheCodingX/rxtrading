#!/usr/bin/env node
'use strict';
// APEX V24 — INSTITUTIONAL-FOCUSED: pure Basis+Funding edge with 3 pair-diversified slots
// V23 showed Model A (Institutional) reached PF 1.50 STANDALONE. Multiply this edge.
// 3 slots, EACH must be on DIFFERENT pair (force diversification)
// Expanded institutional feature set: basis dynamics, FR curvature, OI proxy
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
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// EXPANDED institutional feature set
function compF(d,fr,piKl){
  const{c,h,l,v,t,n}=d;const adx2=ax(h,l,c);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}
  function gfrSlope(bt,win){let vals=[];for(let j=frt.length-1;j>=0&&vals.length<win;j--)if(frt[j]<=bt)vals.push(frr[j]);if(vals.length<win)return 0;vals.reverse();return vals[vals.length-1]-vals[0];}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]),piH=piKl.map(k=>+k[2]),piL=piKl.map(k=>+k[3]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt,win){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<win)return 0;const w=piC.slice(b-win+1,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  function gBrange(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}return b>=0?(piH[b]-piL[b])*10000:0;}
  const fs=[],nm=[];const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)?0:v2;}fs.push(a);nm.push(name);};
  // Funding family
  F('FR',i=>-gfr(t[i])*1000);
  F('FRc3',i=>-gfrc(t[i],3)*1000);
  F('FRc6',i=>-gfrc(t[i],6)*1000);
  F('FRc12',i=>-gfrc(t[i],12)*1000);
  F('FRslope',i=>-gfrSlope(t[i],6)*1000);
  // Basis family
  F('Basis',i=>-gB(t[i])*10000);
  F('BasisZ20',i=>-gBz(t[i],20));
  F('BasisZ50',i=>-gBz(t[i],50));
  F('BasisZ100',i=>-gBz(t[i],100));
  F('BasisSlp3',i=>i>=3?-(gB(t[i])-gB(t[i-3]))*10000:0);
  F('BasisSlp6',i=>i>=6?-(gB(t[i])-gB(t[i-6]))*10000:0);
  F('BasisSlp12',i=>i>=12?-(gB(t[i])-gB(t[i-12]))*10000:0);
  F('BasisRng',i=>gBrange(t[i]));
  // Combined
  F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));
  F('FRxBasisZ',i=>(-gfr(t[i])*1000)*(-gBz(t[i],50)));
  // Context
  F('VolR',i=>{const vs2=sm(v,20);return vs2[i]>0?(v[i]/vs2[i]-1):0;});
  F('VolSpike',i=>{const vs2=sm(v,50);return vs2[i]>0?Math.log(v[i]/vs2[i]):0;});
  // Price confirmation (don't use directly, just to help orient)
  F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);
  return{fs,nm,n,adx:adx2.adx};}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// Pair-diversified 3-slot engine
function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];
  const slots=[null,null,null];
  sigs.sort((a,b)=>a.ts-b.ts);
  function cls(pos,pd,j,tp2){let ep2;if(tp2==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(tp2==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(tp2==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:tp2,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});}
  function advSlot(idx,maxT){const pos=slots[idx];if(!pos)return;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp&&pd.t[j]<=maxT;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(pos,pd,j,'SL');slots[idx]=null;return;}if(hT){cls(pos,pd,j,'TP');slots[idx]=null;return;}if(cfg.smartTO&&(j-pos.eb)>=cfg.smartTO){const pnl=pos.dir===1?(pd.c[j]-pos.ep)*pos.qty:(pos.ep-pd.c[j])*pos.qty;if(pnl<=0){cls(pos,pd,j,'TO');slots[idx]=null;return;}}pos.nc=j+1;}if(slots[idx]&&pos.nc>pos.exp){cls(pos,parsed[pos.pair],Math.min(pos.exp,parsed[pos.pair].n-1),'TO');slots[idx]=null;}}
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.n)continue;
    for(let i=0;i<3;i++)advSlot(i,d.t[eb]);
    // Find free slot AND ensure pair not already in any slot
    const busyPairs=new Set(slots.filter(x=>x).map(x=>x.pair));
    if(busyPairs.has(sig.pair))continue;
    let freeIdx=-1;for(let i=0;i<3;i++)if(!slots[i]){freeIdx=i;break;}
    if(freeIdx<0)continue;
    if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=d.o[eb],atr2=at(d.h,d.l,d.c),ap=atr2[sig.bar]/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;
    let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));
    slots[freeIdx]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+cfg.fullTO,nc:eb+1};}
  for(let i=0;i<3;i++){advSlot(i,Infinity);if(slots[i]){const pd=parsed[slots[i].pair];cls(slots[i],pd,Math.min(slots[i].exp,pd.n-1),'TO');}}
  return{trades,cap,mdd};}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

async function main(){
  console.log('APEX V24 — INSTITUTIONAL EDGE + PAIR DIVERSIFIED 3-SLOT');
  console.log('19 institutional features | Each slot on DIFFERENT pair | Smart timeout\n');
  const startTs=END_TS-DAYS*864e5;const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const kl=await gK(pair,'1h',startTs,END_TS);const fr=await gF(pair,startTs,END_TS);const pi=await gPI(pair,'1h',startTs,END_TS);allData[pair]={kl,fr,pi};}
  console.log('\n');
  const rng=P(42),pick=a=>a[Math.floor(rng()*a.length)];
  const nW=Math.floor((DAYS-TRAIN_D-TEST_D)/STEP_D)+1;
  let bestPF=0,bestCfg=null,bestTr=[],bestQual=null;
  console.log('Sampling 3000 V25 configs...\n');
  for(let att=0;att<3000;att++){
    const cfg={
      slM:pick([2.0,2.2,2.5,2.8,3.0,3.3]),
      tpR:pick([1.5,2.0,2.5,3.0,3.5]),
      fwd:pick([1,2,3]),
      thrP:pick([55,60,65,68,70,72,75]),
      adxF:pick([15,18,20,22,25,28]),
      mc:0.005+rng()*0.03,
      topK:pick([5,7,10,12,15]),
      smartTO:pick([0,18,24,30,36]),
      fullTO:pick([48,60,72,84,96]),
      cooldown:pick([1,2,3,5])
    };
    const allOOS=[];let skip=false;
    for(let w=0;w<nW&&!skip;w++){const trs=startTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;if(tee>END_TS)break;
      const pm={};
      for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);if(tkl.length<200)continue;const d=pa(tkl);
        const{fs,adx:adxArr}=compF(d,allData[pair].fr,allData[pair].pi);
        const fwd=new Float64Array(d.n).fill(NaN);for(let i=50;i<d.n-cfg.fwd;i++)fwd[i]=(d.c[i+cfg.fwd]-d.c[i])/d.c[i]*100;
        const co=pearson(fs,fwd,50,d.n-cfg.fwd);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,cfg.topK);
        if(sel.length<3)continue;
        let tc=[];for(let i=55;i<d.n;i++){if(adxArr[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);pm[pair]={sel,thr:tc[Math.floor(tc.length*cfg.thrP/100)]||0.001};}
      if(Object.keys(pm).length<4){skip=true;break;}
      const sigs=[],tPar={};
      for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);if(tkl.length<50||!pm[pair])continue;const d=pa(tkl);tPar[pair]=d;
        const{fs,adx:adxArr}=compF(d,allData[pair].fr,allData[pair].pi);const{sel,thr}=pm[pair];let last=-cfg.cooldown;
        for(let i=55;i<d.n-cfg.fullTO-1;i++){if(i-last<cfg.cooldown)continue;if(adxArr[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];if(Math.abs(comp)<thr)continue;sigs.push({bar:i,dir:comp>0?1:-1,ts:d.t[i],pair});last=i;}}
      allOOS.push(...engine(sigs,tPar,P(SEED+w),cfg).trades);}
    if(skip||!allOOS.length)continue;const s=st(allOOS);const tpd=s.n/(nW*TEST_D);
    // Multi-criteria: prefer configs with good PF AND trades/day
    const qual=s.pf*s.pf*Math.min(tpd/2,1.3)*(s.pnl>0?1:0.2);
    if(s.n>=360&&tpd>=2.0&&s.pf>=1.3&&(!bestQual||qual>bestQual)){bestQual=qual;bestPF=s.pf;bestCfg=cfg;bestTr=allOOS;
      console.log(`[${att}] ${s.n}t ${tpd.toFixed(1)}t/d WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} $${s.pnl.toFixed(0)} qual${qual.toFixed(2)} ◄`);}}
  if(!bestCfg){console.log('No config.');return;}
  const s=st(bestTr);const tpd=s.n/(nW*TEST_D);
  console.log(`\nCFG: ${JSON.stringify(bestCfg)}`);
  console.log(`\nTOTAL: ${s.n}t ${tpd.toFixed(1)}t/d PF ${s.pf.toFixed(2)} WR ${s.wr.toFixed(1)}% $${s.pnl.toFixed(0)} [TP:${s.tp}/SL:${s.sl}/TO:${s.to}]`);
  const mos={};for(const t of bestTr){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
  let pm2=0;console.log('\nMonthly:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);if(s2.pnl>0)pm2++;console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  const pairs={};for(const t of bestTr){if(!pairs[t.pair])pairs[t.pair]=[];pairs[t.pair].push(t);}
  let pp=0;console.log('\nPer Pair:');for(const p of Object.keys(pairs).sort()){const s2=st(pairs[p]);if(s2.pnl>0)pp++;console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  const lv=s.pf>=1.8&&tpd>=3?'★★★ GOAL REACHED':s.pf>=1.8?'★★ HIGH PF':s.pf>=1.5?'★ TARGET':s.pf>=1.3?'COMPETITIVE':'BELOW';
  console.log(`\n${'═'.repeat(72)}\nVERDICT: PF ${s.pf.toFixed(2)} | ${tpd.toFixed(1)} t/day | $${s.pnl.toFixed(0)} | [${lv}]`);
  console.log(`Months: ${pm2}/${Object.keys(mos).length} | Pairs: ${pp}/${Object.keys(pairs).length}\n${'═'.repeat(72)}`);
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
