#!/usr/bin/env node
'use strict';
// Download holdout data: 2024-07 to 2025-06 (12 months BEFORE V44 training window)
// Plus current April 2026 month for recent-OOS validation
const https=require('https');const fs=require('fs');const path=require('path');const zlib=require('zlib');

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];
// Holdout pre-training: 2024-07 through 2025-06 (12 months)
const HOLDOUT_MONTHS=['2024-07','2024-08','2024-09','2024-10','2024-11','2024-12','2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2026-04'];
const OUT_DIR='/tmp/binance-klines-1m-holdout';

function fetchBinary(url){return new Promise((resolve,reject)=>{https.get(url,res=>{if(res.statusCode===301||res.statusCode===302)return resolve(fetchBinary(res.headers.location));if(res.statusCode!==200)return reject(new Error('HTTP '+res.statusCode+' '+url));const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);}).on('error',reject);});}

async function downloadMonthlyKlines(pair,yearMonth){
  const outDir=path.join(OUT_DIR,pair);
  if(!fs.existsSync(outDir))fs.mkdirSync(outDir,{recursive:true});
  const csvName=`${pair}-1m-${yearMonth}.csv`;
  const target=path.join(outDir,csvName);
  if(fs.existsSync(target)&&fs.statSync(target).size>100000)return{pair,yearMonth,status:'cached',size:fs.statSync(target).size};
  // Binance Data Vision monthly zip
  const url=`https://data.binance.vision/data/futures/um/monthly/klines/${pair}/1m/${pair}-1m-${yearMonth}.zip`;
  try{
    const buf=await fetchBinary(url);
    // Unzip
    const tmpZip=path.join(outDir,`${pair}-1m-${yearMonth}.zip`);
    fs.writeFileSync(tmpZip,buf);
    // Use native zlib (zip is not gzip — use child_process unzip)
    const{execSync}=require('child_process');
    execSync(`cd "${outDir}" && unzip -o "${tmpZip}" > /dev/null 2>&1 && rm "${tmpZip}"`);
    if(!fs.existsSync(target))return{pair,yearMonth,status:'extract_failed'};
    return{pair,yearMonth,status:'downloaded',size:fs.statSync(target).size};
  }catch(e){
    return{pair,yearMonth,status:'error',msg:e.message.slice(0,80)};
  }
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));
  console.log('Downloading HOLDOUT data (pre-training 2024-07→2025-06 + 2026-04)');
  console.log('═'.repeat(80));
  console.log(`  Pairs: ${PAIRS.length}`);
  console.log(`  Months: ${HOLDOUT_MONTHS.length}`);
  console.log(`  Total requests: ${PAIRS.length*HOLDOUT_MONTHS.length}`);
  let ok=0,cached=0,fail=0;
  // Parallel with concurrency limit
  const CONCURRENCY=5;
  const tasks=[];
  for(const pair of PAIRS){for(const m of HOLDOUT_MONTHS){tasks.push({pair,m});}}
  let i=0;
  async function worker(){
    while(i<tasks.length){
      const idx=i++;const{pair,m}=tasks[idx];
      const r=await downloadMonthlyKlines(pair,m);
      if(r.status==='cached'){cached++;process.stdout.write('.');}
      else if(r.status==='downloaded'){ok++;process.stdout.write('+');}
      else{fail++;process.stdout.write('x');}
      if((idx+1)%20===0)process.stdout.write(`[${idx+1}] `);
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY},()=>worker()));
  console.log();
  console.log(`\n✓ ${ok} downloaded, ${cached} cached, ${fail} failed (${((Date.now()-t0)/1000).toFixed(1)}s)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
