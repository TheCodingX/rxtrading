#!/usr/bin/env node
'use strict';
// APEX V4 — ML Features + Funding Rate + 1H + Maker Fees + Walk-Forward
const https = require('https');
const END_TS = new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300,TRAIN_DAYS=120,TEST_DAYS=30,STEP_DAYS=30;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002;
const ENTRY_DELAY=1,TIMEOUT=18,FILL_RATE=0.70,PRNG_SEED=314159265;
const FWD_BARS=6,MIN_CORR=0.012,TOP_FEAT=15,SL_M=1.2,TP_R=2.0;

function mkP(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function gK(sym,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gF(sym,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
function pa(k){const n=k.length,o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){t[i]=+k[i][0];o[i]=+k[i][1];h[i]=+k[i][2];l[i]=+k[i][3];c[i]=+k[i][4];v[i]=+k[i][5];}return{o,h,l,c,v,t,n};}

// Indicators
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bo=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mc=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const sk=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// Feature computation (30 features, normalized ~[-1,1])
function compF(d,fr){
  const{c,h,l,v,t,n}=d;
  const r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),mcd=mc(c);
  const adx=ax(h,l,c),atr=at(h,l,c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vs=sm(v,20);
  const frt=fr.map(f=>f.fundingTime||+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrz(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<10)return 0;const w=frr.slice(Math.max(0,b-89),b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(frr[b]-mn)/sd:0;}

  const fs=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++)a[i]=fn(i)||0;fs.push(a);nm.push(name);};
  F('RSI14',i=>isNaN(r14[i])?0:(50-r14[i])/50);
  F('RSI7',i=>isNaN(r7[i])?0:(50-r7[i])/50);
  F('StochK',i=>isNaN(stk[i])?0:(50-stk[i])/50);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('MACDh',i=>mcd.hist[i]/(atr[i]||1));
  F('MACDs',i=>i>0?(mcd.hist[i]-mcd.hist[i-1])/(atr[i]||1):0);
  F('ADX',i=>(adx.adx[i]-25)/25);
  F('ADXs',i=>i>0?(adx.adx[i]-adx.adx[i-1])/10:0);
  F('ATRn',i=>atr[i]/c[i]*100);
  F('E9_21',i=>(e9[i]-e21[i])/(atr[i]||1));
  F('E21_50',i=>(e21[i]-e50[i])/(atr[i]||1));
  F('PvE50',i=>(c[i]-e50[i])/(atr[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);
  F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);
  F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);
  F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('Ret24',i=>i>=24?(c[i]-c[i-24])/c[i-24]*100:0);
  F('VolR',i=>vs[i]>0?(v[i]/vs[i]-1):0);
  F('VolT',i=>i>=3&&vs[i]>0?((v[i]+v[i-1]+v[i-2])/3/vs[i]-1):0);
  F('BarR',i=>atr[i]>0?(h[i]-l[i])/atr[i]-1:0);
  F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('CnsU',i=>{let cnt=0;for(let j=i;j>i-6&&j>0;j--)if(c[j]>c[j-1])cnt++;else break;return cnt/6;});
  F('CnsD',i=>{let cnt=0;for(let j=i;j>i-6&&j>0;j--)if(c[j]<c[j-1])cnt++;else break;return-cnt/6;});
  F('DstH',i=>{let hh=-Infinity;for(let j=Math.max(0,i-19);j<=i;j++)if(h[j]>hh)hh=h[j];return-(c[i]-hh)/(atr[i]||1);});
  F('DstL',i=>{let ll=Infinity;for(let j=Math.max(0,i-19);j<=i;j++)if(l[j]<ll)ll=l[j];return(c[i]-ll)/(atr[i]||1);});
  F('FR',i=>-gfr(t[i])*1000);
  F('FRz',i=>-gfrz(t[i]));
  F('FRc3',i=>{let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<3;j--)if(frt[j]<=t[i]){s+=frr[j];cnt++;}return-s*1000;});
  F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('HrCos',i=>Math.cos(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  return{fs,nm,n};
}

// ML feature selection
function selF(fs,fwd,s,e){
  const co=[];
  for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;
    for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}
    if(cnt<100){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}
  return co.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=MIN_CORR).sort((a,b)=>b.abs-a.abs).slice(0,TOP_FEAT);
}

