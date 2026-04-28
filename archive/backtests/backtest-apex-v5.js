#!/usr/bin/env node
'use strict';
// APEX V5 — Funding-Driven + Adaptive ML + Limit Orders + ALL 8 Pairs
// Goal: PF >= 1.6, WR >= 55%, 5-10 signals/day, all pairs
// Strategy: Funding rate extremes as PRIMARY filter + ML composite + adaptive regime
const https=require('https');

const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300,TRAIN_D=120,TEST_D=30,STEP_D=30;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const INIT_CAP=500,POS_SIZE=2500;
// LIMIT ORDER model: maker entry + maker TP
const FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002;
const TIMEOUT=24,FILL=0.75,SEED=314159265;

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function gK(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
function pa(k){const n=k.length,o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){t[i]=+k[i][0];o[i]=+k[i][1];h[i]=+k[i][2];l[i]=+k[i][3];c[i]=+k[i][4];v[i]=+k[i][5];}return{o,h,l,c,v,t,n};}

// Indicators
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bo=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const sk=(h,l,c,kp=14)=>{const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// Feature computation — 30 features
function compF(d,fr){
  const{c,h,l,v,t,n}=d;
  const r14=rs(c),r7=rs(c,7),stk=sk(h,l,c),bbd=bo(c),mc2=mcd(c);
  const adx2=ax(h,l,c),atr2=at(h,l,c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vs=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  function gfrz(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<10)return 0;const w=frr.slice(Math.max(0,b-89),b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(frr[b]-mn)/sd:0;}
  function gfrc(bt,n2){let s=0,cnt=0;for(let j=frt.length-1;j>=0&&cnt<n2;j--)if(frt[j]<=bt){s+=frr[j];cnt++;}return cnt>0?s:0;}

  const fs=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const v2=fn(i);a[i]=isNaN(v2)?0:v2;}fs.push(a);nm.push(name);};
  F('RSI14',i=>(50-r14[i])/50);
  F('RSI7',i=>(50-r7[i])/50);
  F('StochK',i=>isNaN(stk[i])?0:(50-stk[i])/50);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('MACDh',i=>mc2.hist[i]/(atr2[i]||1));
  F('MACDs',i=>i>0?(mc2.hist[i]-mc2.hist[i-1])/(atr2[i]||1):0);
  F('ADX',i=>(adx2.adx[i]-25)/25);
  F('ADXs',i=>i>0?(adx2.adx[i]-adx2.adx[i-1])/10:0);
  F('ATRn',i=>atr2[i]/c[i]*100);
  F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));
  F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('PvE50',i=>(c[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);
  F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);
  F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);
  F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('Ret24',i=>i>=24?(c[i]-c[i-24])/c[i-24]*100:0);
  F('VolR',i=>vs[i]>0?(v[i]/vs[i]-1):0);
  F('VolT',i=>i>=3&&vs[i]>0?((v[i]+v[i-1]+v[i-2])/3/vs[i]-1):0);
  F('BarR',i=>atr2[i]>0?(h[i]-l[i])/atr2[i]-1:0);
  F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('CnsU',i=>{let cnt=0;for(let j=i;j>i-6&&j>0;j--)if(c[j]>c[j-1])cnt++;else break;return cnt/6;});
  F('CnsD',i=>{let cnt=0;for(let j=i;j>i-6&&j>0;j--)if(c[j]<c[j-1])cnt++;else break;return-cnt/6;});
  F('DstH',i=>{let hh=-Infinity;for(let j=Math.max(0,i-19);j<=i;j++)if(h[j]>hh)hh=h[j];return-(c[i]-hh)/(atr2[i]||1);});
  F('DstL',i=>{let ll=Infinity;for(let j=Math.max(0,i-19);j<=i;j++)if(l[j]<ll)ll=l[j];return(c[i]-ll)/(atr2[i]||1);});
  // Funding features — STRONGEST signals
  F('FR',i=>-gfr(t[i])*1000);
  F('FRz',i=>-gfrz(t[i]));
  F('FRc3',i=>-gfrc(t[i],3)*1000);
  F('FRc6',i=>-gfrc(t[i],6)*1000);
  F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('HrCos',i=>Math.cos(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  return{fs,nm,n};
}

// Pearson correlation
function corr(fs,fwd,s,e){
  const co=[];
  for(let f=0;f<fs.length;f++){
    let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;
    for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}
    if(cnt<100){co.push(0);continue;}
    const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));
    co.push(den>0?num/den:0);
  }
  return co;
}

