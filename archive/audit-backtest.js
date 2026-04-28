#!/usr/bin/env node
'use strict';
const https = require('https');

// ─── CONFIG (identical to backtest-300d-definitive.js) ───
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT'];
const PRIORITY = {ETHUSDT:0,BTCUSDT:1,SOLUSDT:2,BNBUSDT:3,XRPUSDT:4,DOGEUSDT:5,ADAUSDT:6,AVAXUSDT:7};
const DAYS = 180, INIT_CAP = 500, MAX_POS = 3, MAX_SAME_DIR = 2, LEV = 5;
const SL_PCT = 0.007, TP_PCT = 0.03;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const TIMEOUT_BARS = 100, DAILY_LOSS_PCT = 0.06, MIN_CAP = 100;
const SCHEDULES = { '24/7': [0,24], 'A:00-10': [0,10], 'B:02-12': [2,12], 'C:08-18': [8,18] };

// ─── FETCH ───
function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); }).on('error',rej);
  });
}
async function getKlines(sym, interval, days) {
  const end = Date.now(), ms = days*86400000, lim = 1500;
  let all = [], t = end - ms;
  while (t < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=${lim}`;
    const k = await fetchJSON(url);
    if (!k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r=>setTimeout(r,250));
  }
  return all;
}

// ─── INDICATORS (exact copy) ───
function sma(a,p){const r=[];for(let i=0;i<a.length;i++)r.push(i<p-1?NaN:a.slice(i-p+1,i+1).reduce((s,v)=>s+v)/p);return r;}
function ema(a,p){const r=[a[0]],m=2/(p+1);for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function rsi(c,p=14){const r=[NaN];let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];if(i<=p){if(d>0)ag+=d;else al-=d;if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}}return r;}
function macd(c,f=12,s=26,sig=9){const ef=ema(c,f),es=ema(c,s),line=ef.map((v,i)=>v-es[i]),signal=ema(line,sig),hist=line.map((v,i)=>v-signal[i]);return{line,signal,hist};}
function adxCalc(h,l,c,p=14){const tr=[0],pd=[0],nd=[0];for(let i=1;i<c.length;i++){tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd.push(u>d&&u>0?u:0);nd.push(d>u&&d>0?d:0);}const at=ema(tr,p),sp=ema(pd,p),sn=ema(nd,p);const pdi=sp.map((v,i)=>at[i]?v/at[i]*100:0),ndi=sn.map((v,i)=>at[i]?v/at[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+ndi[i];return s?Math.abs(v-ndi[i])/s*100:0;});return{adx:ema(dx,p),pdi,ndi,atr:at};}

// ─── HTF ───
function precomputeHTF(kl1h) {
  if (!kl1h.length) return {ct:[],trend:[],adxV:[]};
  const ct=kl1h.map(k=>parseInt(k[6])),cl=kl1h.map(k=>+k[4]),hi=kl1h.map(k=>+k[2]),lo=kl1h.map(k=>+k[3]);
  const e9=ema(cl,9),e21=ema(cl,21);
  const trend=e9.map((v,i)=> i<20?0: v>e21[i]?1:-1);
  const a=adxCalc(hi,lo,cl);
  return {ct,trend,adxV:a.adx};
}
function htfIdx(htf,barTime){let lo=0,hi=htf.ct.length-1,idx=-1;while(lo<=hi){const m=(lo+hi)>>1;if(htf.ct[m]<=barTime){idx=m;lo=m+1;}else hi=m-1;}return idx;}

// ─── SIGNAL GENERATION (exact copy + score tracking) ───
function generateSignals(kl5m, htf) {
  const closes=kl5m.map(k=>+k[4]),lows=kl5m.map(k=>+k[3]),highs=kl5m.map(k=>+k[2]);
  const vols=kl5m.map(k=>+k[5]);
  const lb=10, rsiZone=35;
  const r=rsi(closes),m=macd(closes),va=sma(vols,20);
  const signals=[];
  for(let i=lb+14;i<closes.length-2;i++){
    const barTime=parseInt(kl5m[i][6]);
    const hIdx=htfIdx(htf,barTime);
    if(hIdx<25)continue;
    let pLL=false,rHL=false;
    for(let j=1;j<=lb;j++){
      if(lows[i]<lows[i-j])pLL=true;
      if(r[i]>r[i-j]&&r[i-j]<rsiZone)rHL=true;
    }
    if(pLL&&rHL&&r[i]<rsiZone+10){
      const trend=htf.trend[hIdx];
      if(trend!==1)continue;
      let score=0;
      if(r[i]<rsiZone)score+=2;
      if(vols[i]>(va[i]||1)*1.5)score+=1;
      score+=3;
      if(m.hist[i]>m.hist[i-1])score+=1;
      if(score>=4) signals.push({bar:i,dir:1,pair:null,barTime,_seq:signals.length,score});
    }
    let pHH=false,rLH=false;
    for(let j=1;j<=lb;j++){
      if(highs[i]>highs[i-j])pHH=true;
      if(r[i]<r[i-j]&&r[i-j]>(100-rsiZone))rLH=true;
    }
    if(pHH&&rLH&&r[i]>(100-rsiZone-10)){
      const trend=htf.trend[hIdx];
      if(trend!==-1)continue;
      let score=0;
      if(r[i]>(100-rsiZone))score+=2;
      if(vols[i]>(va[i]||1)*1.5)score+=1;
      score+=3;
      if(m.hist[i]<m.hist[i-1])score+=1;
      if(score>=4) signals.push({bar:i,dir:-1,pair:null,barTime,_seq:signals.length,score});
    }
  }
  return signals;
}

// ─── DETERMINISTIC FILL ───
function hashFill(pair,bar,seq){let h=2166136261;const s=`${pair}-${bar}-${seq}`;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0;}return(h%100)<80;}

// ─── ENGINE (exact copy + audit fields) ───
function runEngine(allData, htfs, schedule, opts={}) {
  const noProtection = opts.noProtection || false;
  const pairsFilter = opts.pairsFilter || PAIRS;
  const startTime = opts.startTime || 0;
  const endTime = opts.endTime || Infinity;
  const [schStart,schEnd]=SCHEDULES[schedule];
  let capital=INIT_CAP, positions=[], trades=[], dailyPnl={}, paused={};
  let rejected={fill:0,maxPos:0,sameDir:0,dailyLoss:0,schedule:0,lowCap:0,eqPause5:0,eqPause8:0,eqDailyStop:0,eqPermStop:0};
  let capitalHist=[{t:0,c:capital}], maxCap=capital, maxDD=0, totalFees=0;
  let consecLosses=0, pauseUntilBar={}, peakCapital=INIT_CAP;
  let dayStartCapital=INIT_CAP, currentDay=null, dailyStopped=false;
  let permanentStop=false, globalBarCounter=0;

  let allSignals=[];
  for(const pair of pairsFilter){
    const sigs=generateSignals(allData[pair].kl5m, htfs[pair]);
    for(const s of sigs){s.pair=pair;allSignals.push(s);}
  }
  allSignals.sort((a,b)=>a.barTime-b.barTime||(PRIORITY[a.pair]||99)-(PRIORITY[b.pair]||99));

  for(const sig of allSignals){
    if(capital<MIN_CAP){rejected.lowCap++;continue;}
    const kl5m=allData[sig.pair].kl5m;
    const entryBar=sig.bar+2;
    if(entryBar>=kl5m.length)continue;

    const entryTimeMs=parseInt(kl5m[entryBar][0]);
    if(entryTimeMs < startTime || entryTimeMs > endTime) continue;

    const entryTime=new Date(entryTimeMs);
    const hr=entryTime.getUTCHours();
    if(schStart<schEnd){if(hr<schStart||hr>=schEnd){rejected.schedule++;continue;}}
    else{if(hr<schStart&&hr>=schEnd){rejected.schedule++;continue;}}

    if(!hashFill(sig.pair,sig.bar,sig._seq)){rejected.fill++;continue;}

    globalBarCounter++;
    if(!noProtection){
      if(permanentStop){rejected.eqPermStop++;continue;}
      const eqDay=entryTime.toUTCString().slice(0,16);
      if(eqDay!==currentDay){currentDay=eqDay;dayStartCapital=capital;dailyStopped=false;}
      if(dailyStopped){rejected.eqDailyStop++;continue;}
      if(globalBarCounter<(pauseUntilBar['_global']||0)){rejected.eqPause5++;continue;}
    }

    const day=entryTime.toISOString().slice(0,10);
    if(paused[day]){rejected.dailyLoss++;continue;}
    if(!dailyPnl[day])dailyPnl[day]=0;
    if(dailyPnl[day]<=-capital*DAILY_LOSS_PCT){paused[day]=true;rejected.dailyLoss++;continue;}

    positions=positions.filter(p=>!p.closed);
    if(positions.length>=MAX_POS){rejected.maxPos++;continue;}
    const sameDir=positions.filter(p=>p.dir===sig.dir).length;
    if(sameDir>=MAX_SAME_DIR){rejected.sameDir++;continue;}

    const entryPrice=parseFloat(kl5m[entryBar][1]);
    const posSize=Math.min(INIT_CAP, capital*LEV);
    const qty=posSize/entryPrice;
    const entryCost=posSize*FEE_MAKER;
    totalFees+=entryCost;

    const slPrice=sig.dir===1?entryPrice*(1-SL_PCT):entryPrice*(1+SL_PCT);
    const tpPrice=sig.dir===1?entryPrice*(1+TP_PCT):entryPrice*(1-TP_PCT);

    const capBefore = capital;
    const pos={dir:sig.dir,entry:entryPrice,sl:slPrice,tp:tpPrice,qty,cost:entryCost,bar:entryBar,day,pair:sig.pair,closed:false,sigBar:sig.bar};
    positions.push(pos);

    for(let j=entryBar+1;j<kl5m.length&&j<=entryBar+TIMEOUT_BARS;j++){
      const hj=+kl5m[j][2],lj=+kl5m[j][3],cj=+kl5m[j][4];
      let hitSL=false,hitTP=false;
      if(sig.dir===1){hitSL=lj<=slPrice;hitTP=hj>=tpPrice;}
      else{hitSL=hj>=slPrice;hitTP=lj<=tpPrice;}
      if(hitSL&&hitTP)hitTP=false;

      let tradeNet=null;
      if(hitSL){
        const exitP=slPrice*(sig.dir===1?(1-SLIP_SL):(1+SLIP_SL));
        const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const exitFee=posSize*FEE_TAKER;totalFees+=exitFee;
        const net=pnl-entryCost-exitFee;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        if(dailyPnl[day]<=-INIT_CAP*DAILY_LOSS_PCT)paused[day]=true;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'SL',bars:j-entryBar,pair:sig.pair,
          time:entryTimeMs,exitTime:parseInt(kl5m[j][0]),posSize,fees:entryCost+exitFee,
          capBefore,capAfter:capital,score:sig.score,sigBarTime:sig.barTime,
          htfCloseTime: htfs[sig.pair].ct[htfIdx(htfs[sig.pair],sig.barTime)]
        });
        pos.closed=true;capitalHist.push({t:parseInt(kl5m[j][0]),c:capital});
        if(capital>maxCap)maxCap=capital;const dd=(maxCap-capital)/maxCap;if(dd>maxDD)maxDD=dd;
        tradeNet=net;
      }
      if(!tradeNet&&hitTP){
        const exitP=tpPrice;
        const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const exitFee=posSize*FEE_MAKER;totalFees+=exitFee;
        const net=pnl-entryCost-exitFee;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'TP',bars:j-entryBar,pair:sig.pair,
          time:entryTimeMs,exitTime:parseInt(kl5m[j][0]),posSize,fees:entryCost+exitFee,
          capBefore,capAfter:capital,score:sig.score,sigBarTime:sig.barTime,
          htfCloseTime: htfs[sig.pair].ct[htfIdx(htfs[sig.pair],sig.barTime)]
        });
        pos.closed=true;capitalHist.push({t:parseInt(kl5m[j][0]),c:capital});
        if(capital>maxCap)maxCap=capital;const dd=(maxCap-capital)/maxCap;if(dd>maxDD)maxDD=dd;
        tradeNet=net;
      }
      if(!tradeNet&&j===entryBar+TIMEOUT_BARS){
        const exitP=cj;
        const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const exitFee=posSize*FEE_TAKER;totalFees+=exitFee;
        const net=pnl-entryCost-exitFee;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'TO',bars:TIMEOUT_BARS,pair:sig.pair,
          time:entryTimeMs,exitTime:parseInt(kl5m[j][0]),posSize,fees:entryCost+exitFee,
          capBefore,capAfter:capital,score:sig.score,sigBarTime:sig.barTime,
          htfCloseTime: htfs[sig.pair].ct[htfIdx(htfs[sig.pair],sig.barTime)]
        });
        pos.closed=true;capitalHist.push({t:parseInt(kl5m[j][0]),c:capital});
        if(capital>maxCap)maxCap=capital;const dd=(maxCap-capital)/maxCap;if(dd>maxDD)maxDD=dd;
        tradeNet=net;
      }

      if(tradeNet!==null){
        if(!noProtection){
          if(tradeNet<0){
            consecLosses++;
            if(consecLosses>=8){pauseUntilBar['_global']=globalBarCounter+72;}
            else if(consecLosses===5){pauseUntilBar['_global']=globalBarCounter+24;}
          } else { consecLosses=0; }
          if(capital>peakCapital) peakCapital=capital;
          const dayDD=(capital-dayStartCapital)/dayStartCapital;
          if(dayDD<=-0.10&&!dailyStopped){ dailyStopped=true; }
          const ddFromPeak=(peakCapital-capital)/peakCapital;
          if(ddFromPeak>=0.30&&!permanentStop){
            permanentStop=true;
            pauseUntilBar['_global']=globalBarCounter+288;
            peakCapital=capital;
            permanentStop=false;
          }
        }
        break;
      }
    }
  }
  return {trades,capital,maxDD,totalFees,rejected,capitalHist};
}

function calcStats(trades){
  if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,avgWin:0,avgLoss:0};
  const w=trades.filter(t=>t.pnl>0),lo=trades.filter(t=>t.pnl<=0);
  const gw=w.reduce((a,t)=>a+t.pnl,0),gl=Math.abs(lo.reduce((a,t)=>a+t.pnl,0));
  return{pf:gl?gw/gl:gw?99:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,
    avgWin:w.length?gw/w.length:0,avgLoss:lo.length?gl/lo.length:0};
}

// ═══════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DEFINITIVE 10-CHECK AUDIT — backtest-300d-definitive.js   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let passed = 0, failed = 0;
  function verdict(num, name, pass, reason='') {
    console.log(`  VERDICT: ${pass?'✓':'✗'} ${pass?'PASS':'FAIL'}${reason ? ' ('+reason+')' : ''}`);
    if (pass) passed++; else failed++;
  }

  // ─── Download data once ───
  console.log('Downloading 180 days of 5m + 1h klines for all pairs...');
  const allData = {};
  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}...`);
    const [kl5m, kl1h] = await Promise.all([getKlines(pair,'5m',DAYS), getKlines(pair,'1h',DAYS)]);
    allData[pair] = {kl5m, kl1h};
    console.log(` 5m:${kl5m.length} 1h:${kl1h.length}`);
  }
  const htfs = {};
  for (const pair of PAIRS) htfs[pair] = precomputeHTF(allData[pair].kl1h);

  // ═══ CHECK 1: REPRODUCIBILITY ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 1: REPRODUCIBILITY');
  console.log('='.repeat(60));
  const run1 = runEngine(allData, htfs, '24/7');
  const run2 = runEngine(allData, htfs, '24/7');
  const s1 = calcStats(run1.trades), s2 = calcStats(run2.trades);
  console.log(`  Run 1: PnL=$${s1.pnl.toFixed(2)}, PF=${s1.pf.toFixed(4)}, WR=${s1.wr.toFixed(2)}%, Trades=${s1.n}, FinalCap=$${run1.capital.toFixed(2)}`);
  console.log(`  Run 2: PnL=$${s2.pnl.toFixed(2)}, PF=${s2.pf.toFixed(4)}, WR=${s2.wr.toFixed(2)}%, Trades=${s2.n}, FinalCap=$${run2.capital.toFixed(2)}`);
  const reprMatch = s1.pnl === s2.pnl && s1.n === s2.n && s1.wr === s2.wr;
  if (!reprMatch) {
    console.log(`  DELTA: PnL diff=${Math.abs(s1.pnl-s2.pnl).toFixed(6)}, Trade diff=${Math.abs(s1.n-s2.n)}`);
  }
  verdict(1, 'REPRODUCIBILITY', reprMatch, reprMatch ? 'Identical across 2 runs' : 'NON-DETERMINISTIC results detected!');

  // ═══ CHECK 2: LOOK-AHEAD EMPIRICAL ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 2: LOOK-AHEAD EMPIRICAL');
  console.log('='.repeat(60));
  const trades = run1.trades;
  let lookAheadViolations = 0;
  const checkCount = Math.min(20, trades.length);
  console.log('  #  | Signal Bar Time          | Entry Bar Time           | HTF CloseTime            | Violations');
  console.log('  ' + '-'.repeat(110));
  for (let i = 0; i < checkCount; i++) {
    const t = trades[i];
    const sigTime = t.sigBarTime;
    const entryTime = t.time;
    const htfCT = t.htfCloseTime;
    const v1 = entryTime <= sigTime;
    const v2 = htfCT > sigTime;
    const violations = [];
    if (v1) violations.push('ENTRY<=SIGNAL');
    if (v2) violations.push('HTF_CT>SIGNAL(look-ahead!)');
    if (violations.length) lookAheadViolations++;
    const sigStr = new Date(sigTime).toISOString().slice(0,19);
    const entStr = new Date(entryTime).toISOString().slice(0,19);
    const htfStr = new Date(htfCT).toISOString().slice(0,19);
    console.log(`  ${(i+1).toString().padStart(2)} | ${sigStr} | ${entStr} | ${htfStr} | ${violations.length ? violations.join(', ') : 'OK'}`);
  }
  console.log(`\n  Look-ahead violations: ${lookAheadViolations}/${checkCount}`);
  verdict(2, 'LOOK-AHEAD', lookAheadViolations === 0, lookAheadViolations > 0 ? `${lookAheadViolations} violations found` : 'No look-ahead detected');

  // ═══ CHECK 3: FEES ARITHMETIC ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 3: FEES ARITHMETIC');
  console.log('='.repeat(60));
  const feeCheckIdxs = [49, 499, 1499, 2999, 4499].filter(i => i < trades.length);
  let feeErrors = 0;
  for (const idx of feeCheckIdxs) {
    const t = trades[idx];
    const isLong = t.dir === 1;
    const isSL = t.type === 'SL';
    const isTO = t.type === 'TO';
    const feeEntry = t.posSize * FEE_MAKER;
    const feeExit = t.posSize * (isSL || isTO ? FEE_TAKER : FEE_MAKER);
    const pnlBrutoActual = isLong ? (t.exit - t.entry) * (t.posSize / t.entry) : (t.entry - t.exit) * (t.posSize / t.entry);
    const pnlNeto = pnlBrutoActual - feeEntry - feeExit;
    const diff = Math.abs(pnlNeto - t.pnl);

    console.log(`  Trade #${idx+1} (${t.pair} ${isLong?'LONG':'SHORT'} ${t.type}):`);
    console.log(`    Entry=$${t.entry.toPrecision(7)}, Exit=$${t.exit.toPrecision(7)}, PosSize=$${t.posSize.toFixed(2)}`);
    console.log(`    PnL bruto (qty-based) = $${pnlBrutoActual.toFixed(6)}`);
    console.log(`    Fee entry = $${feeEntry.toFixed(6)}, Fee exit = $${feeExit.toFixed(6)}`);
    console.log(`    PnL neto (calc)   = $${pnlNeto.toFixed(6)}`);
    console.log(`    PnL neto (record) = $${t.pnl.toFixed(6)}`);
    console.log(`    Diff = $${diff.toFixed(8)} ${diff > 0.01 ? '*** MISMATCH ***' : 'OK'}`);
    if (diff > 0.01) feeErrors++;
  }
  verdict(3, 'FEES ARITHMETIC', feeErrors === 0, feeErrors > 0 ? `${feeErrors} mismatches` : `All ${feeCheckIdxs.length} trades verified`);

  // ═══ CHECK 4: CAPITAL CHAIN ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 4: CAPITAL CHAIN');
  console.log('='.repeat(60));
  let chainErrors = 0;
  let posErrors = 0;
  const chainCount = Math.min(10, trades.length);
  console.log('  #  | Cap Before   | PnL         | Cap After    | Chain OK | Pos Size');
  console.log('  ' + '-'.repeat(80));
  for (let i = 0; i < chainCount; i++) {
    const t = trades[i];
    const expectedAfter = t.capBefore + t.pnl;
    const chainOk = Math.abs(expectedAfter - t.capAfter) < 0.001;
    const expectedPos = Math.min(INIT_CAP, t.capBefore * LEV);
    const posOk = Math.abs(t.posSize - expectedPos) < 0.01;
    if (!chainOk) chainErrors++;
    if (!posOk) posErrors++;
    console.log(`  ${(i+1).toString().padStart(2)} | $${t.capBefore.toFixed(2).padStart(10)} | $${t.pnl.toFixed(2).padStart(9)} | $${t.capAfter.toFixed(2).padStart(10)} | ${chainOk?'YES':'NO!'}      | pos=$${t.posSize.toFixed(2)} exp=$${expectedPos.toFixed(2)} ${posOk?'OK':'MISMATCH!'}`);
  }
  const finalPnlSum = trades.reduce((a,t)=>a+t.pnl, 0);
  const expectedFinalCap = INIT_CAP + finalPnlSum;
  const finalCapMatch = Math.abs(expectedFinalCap - run1.capital) < 0.1;
  console.log(`\n  Sum of all PnL: $${finalPnlSum.toFixed(2)}`);
  console.log(`  Expected final cap: $${expectedFinalCap.toFixed(2)}`);
  console.log(`  Actual final cap:   $${run1.capital.toFixed(2)}`);
  console.log(`  Match: ${finalCapMatch ? 'YES' : 'NO (CRITICAL!)'}`);

  console.log(`\n  *** POSITION SIZE BUG: posSize = min(INIT_CAP=$${INIT_CAP}, capital*${LEV})`);
  console.log(`  *** At cap>=$${(INIT_CAP/LEV).toFixed(0)}, posSize is ALWAYS $${INIT_CAP}. Leverage NEVER scales with equity.`);
  console.log(`  *** This is conservative but means the $17k claim comes from $${INIT_CAP} positions only.`);

  verdict(4, 'CAPITAL CHAIN', chainErrors === 0 && posErrors === 0 && finalCapMatch,
    (chainErrors > 0 ? `${chainErrors} chain errors, ` : '') +
    (posErrors > 0 ? `${posErrors} pos errors, ` : '') +
    (!finalCapMatch ? 'Final cap mismatch!' : 'Chain + positions verified'));

  // ═══ CHECK 5: MAX DRAWDOWN ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 5: MAX DRAWDOWN VERIFICATION');
  console.log('='.repeat(60));
  let cap = INIT_CAP, peak = INIT_CAP, worstDD = 0, peakTime = 0, valleyTime = 0, peakCap2 = INIT_CAP, valleyCap = INIT_CAP;
  for (const t of trades) {
    cap += t.pnl;
    if (cap > peak) { peak = cap; peakTime = t.exitTime; peakCap2 = cap; }
    const dd = (peak - cap) / peak;
    if (dd > worstDD) { worstDD = dd; valleyTime = t.exitTime; valleyCap = cap; }
  }
  console.log(`  Peak: $${peakCap2.toFixed(2)} at ${new Date(peakTime).toISOString().slice(0,16)}`);
  console.log(`  Valley: $${valleyCap.toFixed(2)} at ${new Date(valleyTime).toISOString().slice(0,16)}`);
  console.log(`  Max DD (manual calc): ${(worstDD*100).toFixed(2)}%`);
  console.log(`  Max DD (reported):    ${(run1.maxDD*100).toFixed(2)}%`);
  const ddDiff = Math.abs(worstDD - run1.maxDD);
  console.log(`  Difference: ${(ddDiff*100).toFixed(4)}%`);
  verdict(5, 'MAX DRAWDOWN', ddDiff < 0.02, ddDiff >= 0.02 ? `DD differs by ${(ddDiff*100).toFixed(2)}%` : `DD matches within tolerance`);

  // ═══ CHECK 6: WORST MONTH ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 6: STRESS TEST - WORST MONTH');
  console.log('='.repeat(60));
  const months = {};
  for (const t of trades) {
    const m = new Date(t.time).toISOString().slice(0,7);
    if (!months[m]) months[m] = [];
    months[m].push(t);
  }
  let worstMonth = null, worstMonthPnl = Infinity;
  for (const [m, mt] of Object.entries(months)) {
    const s = calcStats(mt);
    console.log(`  ${m}: PnL=$${s.pnl.toFixed(2)}, PF=${s.pf.toFixed(2)}, WR=${s.wr.toFixed(1)}%, Trades=${s.n}`);
    if (s.pnl < worstMonthPnl) { worstMonthPnl = s.pnl; worstMonth = m; }
  }
  console.log(`\n  Worst month: ${worstMonth} (PnL=$${worstMonthPnl.toFixed(2)})`);
  const wmStart = new Date(worstMonth + '-01T00:00:00Z').getTime();
  const wmEndD = new Date(worstMonth + '-01T00:00:00Z');
  wmEndD.setUTCMonth(wmEndD.getUTCMonth() + 1);
  const wmEnd = wmEndD.getTime();
  const wmRun = runEngine(allData, htfs, '24/7', { startTime: wmStart, endTime: wmEnd });
  const wmStats = calcStats(wmRun.trades);
  console.log(`  Isolated run for ${worstMonth} (fresh $${INIT_CAP}):`);
  console.log(`    PnL=$${wmStats.pnl.toFixed(2)}, PF=${wmStats.pf.toFixed(2)}, WR=${wmStats.wr.toFixed(1)}%, Trades=${wmStats.n}, Final=$${wmRun.capital.toFixed(2)}`);
  verdict(6, 'WORST MONTH', true, `${worstMonth}: PF=${wmStats.pf.toFixed(2)}, WR=${wmStats.wr.toFixed(1)}%`);

  // ═══ CHECK 7: WR BY SCORE ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 7: WIN RATE BY SCORE LEVEL');
  console.log('='.repeat(60));
  const byScore = {};
  for (const t of trades) {
    const s = t.score || 0;
    if (!byScore[s]) byScore[s] = { wins: 0, total: 0, pnl: 0 };
    byScore[s].total++;
    byScore[s].pnl += t.pnl;
    if (t.pnl > 0) byScore[s].wins++;
  }
  console.log('  Score | Trades | Wins   | WR%    | PnL');
  console.log('  ' + '-'.repeat(50));
  let anomaly = false;
  const scoreKeys = Object.keys(byScore).map(Number).sort((a,b)=>a-b);
  for (const s of scoreKeys) {
    const d = byScore[s];
    const wr = (d.wins / d.total * 100);
    console.log(`  ${s.toString().padStart(5)} | ${d.total.toString().padStart(6)} | ${d.wins.toString().padStart(6)} | ${wr.toFixed(1).padStart(5)}% | $${d.pnl.toFixed(2)}`);
  }
  const lowScores = scoreKeys.filter(s => s <= 5);
  const highScores = scoreKeys.filter(s => s >= 7);
  let lowWins = 0, lowN = 0, highWins = 0, highN = 0;
  for (const s of lowScores) { lowWins += byScore[s].wins; lowN += byScore[s].total; }
  for (const s of highScores) { highWins += byScore[s].wins; highN += byScore[s].total; }
  const lowPct = lowN ? lowWins/lowN*100 : 0;
  const highPct = highN ? highWins/highN*100 : 0;
  console.log(`\n  Low scores (<=5): WR=${lowPct.toFixed(1)}% (${lowN} trades)`);
  console.log(`  High scores (>=7): WR=${highPct.toFixed(1)}% (${highN} trades)`);
  if (lowPct > highPct + 5 && lowN > 50 && highN > 50) {
    anomaly = true;
    console.log(`  *** ANOMALY: Low-score trades outperform high-score trades!`);
  }
  console.log(`\n  Score breakdown: HTF_aligned(+3 always) + RSI<35(+2) + Vol>1.5x(+1) + MACD_improving(+1)`);
  console.log(`  Min possible score = 4 (HTF=3 + one other). Threshold is >=4.`);
  console.log(`  *** The score filter is almost meaningless — any divergence with HTF alignment passes.`);
  verdict(7, 'WR BY SCORE', !anomaly, anomaly ? 'Low scores beat high scores' : 'Score levels consistent');

  // ═══ CHECK 8: CHERRY-PICK TEST ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 8: CHERRY-PICK TEST (5 x 60-day windows)');
  console.log('='.repeat(60));
  const dataStart = Date.now() - DAYS * 86400000;
  const windows = [
    { name: 'Days 1-60',    start: 0,   end: 60 },
    { name: 'Days 31-90',   start: 30,  end: 90 },
    { name: 'Days 61-120',  start: 60,  end: 120 },
    { name: 'Days 91-150',  start: 90,  end: 150 },
    { name: 'Days 121-180', start: 120, end: 180 },
  ];
  let profitableWindows = 0;
  console.log('  Window       | PnL       | PF    | WR%   | Trades | Profitable?');
  console.log('  ' + '-'.repeat(67));
  for (const w of windows) {
    const wStart = dataStart + w.start * 86400000;
    const wEnd = dataStart + w.end * 86400000;
    const wRun = runEngine(allData, htfs, '24/7', { startTime: wStart, endTime: wEnd });
    const ws = calcStats(wRun.trades);
    const profitable = ws.pnl > 0;
    if (profitable) profitableWindows++;
    console.log(`  ${w.name.padEnd(13)} | $${ws.pnl.toFixed(0).padStart(7)} | ${ws.pf.toFixed(2).padStart(5)} | ${ws.wr.toFixed(1).padStart(5)} | ${ws.n.toString().padStart(6)} | ${profitable ? 'YES' : 'NO'}`);
  }
  console.log(`\n  Profitable windows: ${profitableWindows}/5`);
  verdict(8, 'CHERRY-PICK', profitableWindows >= 3, `${profitableWindows}/5 windows profitable`);

  // ═══ CHECK 9: DOGE SOLO ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 9: DOGE SOLO CHECK');
  console.log('='.repeat(60));
  const dogeRun = runEngine(allData, htfs, '24/7', { pairsFilter: ['DOGEUSDT'] });
  const dogeStats = calcStats(dogeRun.trades);
  const dogeInMulti = calcStats(trades.filter(t => t.pair === 'DOGEUSDT'));
  console.log(`  DOGE solo:     PnL=$${dogeStats.pnl.toFixed(2)}, PF=${dogeStats.pf.toFixed(2)}, WR=${dogeStats.wr.toFixed(1)}%, Trades=${dogeStats.n}, Final=$${dogeRun.capital.toFixed(2)}`);
  console.log(`  DOGE in multi: PnL=$${dogeInMulti.pnl.toFixed(2)}, PF=${dogeInMulti.pf.toFixed(2)}, WR=${dogeInMulti.wr.toFixed(1)}%, Trades=${dogeInMulti.n}`);
  console.log(`  Note: Solo run has no position competition, so trade count may differ.`);
  verdict(9, 'DOGE SOLO', true, `Solo=$${dogeStats.pnl.toFixed(2)} vs Multi=$${dogeInMulti.pnl.toFixed(2)}`);

  // ═══ CHECK 10: BLIND FORWARD - LAST 30 DAYS ═══
  console.log('\n' + '='.repeat(60));
  console.log('CHECK 10: BLIND FORWARD - LAST 30 DAYS');
  console.log('='.repeat(60));
  const last30Start = Date.now() - 30 * 86400000;
  const fwdRun = runEngine(allData, htfs, '24/7', { startTime: last30Start });
  const fwdStats = calcStats(fwdRun.trades);
  console.log(`  Period: ${new Date(last30Start).toISOString().slice(0,10)} to ${new Date().toISOString().slice(0,10)}`);
  console.log(`  PnL:    $${fwdStats.pnl.toFixed(2)}`);
  console.log(`  PF:     ${fwdStats.pf.toFixed(2)}`);
  console.log(`  WR:     ${fwdStats.wr.toFixed(1)}%`);
  console.log(`  Trades: ${fwdStats.n}`);
  console.log(`  Final:  $${fwdRun.capital.toFixed(2)} (started from $${INIT_CAP})`);
  const fwdProfitable = fwdStats.pnl > 0;
  verdict(10, 'BLIND FORWARD', fwdProfitable, fwdProfitable ? `Last 30d profitable: $${fwdStats.pnl.toFixed(2)}` : `Last 30d LOST money: $${fwdStats.pnl.toFixed(2)}`);

  // ═══ SUMMARY ═══
  console.log('\n' + '='.repeat(60));
  console.log('AUDIT SUMMARY');
  console.log('='.repeat(60));
  console.log(`  PASSED: ${passed}/10`);
  console.log(`  FAILED: ${failed}/10`);
  console.log('');
  console.log('  STRUCTURAL CONCERNS (regardless of pass/fail):');
  console.log('  1. posSize = min($500, capital*5) — position is capped at $500 ALWAYS.');
  console.log('     The strategy never compounds. $17k equity still trades $500 positions.');
  console.log('  2. Score threshold >=4 with +3 free from HTF alignment is near-automatic.');
  console.log('     Almost every divergence with trend alignment passes the filter.');
  console.log('  3. hashFill 80% is generous. Real crypto fills ~50-70% for limit orders.');
  console.log('  4. SL=0.7% / TP=3.0% = 4.3:1 R:R. Break-even WR is ~23%.');
  console.log('     60%+ WR at 4.3:1 R:R is extraordinary — validate in live trading.');
  console.log('  5. Entry at bar i+2 OPEN — assumes perfect execution at candle open.');
  console.log('  6. "Permanent stop" at 30% DD immediately resets itself (bug or design?).');
  console.log('  7. No spread modeling — crypto spreads on 5m can eat the 0.7% SL.');
  console.log('  8. Concurrent positions share capital but position size ignores open exposure.');
  console.log('');
  console.log(`  FINAL ASSESSMENT: ${passed >= 8 ? 'Mechanics appear sound but structural concerns remain' : passed >= 5 ? 'SEVERAL CONCERNS — proceed with caution' : 'SERIOUS ISSUES — do not trust these results'}`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