// Signal generation
function genS(d,fs,sel,thr){
  const{c,h,l,t,n}=d,atr2=at(h,l,c);const sigs=[];let last=-3;
  for(let i=55;i<n-TIMEOUT-ENTRY_DELAY;i++){if(i-last<3)continue;
    let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];
    if(Math.abs(comp)<thr)continue;const dir=comp>0?1:-1;
    const ap=atr2[i]/c[i];if(ap<=0||isNaN(ap))continue;
    let sl=Math.max(0.003,Math.min(0.025,ap*SL_M)),tp=Math.max(0.005,Math.min(0.06,sl*TP_R));
    sigs.push({bar:i,dir,sl,tp,ts:t[i],comp:Math.abs(comp)});last=i;}
  return sigs;
}

// Engine with trailing
function run(sigs,parsed,pr){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];let pos=null;
  const sorted=sigs.slice().sort((a,b)=>a.ts-b.ts);
  function cls(pd,j,tp2){let ep2;if(tp2==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(tp2==='TP')ep2=pos.tpP;else ep2=pd.c[j];
    const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(tp2==='TP'?FEE_TP:FEE_SL);
    cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;
    trades.push({dir:pos.dir,pnl:g-f,type:tp2,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});pos=null;}
  function adv(maxT){if(!pos)return;const pd=parsed[pos.pair];
    for(let j=pos.nc;j<pd.n&&j<=pos.exp&&pd.t[j]<=maxT;j++){
      const mfe=pos.dir===1?(pd.h[j]-pos.ep)/pos.ep:(pos.ep-pd.l[j])/pos.ep;
      if(mfe>=pos.slD&&!pos.trd){pos.slP=pos.dir===1?pos.ep*1.001:pos.ep*0.999;pos.trd=true;}
      if(pos.trd&&mfe>=pos.slD*2){const ns=pos.dir===1?pos.ep*(1+pos.slD*0.5):pos.ep*(1-pos.slD*0.5);if(pos.dir===1&&ns>pos.slP)pos.slP=ns;if(pos.dir===-1&&ns<pos.slP)pos.slP=ns;}
      let hSL,hTP;if(pos.dir===1){hSL=pd.l[j]<=pos.slP;hTP=pd.h[j]>=pos.tpP;}else{hSL=pd.h[j]>=pos.slP;hTP=pd.l[j]<=pos.tpP;}
      if(hSL&&hTP)hTP=false;if(hSL){cls(pd,j,'SL');return;}if(hTP){cls(pd,j,'TP');return;}pos.nc=j+1;}
    if(pos&&pos.nc>pos.exp)cls(parsed[pos.pair],Math.min(pos.exp,parsed[pos.pair].n-1),'TO');}
  for(const sig of sorted){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+ENTRY_DELAY;if(eb>=d.n)continue;
    adv(d.t[eb]);if(pos)continue;if(pr()>=FILL_RATE)continue;if(cap<50)continue;
    const ep=d.o[eb],q=POS_SIZE/ep;
    pos={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sig.sl):ep*(1+sig.sl),tpP:sig.dir===1?ep*(1+sig.tp):ep*(1-sig.tp),qty:q,eb,exp:eb+TIMEOUT,nc:eb+1,slD:sig.sl,trd:false};}
  if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp;j++){
    const mfe=pos.dir===1?(pd.h[j]-pos.ep)/pos.ep:(pos.ep-pd.l[j])/pos.ep;
    if(mfe>=pos.slD&&!pos.trd){pos.slP=pos.dir===1?pos.ep*1.001:pos.ep*0.999;pos.trd=true;}
    let hSL,hTP;if(pos.dir===1){hSL=pd.l[j]<=pos.slP;hTP=pd.h[j]>=pos.tpP;}else{hSL=pd.h[j]>=pos.slP;hTP=pd.l[j]<=pos.tpP;}if(hSL&&hTP)hTP=false;
    if(hSL||hTP){cls(pd,j,hSL?'SL':'TP');break;}}if(pos)cls(parsed[pos.pair],Math.min(pos.exp,parsed[pos.pair].n-1),'TO');}
  return{trades,cap,mdd};}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