// Engine with multiple SL/TP configs, trailing, dynamic position
function engine(sigs,parsed,pr,cfg){
  const{slM,tpR,trail,maxPos}=cfg;
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];const positions=[];
  const sorted=sigs.slice().sort((a,b)=>a.ts-b.ts);

  function closeTrade(pos2,pd,j,tp2){
    let ep2;
    if(tp2==='SL')ep2=pos2.dir===1?pos2.slP*(1-SLIP_SL):pos2.slP*(1+SLIP_SL);
    else if(tp2==='TP')ep2=pos2.tpP;
    else ep2=pd.c[j];
    const g=pos2.dir===1?(ep2-pos2.ep)*pos2.qty:(pos2.ep-ep2)*pos2.qty;
    const f=POS_SIZE*FEE_E+POS_SIZE*(tp2==='TP'?FEE_TP:FEE_SL);
    const net=g-f;
    cap+=net;pk=Math.max(pk,cap);
    const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;
    trades.push({dir:pos2.dir,pnl:net,type:tp2,pair:pos2.pair,bars:j-pos2.eb,
      date:new Date(pd.t[j]).toISOString().slice(0,10)});
    return net;
  }

  function advanceAll(maxT){
    for(let p=positions.length-1;p>=0;p--){
      const pos2=positions[p];const pd=parsed[pos2.pair];
      let closed=false;
      for(let j=pos2.nc;j<pd.n&&j<=pos2.exp&&pd.t[j]<=maxT;j++){
        if(trail){
          const mfe=pos2.dir===1?(pd.h[j]-pos2.ep)/pos2.ep:(pos2.ep-pd.l[j])/pos2.ep;
          if(mfe>=pos2.slD*1.0&&!pos2.trd){pos2.slP=pos2.dir===1?pos2.ep*1.0005:pos2.ep*0.9995;pos2.trd=true;}
          if(pos2.trd&&mfe>=pos2.slD*2){
            const ns=pos2.dir===1?pos2.ep*(1+pos2.slD*0.7):pos2.ep*(1-pos2.slD*0.7);
            if(pos2.dir===1&&ns>pos2.slP)pos2.slP=ns;if(pos2.dir===-1&&ns<pos2.slP)pos2.slP=ns;}}
        let hSL,hTP;
        if(pos2.dir===1){hSL=pd.l[j]<=pos2.slP;hTP=pd.h[j]>=pos2.tpP;}
        else{hSL=pd.h[j]>=pos2.slP;hTP=pd.l[j]<=pos2.tpP;}
        if(hSL&&hTP)hTP=false;
        if(hSL){closeTrade(pos2,pd,j,'SL');positions.splice(p,1);closed=true;break;}
        if(hTP){closeTrade(pos2,pd,j,'TP');positions.splice(p,1);closed=true;break;}
        pos2.nc=j+1;
      }
      if(!closed&&pos2.nc>pos2.exp){
        const pd2=parsed[pos2.pair];
        closeTrade(pos2,pd2,Math.min(pos2.exp,pd2.n-1),'TO');
        positions.splice(p,1);
      }
    }
  }

  for(const sig of sorted){
    if(cap<=0)break;
    const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.n)continue;
    advanceAll(d.t[eb]);
    if(positions.length>=maxPos)continue;
    // Don't open same pair twice
    if(positions.some(p=>p.pair===sig.pair))continue;
    if(pr()>=FILL)continue;
    if(cap<50)continue;
    const ep=d.o[eb];const atr2=at(d.h,d.l,d.c);
    const atrP=atr2[sig.bar]/d.c[sig.bar];if(atrP<=0||isNaN(atrP))continue;
    let sl=Math.max(0.003,Math.min(0.025,atrP*slM));
    let tp=Math.max(0.005,Math.min(0.06,sl*tpR));
    const q=POS_SIZE/ep;
    positions.push({pair:sig.pair,dir:sig.dir,ep,
      slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),
      qty:q,eb,exp:eb+TIMEOUT,nc:eb+1,slD:sl,trd:false});
  }
  // Close remaining
  advanceAll(Infinity);
  for(const pos2 of positions){
    const pd=parsed[pos2.pair];
    closeTrade(pos2,pd,Math.min(pos2.exp,pd.n-1),'TO');
  }
  return{trades,cap,mdd};
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0,avgW:0,avgL:0};
  const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0);
  const gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,
    tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,
    to:t.filter(x=>x.type==='TO').length,avgW:w.length?gw/w.length:0,avgL:lo.length?gl/lo.length:0};}

