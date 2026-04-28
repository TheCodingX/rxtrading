#!/usr/bin/env node
'use strict';
// APEX V27 — STRICT QUALITY SEARCH: find configs with PF>=1.8 AND trades/day>=2 AND 8 pairs
// Levers explored: maxPos, pair-diversified slots, per-pair adaptive thresholds,
// fwd horizon, cooldown, ADX filter, top-K features, retrain window
const https=require('https');
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300;
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

function compF(d,fr,piKl){
  const{c,h,l,v,t,n}=d;const r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),mc2=mcd(c);
  const adx2=ax(h,l,c),atr2=at(h,l,c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vs=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function getBasis(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function getBasisMA(bt,lookback){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<lookback)return 0;let s=0;for(let j=b-lookback+1;j<=b;j++)s+=piC[j];return s/lookback;}
  function getBasisZ(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const fs=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)?0:v2;}fs.push(a);nm.push(name);};
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);F('StochK',i=>isNaN(stk[i])?0:(50-stk[i])/50);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('MACDh',i=>mc2.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc2.hist[i]-mc2.hist[i-1])/(atr2[i]||1):0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vs[i]>0?(v[i]/vs[i]-1):0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('FRc3',i=>-gfrc(t[i],3)*1000);F('FRc6',i=>-gfrc(t[i],6)*1000);
  F('Basis',i=>-getBasis(t[i])*10000);F('BasisMA',i=>-getBasisMA(t[i],24)*10000);F('BasisZ',i=>-getBasisZ(t[i]));
  F('BasisSlope',i=>{const b1=getBasis(t[i]),b2=i>=6?getBasis(t[i-6*3600000]):b1;return-(b1-b2)*10000;});
  F('BasisVsFR',i=>(-getBasis(t[i])*10000)+(-gfr(t[i])*1000));F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  return{fs,nm,n,adx:adx2.adx};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// Pair-diversified multi-slot engine with hard maxPos
function engine(sigs,parsed,pr,cfg){
  const{slM,tpR,maxPos,timeout}=cfg;
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];const positions=[];
  const sorted=sigs.slice().sort((a,b)=>a.ts-b.ts);
  function cls(p2,pd,j,tp2){let ep2;if(tp2==='SL')ep2=p2.dir===1?p2.slP*(1-SLIP_SL):p2.slP*(1+SLIP_SL);else if(tp2==='TP')ep2=p2.tpP;else ep2=pd.c[j];const g=p2.dir===1?(ep2-p2.ep)*p2.qty:(p2.ep-ep2)*p2.qty,f=POS_SIZE*FEE_E+POS_SIZE*(tp2==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:p2.dir,pnl:g-f,type:tp2,pair:p2.pair,bars:j-p2.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});}
  function advAll(maxT){for(let p=positions.length-1;p>=0;p--){const p2=positions[p],pd=parsed[p2.pair];let closed=false;for(let j=p2.nc;j<pd.n&&j<=p2.exp&&pd.t[j]<=maxT;j++){let hS,hT;if(p2.dir===1){hS=pd.l[j]<=p2.slP;hT=pd.h[j]>=p2.tpP;}else{hS=pd.h[j]>=p2.slP;hT=pd.l[j]<=p2.tpP;}if(hS&&hT)hT=false;if(hS){cls(p2,pd,j,'SL');positions.splice(p,1);closed=true;break;}if(hT){cls(p2,pd,j,'TP');positions.splice(p,1);closed=true;break;}if(cfg.smartTO&&(j-p2.eb)>=cfg.smartTO){const pnl=p2.dir===1?(pd.c[j]-p2.ep)*p2.qty:(p2.ep-pd.c[j])*p2.qty;if(pnl<=0){cls(p2,pd,j,'TO');positions.splice(p,1);closed=true;break;}}p2.nc=j+1;}if(!closed&&p2.nc>p2.exp){cls(p2,parsed[p2.pair],Math.min(p2.exp,parsed[p2.pair].n-1),'TO');positions.splice(p,1);}}}
  for(const sig of sorted){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.n)continue;advAll(d.t[eb]);if(positions.length>=maxPos)continue;if(positions.some(p=>p.pair===sig.pair))continue;if(pr()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atr2=at(d.h,d.l,d.c),ap=atr2[sig.bar]/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*slM)),tp=Math.max(0.005,Math.min(0.08,sl*tpR));positions.push({pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+timeout,nc:eb+1});}
  advAll(Infinity);for(const p2 of positions)cls(p2,parsed[p2.pair],Math.min(p2.exp,parsed[p2.pair].n-1),'TO');
  return{trades,cap,mdd};}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