async function main(){
  const B='═'.repeat(72);
  console.log(`\n${B}\n  APEX V4 — ML + Funding Rate + 1H + Maker Fees + Walk-Forward\n${B}`);
  console.log(`  1H signals | Funding rate | Maker 0.02% entry | ML walk-forward`);
  console.log(`  ${DAYS}d → ${new Date(END_TS).toISOString().slice(0,10)} | ${TRAIN_DAYS}d train / ${TEST_DAYS}d test\n`);
  const startTs=END_TS-DAYS*86400000;
  const allData={};
  console.log('  == DATA ==');
  for(const pair of PAIRS){process.stdout.write(`  ${pair}: `);
    const kl=await gK(pair,'1h',startTs,END_TS);process.stdout.write(`1h=${kl.length} `);
    const fr=await gF(pair,startTs,END_TS);console.log(`fr=${fr.length}`);
    allData[pair]={kl,fr};}

  console.log(`\n  == WALK-FORWARD ==`);
  const nW=Math.floor((DAYS-TRAIN_DAYS-TEST_DAYS)/STEP_DAYS)+1;
  const allOOS=[];const wRes=[];
  for(let w=0;w<nW;w++){
    const trs=startTs+w*STEP_DAYS*864e5,tre=trs+TRAIN_DAYS*864e5,tes=tre,tee=tes+TEST_DAYS*864e5;
    if(tee>END_TS)break;
    console.log(`\n  W${w+1}: Train ${new Date(trs).toISOString().slice(0,10)}→${new Date(tre).toISOString().slice(0,10)} | Test ${new Date(tes).toISOString().slice(0,10)}→${new Date(tee).toISOString().slice(0,10)}`);
    // Train: compute ALL raw correlations for every feature on every pair, then average
    const allRawCo=[];let fNames=null;let nPairs=0;
    for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
      if(tkl.length<200)continue;const d=pa(tkl),{fs,nm}=compF(d,allData[pair].fr);if(!fNames)fNames=nm;
      const fwd=new Float64Array(d.n).fill(NaN);
      for(let i=50;i<d.n-FWD_BARS;i++)fwd[i]=(d.c[i+FWD_BARS]-d.c[i])/d.c[i]*100;
      // Compute ALL correlations (not just selected)
      const rawCo=new Float64Array(fs.length);
      for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;
        for(let i=50;i<d.n-FWD_BARS;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}
        if(cnt<100){rawCo[f]=0;continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));rawCo[f]=den>0?num/den:0;}
      allRawCo.push(rawCo);nPairs++;}
    // Average ALL correlations across ALL pairs
    const nF=fNames?fNames.length:0;
    const ac=new Float64Array(nF);
    for(let f=0;f<nF;f++){let s=0;for(const co of allRawCo)s+=co[f];ac[f]=nPairs>0?s/nPairs:0;}
    const sel=Array.from(ac).map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=MIN_CORR).sort((a,b)=>b.abs-a.abs).slice(0,TOP_FEAT);
    // Debug: show top avg correlations (no filter)
    const dbg=Array.from(ac).map((c,i)=>({n:fNames?fNames[i]:'?',c})).sort((a,b)=>Math.abs(b.c)-Math.abs(a.c)).slice(0,8);
    console.log(`    AvgCorr(${nPairs}p): ${dbg.map(x=>x.n+'='+x.c.toFixed(5)).join(' ')}`);
    if(sel.length<3){console.log(`    ${sel.length} features pass (need 3+). Skip.`);continue;}
    // Threshold
    let tc=[];
    for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
      if(tkl.length<200)continue;const d=pa(tkl),{fs}=compF(d,allData[pair].fr);
      for(let i=55;i<d.n;i++){let comp=0;for(const{idx,corr}of sel)comp+=corr*fs[idx][i];tc.push(Math.abs(comp));}}
    tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*0.75)]||0.001;
    console.log(`    Features: ${sel.length} | Top: ${sel.slice(0,4).map(s=>fNames[s.idx]+'('+s.corr.toFixed(3)+')').join(', ')}`);
    // Test
    const tSigs=[],tPar={};
    for(const pair of PAIRS){const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);
      if(tkl.length<50)continue;const d=pa(tkl);tPar[pair]=d;
      const{fs}=compF(d,allData[pair].fr);const sigs=genS(d,fs,sel,thr);
      for(const s of sigs)s.pair=pair;tSigs.push(...sigs);}
    const res=run(tSigs,tPar,mkP(PRNG_SEED+w));const s=st(res.trades);
    wRes.push({w:w+1,...s,mdd:res.mdd});allOOS.push(...res.trades);
    console.log(`    Sigs:${tSigs.length} Trades:${s.n} WR:${s.wr.toFixed(1)}% PF:${s.pf.toFixed(2)} $${s.pnl.toFixed(0)} DD:${(res.mdd*100).toFixed(1)}%`);}

  // Aggregate
  const a=st(allOOS);
  console.log(`\n  == AGGREGATE ==`);
  console.log(`  Trades: ${a.n} (TP:${a.tp} SL:${a.sl} TO:${a.to})`);
  console.log(`  WR: ${a.wr.toFixed(1)}% | PF: ${a.pf.toFixed(2)} | PnL: $${a.pnl.toFixed(2)}`);
  // Windows
  let pw=0;for(const w of wRes){if(w.pnl>0)pw++;
    console.log(`  W${w.w}: ${w.n} trades WR ${w.wr.toFixed(1)}% PF ${w.pf.toFixed(2)} $${w.pnl.toFixed(0)}`);}
  // Pairs
  const pairs={};for(const t of allOOS){if(!pairs[t.pair])pairs[t.pair]=[];pairs[t.pair].push(t);}
  let pp=0;console.log('\n  Per Pair:');
  for(const p of Object.keys(pairs).sort()){const s=st(pairs[p]);if(s.pnl>0)pp++;
    console.log(`  ${p.padEnd(10)}: ${s.n} trades WR ${s.wr.toFixed(1)}% PF ${s.pf.toFixed(2)} $${s.pnl.toFixed(0)}`);}
  // Monthly
  const mos={};for(const t of allOOS){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
  let pm=0;console.log('\n  Monthly:');
  for(const m of Object.keys(mos).sort()){const s=st(mos[m]);if(s.pnl>0)pm++;
    console.log(`  ${m}: ${s.n} trades WR ${s.wr.toFixed(1)}% PF ${s.pf.toFixed(2)} $${s.pnl.toFixed(0)}`);}
  // Verdict
  let lv='BELOW';if(a.pf>=1.0)lv='BREAKEVEN';if(a.pf>=1.3)lv='COMPETITIVE';if(a.pf>=1.6)lv='TARGET';if(a.pf>=2.0)lv='EXCEPTIONAL';
  console.log(`\n${B}\n  VERDICT: PF ${a.pf.toFixed(2)} | WR ${a.wr.toFixed(1)}% | $${a.pnl.toFixed(0)} | [${lv}]`);
  console.log(`  Windows: ${pw}/${wRes.length} profitable | Months: ${pm}/${Object.keys(mos).length} | Pairs: ${pp}/${Object.keys(pairs).length}`);
  console.log(B);
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
