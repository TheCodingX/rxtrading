#!/usr/bin/env node
'use strict';
// ANGLE 1 — FUNDING CARRY HARVESTING (genuinely orthogonal to V16/V34)
// Strategy:
//   SHORT perp when funding > +0.03% (longs paying fuerte, fade crowd + collect funding)
//   LONG  perp when funding < -0.02% (shorts paying, long collect)
// Entry: closest 1H bar to funding settlement (00/08/16 UTC)
// Hold: 1-3 settlement periods (8-24h) then close
// Stop: ATR-based (2×ATR) to limit drawdown
// TP: mean reversion (when funding returns to ±0.01% neutral band) OR 2.5×ATR

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP=0.0002;

function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(pair){const dir=path.join(KLINES_DIR,pair);if(!fs.existsSync(dir))return null;const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of files){const content=fs.readFileSync(path.join(dir,f),'utf8');const lines=content.split('\n');const start=lines[0].startsWith('open_time')?1:0;for(let i=start;i<lines.length;i++){const l=lines[i].trim();if(!l)continue;const p=l.split(',');if(p.length<11)continue;bars.push([+p[0],+p[1],+p[2],+p[3],+p[4],+p[5],+p[6]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}

function aggTo1h(b1m){const out=[];let start=0;while(start<b1m.length&&(b1m[start][0]%3600000)!==0)start++;for(let i=start;i<b1m.length;i+=60){const grp=b1m.slice(i,i+60);if(grp.length<60)break;let h=-Infinity,l=Infinity,v=0;for(const b of grp){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];}out.push({t:grp[0][0],o:grp[0][1],h,l,c:grp[grp.length-1][4],v});}return out;}

async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}

const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

async function main(){
  console.log('═'.repeat(80));console.log('ANGLE 1 — FUNDING CARRY HARVESTING');console.log('═'.repeat(80));
  const allData={};
  console.log('\nLoading 1H klines + fetching funding history...');
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}
    const b1h=aggTo1h(b1m);
    const first=b1h[0].t,last=b1h[b1h.length-1].t;
    const fr=await gF(pair,first-3600000,last+3600000);
    allData[pair]={b1h,fr};
    process.stdout.write(`(1h:${b1h.length} fr:${fr.length}) `);
  }
  console.log('\n');

  // Test multiple funding thresholds
  const configs=[
    {name:'FC-03-02',thrLong:-0.0002,thrShort:0.0003,hold:16,slAtr:2.0,tpAtr:2.0},
    {name:'FC-04-03',thrLong:-0.0003,thrShort:0.0004,hold:16,slAtr:2.0,tpAtr:2.0},
    {name:'FC-05-04',thrLong:-0.0004,thrShort:0.0005,hold:16,slAtr:2.0,tpAtr:2.0},
    {name:'FC-05-04-h24',thrLong:-0.0004,thrShort:0.0005,hold:24,slAtr:2.5,tpAtr:3.0},
    {name:'FC-06-05',thrLong:-0.0005,thrShort:0.0006,hold:16,slAtr:2.0,tpAtr:2.0},
    {name:'FC-08-06',thrLong:-0.0006,thrShort:0.0008,hold:16,slAtr:2.0,tpAtr:2.0},
    {name:'FC-10-08-h8',thrLong:-0.0008,thrShort:0.0010,hold:8,slAtr:1.5,tpAtr:1.5},
  ];

  const allResults=[];
  for(const cfg of configs){
    const trades=[];
    for(const pair of PAIRS){
      if(!allData[pair])continue;
      const{b1h,fr}=allData[pair];
      const n=b1h.length;
      const h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),t=new Float64Array(n);
      for(let i=0;i<n;i++){h[i]=b1h[i].h;l[i]=b1h[i].l;c[i]=b1h[i].c;t[i]=b1h[i].t;}
      const atr2=at(h,l,c,14);
      // For each funding event, find the 1H bar at that time
      const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
      let lastSigBar=-100;
      for(let fi=0;fi<frt.length;fi++){
        const fundTime=frt[fi];const fundRate=frr[fi];
        // Skip if doesn't meet threshold
        let dir=0;
        if(fundRate>=cfg.thrShort)dir=-1;      // crowd over-long → SHORT + collect
        else if(fundRate<=cfg.thrLong)dir=1;   // crowd over-short → LONG + collect
        else continue;
        // Find bar CLOSEST to funding time (entry AT settlement to collect)
        let bi=-1;for(let i=0;i<n;i++){if(t[i]>=fundTime){bi=i;break;}}
        if(bi<20||bi>=n-cfg.hold)continue;
        if(bi-lastSigBar<2)continue; // cooldown
        lastSigBar=bi;
        // Enter at open of bar AT funding time
        const eb=bi,ep=b1h[eb].o;
        const atrVal=atr2[eb-1];if(!atrVal||atrVal<=0)continue;
        const slPct=Math.max(0.003,Math.min(0.04,(atrVal/ep)*cfg.slAtr));
        const tpPct=Math.max(0.003,Math.min(0.05,(atrVal/ep)*cfg.tpAtr));
        const slP=dir===1?ep*(1-slPct):ep*(1+slPct);
        const tpP=dir===1?ep*(1+tpPct):ep*(1-tpPct);
        // Simulate hold
        let exit='TO',exitBar=eb+cfg.hold,exitPrice=c[Math.min(eb+cfg.hold,n-1)];
        for(let j=eb+1;j<=Math.min(eb+cfg.hold,n-1);j++){
          if(dir===1){if(l[j]<=slP){exit='SL';exitBar=j;exitPrice=slP*(1-SLIP);break;}if(h[j]>=tpP){exit='TP';exitBar=j;exitPrice=tpP;break;}}
          else{if(h[j]>=slP){exit='SL';exitBar=j;exitPrice=slP*(1+SLIP);break;}if(l[j]<=tpP){exit='TP';exitBar=j;exitPrice=tpP;break;}}
        }
        // Position PnL from price
        const qty=POS_SIZE/ep;
        const priceGain=dir===1?(exitPrice-ep)*qty:(ep-exitPrice)*qty;
        // Funding collected: each settlement we held (settlements every 8h)
        // Dir=1 (long) collects when funding<0 (short pays), pays when funding>0
        // Dir=-1 (short) collects when funding>0 (long pays), pays when funding<0
        let fundPnL=0;let settlementsHeld=0;
        for(let fi2=fi;fi2<frt.length;fi2++){
          if(frt[fi2]>t[exitBar])break;
          if(frt[fi2]<fundTime)continue;
          const fR=frr[fi2];
          // Only count if position is held at settlement time (fi is entry, count from fi)
          if(dir===-1)fundPnL+=fR*POS_SIZE;  // short collects +funding
          else fundPnL+=-fR*POS_SIZE;         // long pays -funding (collects if neg)
          settlementsHeld++;
        }
        const fees=POS_SIZE*FEE_E+POS_SIZE*(exit==='TP'?FEE_TP:FEE_SL);
        const netPnL=priceGain+fundPnL-fees;
        trades.push({pair,dir,pnl:netPnL,price:priceGain,funding:fundPnL,fees,type:exit,date:new Date(t[eb]).toISOString().slice(0,10),settlements:settlementsHeld,entryFR:fundRate});
      }
    }
    if(!trades.length){console.log(`${cfg.name}: 0 trades`);continue;}
    const s=st(trades);
    const totalDays=(allData['BTCUSDT'].b1h[allData['BTCUSDT'].b1h.length-1].t-allData['BTCUSDT'].b1h[0].t)/86400000;
    const tpd=trades.length/totalDays;
    // Separate price PnL vs funding PnL
    const totalPrice=trades.reduce((a,t)=>a+t.price,0);
    const totalFund=trades.reduce((a,t)=>a+t.funding,0);
    console.log(`${cfg.name.padEnd(15)} ${trades.length}t ${tpd.toFixed(2)}t/d WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} Sh${s.sharpe.toFixed(1)} DD$${s.mdd.toFixed(0)} $${s.pnl.toFixed(0)} (price:$${totalPrice.toFixed(0)} fund:$${totalFund.toFixed(0)})`);
    allResults.push({cfg,trades,s,tpd,totalPrice,totalFund});
  }

  // Best config details + correlation with V16/V34
  console.log('\n'+'═'.repeat(80));
  const best=allResults.length?[...allResults].sort((a,b)=>b.s.pf-a.s.pf)[0]:null;
  if(best){
    console.log(`BEST: ${best.cfg.name} — PF ${best.s.pf.toFixed(2)} @ ${best.tpd.toFixed(2)} t/d`);
    console.log(`  PnL breakdown: price $${best.totalPrice.toFixed(0)} + funding $${best.totalFund.toFixed(0)} - fees ≈ $${best.s.pnl.toFixed(0)}`);
    // Per pair
    const bp={};for(const t of best.trades){if(!bp[t.pair])bp[t.pair]=[];bp[t.pair].push(t);}
    console.log('\nPer pair:');for(const p of Object.keys(bp).sort()){const s2=st(bp[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR${s2.wr.toFixed(1)}% PF${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
    // Save trades for correlation analysis later
    fs.writeFileSync('/tmp/angle1-trades.json',JSON.stringify(best.trades));
    console.log('\nBest trades saved to /tmp/angle1-trades.json for correlation analysis');
  }
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