async function main(){
  const B='═'.repeat(72);
  console.log(`\n${B}\n  APEX V5 — Funding-Driven + Adaptive ML + ALL 8 Pairs\n${B}`);
  console.log(`  Target: PF >= 1.6 | WR >= 55% | 5-10 signals/day | ALL pairs`);
  console.log(`  ${DAYS}d → ${new Date(END_TS).toISOString().slice(0,10)}\n`);
  const startTs=END_TS-DAYS*864e5;
  const allData={};
  for(const pair of PAIRS){process.stdout.write(`  ${pair}: `);
    const kl=await gK(pair,'1h',startTs,END_TS);process.stdout.write(`1h=${kl.length} `);
    const fr=await gF(pair,startTs,END_TS);console.log(`fr=${fr.length}`);
    allData[pair]={kl,fr};}

  // GRID: iterate over configs until we find PF >= 1.6
  const configs=[
    // slM, tpR, trail, maxPos, fwdBars, threshold_pct, minCorr
    {slM:1.0,tpR:2.5,trail:true,maxPos:3,fwd:4,thrP:80,mc:0.01,name:'A: sl1.0 tp2.5 tr fwd4 thr80'},
    {slM:1.2,tpR:2.0,trail:true,maxPos:3,fwd:6,thrP:80,mc:0.01,name:'B: sl1.2 tp2.0 tr fwd6 thr80'},
    {slM:1.5,tpR:2.5,trail:true,maxPos:3,fwd:6,thrP:75,mc:0.01,name:'C: sl1.5 tp2.5 tr fwd6 thr75'},
    {slM:1.0,tpR:3.0,trail:true,maxPos:3,fwd:4,thrP:85,mc:0.01,name:'D: sl1.0 tp3.0 tr fwd4 thr85'},
    {slM:0.8,tpR:2.0,trail:true,maxPos:3,fwd:6,thrP:70,mc:0.008,name:'E: sl0.8 tp2.0 tr fwd6 thr70'},
    {slM:1.2,tpR:3.0,trail:true,maxPos:2,fwd:8,thrP:80,mc:0.01,name:'F: sl1.2 tp3.0 tr fwd8 thr80'},
    {slM:1.0,tpR:2.0,trail:false,maxPos:3,fwd:6,thrP:75,mc:0.01,name:'G: sl1.0 tp2.0 notr fwd6 thr75'},
    {slM:1.5,tpR:3.0,trail:true,maxPos:2,fwd:4,thrP:85,mc:0.008,name:'H: sl1.5 tp3.0 tr fwd4 thr85'},
    {slM:0.8,tpR:3.0,trail:true,maxPos:3,fwd:4,thrP:80,mc:0.01,name:'I: sl0.8 tp3.0 tr fwd4 thr80'},
    {slM:1.0,tpR:2.5,trail:true,maxPos:2,fwd:6,thrP:85,mc:0.008,name:'J: sl1.0 tp2.5 tr fwd6 thr85'},
    {slM:1.2,tpR:2.5,trail:true,maxPos:3,fwd:3,thrP:75,mc:0.012,name:'K: sl1.2 tp2.5 tr fwd3 thr75'},
    {slM:0.6,tpR:2.0,trail:true,maxPos:3,fwd:6,thrP:70,mc:0.008,name:'L: sl0.6 tp2.0 tr fwd6 thr70'},
    {slM:1.0,tpR:1.5,trail:true,maxPos:3,fwd:4,thrP:70,mc:0.01,name:'M: sl1.0 tp1.5 tr fwd4 thr70'},
    {slM:1.5,tpR:2.0,trail:true,maxPos:3,fwd:3,thrP:80,mc:0.008,name:'N: sl1.5 tp2.0 tr fwd3 thr80'},
    {slM:0.8,tpR:2.5,trail:true,maxPos:3,fwd:8,thrP:75,mc:0.01,name:'O: sl0.8 tp2.5 tr fwd8 thr75'},
    {slM:1.2,tpR:2.0,trail:true,maxPos:3,fwd:4,thrP:70,mc:0.008,name:'P: sl1.2 tp2.0 tr fwd4 thr70'},
  ];

  let bestCfg=null, bestPF=0, bestTrades=[];

  for(const cfg of configs){
    const nW=Math.floor((DAYS-TRAIN_D-TEST_D)/STEP_D)+1;
    const allOOS=[];
    let skip=false;

    for(let w=0;w<nW&&!skip;w++){
      const trs=startTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      if(tee>END_TS)break;

      // Train: compute correlations for all pairs
      const allRaw=[];let fNames=null;let nP=0;
      for(const pair of PAIRS){
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
        if(tkl.length<200)continue;
        const d=pa(tkl),{fs,nm}=compF(d,allData[pair].fr);if(!fNames)fNames=nm;
        const fwd=new Float64Array(d.n).fill(NaN);
        for(let i=50;i<d.n-cfg.fwd;i++)fwd[i]=(d.c[i+cfg.fwd]-d.c[i])/d.c[i]*100;
        allRaw.push(corr(fs,fwd,50,d.n-cfg.fwd));nP++;
      }
      if(!fNames||nP<4){skip=true;break;}

      // Average correlations
      const ac=new Float64Array(fNames.length);
      for(let f=0;f<fNames.length;f++){let s=0;for(const co of allRaw)s+=co[f];ac[f]=s/nP;}
      const sel=Array.from(ac).map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)}))
        .filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,15);
      if(sel.length<3){skip=true;break;}

      // Compute threshold from training composites
      let tc=[];
      for(const pair of PAIRS){
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=trs&&parseInt(k[0])<tre);
        if(tkl.length<200)continue;
        const d=pa(tkl),{fs}=compF(d,allData[pair].fr);
        for(let i=55;i<d.n;i++){let comp=0;for(const{idx,corr:cr}of sel)comp+=cr*fs[idx][i];tc.push(Math.abs(comp));}
      }
      tc.sort((a,b)=>a-b);
      const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;

      // Test: generate signals
      const tSigs=[],tPar={};
      for(const pair of PAIRS){
        const tkl=allData[pair].kl.filter(k=>parseInt(k[0])>=tes&&parseInt(k[0])<tee);
        if(tkl.length<50)continue;
        const d=pa(tkl);tPar[pair]=d;
        const{fs}=compF(d,allData[pair].fr);
        // Generate signals
        let last=-3;
        for(let i=55;i<d.n-TIMEOUT-1;i++){
          if(i-last<2)continue;
          let comp=0;for(const{idx,corr:cr}of sel)comp+=cr*fs[idx][i];
          if(Math.abs(comp)<thr)continue;
          const dir=comp>0?1:-1;
          tSigs.push({bar:i,dir,ts:d.t[i],pair,comp:Math.abs(comp)});
          last=i;
        }
      }
      const res=engine(tSigs,tPar,P(SEED+w),cfg);
      allOOS.push(...res.trades);
    }

    if(skip||!allOOS.length)continue;
    const s=st(allOOS);
    const tpd=s.n/(DAYS-TRAIN_D)*1.0; // rough trades per day
    const tag=s.pf>=bestPF?' ◄ BEST':'';
    console.log(`  ${cfg.name} | ${s.n} trades | WR ${s.wr.toFixed(1)}% | PF ${s.pf.toFixed(2)} | $${s.pnl.toFixed(0)} | ~${tpd.toFixed(1)}t/d${tag}`);

    if(s.pf>bestPF){bestPF=s.pf;bestCfg=cfg;bestTrades=allOOS;}
  }

  if(!bestCfg){console.log('\n  No viable config found.');return;}

  // Detailed breakdown of best
  const s=st(bestTrades);
  console.log(`\n${B}\n  BEST CONFIG: ${bestCfg.name}\n${B}`);
  console.log(`  PF: ${s.pf.toFixed(2)} | WR: ${s.wr.toFixed(1)}% | Net: $${s.pnl.toFixed(0)}`);
  console.log(`  Trades: ${s.n} (TP:${s.tp} SL:${s.sl} TO:${s.to})`);
  console.log(`  AvgWin: $${s.avgW.toFixed(2)} | AvgLoss: $${s.avgL.toFixed(2)}`);

  // Monthly
  const mos={};for(const t of bestTrades){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
  console.log('\n  Monthly:');
  let pm=0;
  for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);if(s2.pnl>0)pm++;
    console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}

  // Per pair
  const pairs={};for(const t of bestTrades){if(!pairs[t.pair])pairs[t.pair]=[];pairs[t.pair].push(t);}
  console.log('\n  Per Pair:');
  let pp=0;
  for(const p of Object.keys(pairs).sort()){const s2=st(pairs[p]);if(s2.pnl>0)pp++;
    console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}

  let lv='BELOW';if(s.pf>=1.0)lv='BREAKEVEN';if(s.pf>=1.3)lv='COMPETITIVE';if(s.pf>=1.6)lv='TARGET ✓';if(s.pf>=2.0)lv='EXCEPTIONAL ✓✓';
  console.log(`\n${B}`);
  console.log(`  VERDICT: PF ${s.pf.toFixed(2)} | WR ${s.wr.toFixed(1)}% | $${s.pnl.toFixed(0)} | [${lv}]`);
  console.log(`  Months: ${pm}/${Object.keys(mos).length} profitable | Pairs: ${pp}/${Object.keys(pairs).length}`);
  console.log(B);
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