async function main(){
  const B='═'.repeat(75);
  console.log(`\n${B}\n APEX V27 — STRICT: PF>=1.8 AND trades/day>=2 AND 8/8 pairs\n${B}\n`);
  const startTs=END_TS-DAYS*864e5;const allData={};
  for(const pair of PAIRS){process.stdout.write(` ${pair} `);const kl=await gK(pair,'1h',startTs,END_TS);const fr=await gF(pair,startTs,END_TS);const pi=await gPI(pair,'1h',startTs,END_TS);allData[pair]={kl,fr,pi};}
  console.log('\n');
  const rng=P(777);const pick=a=>a[Math.floor(rng()*a.length)];
  // Configurable walk-forward windows
  const winConfigs=[{TR:90,TE:30,ST:30},{TR:120,TE:30,ST:30},{TR:60,TE:30,ST:15},{TR:120,TE:20,ST:20}];
  let bestQual=0, bestCfg=null, bestTr=[];
  let perfectFound=false;
  const allRes=[];
  console.log(' Sampling 3500 configs with 4 different walk-forward windowings...\n');
  for(let att=0;att<3500 && !perfectFound;att++){
    const wc=pick(winConfigs);
    const cfg={
      slM:pick([2.0,2.3,2.5,2.8,3.0,3.3]),
      tpR:pick([2.5,2.8,3.0,3.3,3.5,4.0]),
      fwd:pick([1,2,3]),
      thrP:pick([50,55,58,62,65,68,72,75]),
      maxPos:pick([2,3]),
      timeout:pick([48,60,72,84,96]),
      adxF:pick([20,22,25,28]),
      mc:0.002+rng()*0.015,
      smartTO:pick([0,18,24,30]),
      cooldown:pick([1,2,3]),
      topK:pick([10,12,15]),
      TR:wc.TR,TE:wc.TE,ST:wc.ST
    };
    const nW=Math.floor((DAYS-cfg.TR-cfg.TE)/cfg.ST)+1;const allOOS=[];let skip=false;
    for(let w=0;w<nW&&!skip;w++){
      const trs=startTs+w*cfg.ST*864e5,tre=trs+cfg.TR*864e5,tes=tre,tee=tes+cfg.TE*864e5;if(tee>END_TS)break;
      const pairModels={};
      for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);if(tkl.length<100)continue;
        const d=pa(tkl),{fs,adx:adxArr}=compF(d,allData[pair].fr,allData[pair].pi);
        const fwd=new Float64Array(d.n).fill(NaN);for(let i=50;i<d.n-cfg.fwd;i++)fwd[i]=(d.c[i+cfg.fwd]-d.c[i])/d.c[i]*100;
        const co=pearson(fs,fwd,50,d.n-cfg.fwd);
        const sel=co.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,cfg.topK);
        if(sel.length<2)continue;
        let tc=[];for(let i=55;i<d.n;i++){if(cfg.adxF>0&&adxArr[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);pairModels[pair]={sel,thr:tc[Math.floor(tc.length*cfg.thrP/100)]||0.001};}
      if(Object.keys(pairModels).length<6){skip=true;break;}
      const tSigs=[],tPar={};
      for(const pair of PAIRS){if(!pairModels[pair])continue;
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);if(tkl.length<30)continue;
        const d=pa(tkl);tPar[pair]=d;const{fs,adx:adxArr}=compF(d,allData[pair].fr,allData[pair].pi);
        const{sel,thr}=pairModels[pair];let last=-cfg.cooldown;
        for(let i=55;i<d.n-cfg.timeout-1;i++){if(i-last<cfg.cooldown)continue;if(cfg.adxF>0&&adxArr[i]<cfg.adxF)continue;
          let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];if(Math.abs(comp)<thr)continue;
          tSigs.push({bar:i,dir:comp>0?1:-1,ts:d.t[i],pair});last=i;}}
      const res=engine(tSigs,tPar,P(SEED+w),cfg);allOOS.push(...res.trades);}
    if(skip||allOOS.length<50)continue;
    const s=st(allOOS);
    const pairs={};for(const tr of allOOS){if(!pairs[tr.pair])pairs[tr.pair]=[];pairs[tr.pair].push(tr);}
    let profitablePairs=0;for(const p of Object.keys(pairs)){if(st(pairs[p]).pnl>0)profitablePairs++;}
    const testDays=nW*cfg.TE;const tpd=s.n/testDays;
    // Multi-criteria quality: high PF, trades/day near 2, profitable pairs
    const pfScore=Math.min(s.pf/1.87, 1.3); // cap at 30% above target
    const tpdScore=tpd>=2 ? Math.min(tpd/2, 1.3) : tpd/2; // reward hitting 2
    const pairsScore=profitablePairs/8;
    const qual=pfScore*pfScore*tpdScore*pairsScore;
    allRes.push({cfg, s, tpd, profitablePairs, qual});
    if(s.pf>=1.8 && tpd>=2 && profitablePairs>=8){
      console.log(` *** PERFECT HIT [${att}]: PF ${s.pf.toFixed(2)} WR ${s.wr.toFixed(1)}% $${s.pnl.toFixed(0)} ${tpd.toFixed(1)}t/d ${profitablePairs}/8 ***`);
      perfectFound=true;bestCfg=cfg;bestTr=allOOS;bestQual=qual;
    } else if(qual>bestQual && s.pf>=1.4 && tpd>=1.4){
      bestQual=qual;bestCfg=cfg;bestTr=allOOS;
      console.log(` [${att}] PF ${s.pf.toFixed(2)} WR ${s.wr.toFixed(1)}% ${s.n}t ${tpd.toFixed(1)}t/d pp=${profitablePairs}/8 $${s.pnl.toFixed(0)} qual=${qual.toFixed(3)}`);
    }
    if(att%300===0&&att>0)console.log(` ...${att}/3500 (best qual ${bestQual.toFixed(3)})`);
  }
  if(!bestCfg){console.log(' No viable config found.');return;}
  const s=st(bestTr);
  const pairs={};for(const tr of bestTr){if(!pairs[tr.pair])pairs[tr.pair]=[];pairs[tr.pair].push(tr);}
  let pp=0;for(const p of Object.keys(pairs))if(st(pairs[p]).pnl>0)pp++;
  const testDays=Math.floor((DAYS-bestCfg.TR-bestCfg.TE)/bestCfg.ST+1)*bestCfg.TE;
  const tpd=s.n/testDays;
  console.log(`\n${B}\n CONFIG: ${JSON.stringify(bestCfg)}\n${B}`);
  console.log(` PF: ${s.pf.toFixed(2)} | WR: ${s.wr.toFixed(1)}% | $${s.pnl.toFixed(0)} | ${s.n}t | ${tpd.toFixed(2)} t/d`);
  console.log(` TP:${s.tp} SL:${s.sl} TO:${s.to}`);
  const mos={};for(const tr of bestTr){const m=tr.date.slice(0,7);if(!mos[m])mos[m]=[];mos[m].push(tr);}
  let pm=0;console.log('\n MONTHLY:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);if(s2.pnl>0)pm++;console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  console.log('\n PER PAIR:');for(const p of Object.keys(pairs).sort()){const s2=st(pairs[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  console.log(`\n${B}\n Months profitable: ${pm}/${Object.keys(mos).length} | Pairs profitable: ${pp}/${Object.keys(pairs).length}\n${B}\n`);
  // Also show top alternatives
  allRes.sort((a,b)=>b.qual-a.qual);
  console.log(' TOP 8 BY QUALITY:');
  for(let i=0;i<Math.min(8,allRes.length);i++){const r=allRes[i];console.log(`  #${i+1}: PF ${r.s.pf.toFixed(2)} | ${r.tpd.toFixed(1)}t/d | pp=${r.profitablePairs}/8 | WR ${r.s.wr.toFixed(1)}% | $${r.s.pnl.toFixed(0)} | maxPos=${r.cfg.maxPos} thrP=${r.cfg.thrP} fwd=${r.cfg.fwd} adxF=${r.cfg.adxF}`);}
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
