#!/usr/bin/env node
'use strict';
// Download Binance Data Vision metrics (OI + Top Trader L/S + Taker Ratio)
// For 300 days × 8 pairs
const https=require('https');
const fs=require('fs');
const path=require('path');
const zlib=require('zlib');
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300;
const OUT_DIR='/tmp/binance-metrics';
if(!fs.existsSync(OUT_DIR))fs.mkdirSync(OUT_DIR,{recursive:true});

function dl(url,outPath){return new Promise((res,rej)=>{
  const f=fs.createWriteStream(outPath);
  https.get(url,r=>{
    if(r.statusCode!==200){f.close();fs.unlinkSync(outPath);return res(false);}
    r.pipe(f);f.on('finish',()=>{f.close();res(true);});
  }).on('error',e=>{f.close();try{fs.unlinkSync(outPath);}catch{}rej(e);});
});}

function unzipSync(zipPath,outPath){
  return new Promise((res,rej)=>{
    const{spawn}=require('child_process');
    const p=spawn('unzip',['-p',zipPath]);
    const ws=fs.createWriteStream(outPath);
    p.stdout.pipe(ws);
    p.on('exit',c=>c===0?res(true):rej(new Error('unzip fail '+c)));
  });
}

function pad(n){return n<10?'0'+n:''+n;}
function dateStr(ts){const d=new Date(ts);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}

(async()=>{
  let ok=0,miss=0;
  for(const pair of PAIRS){
    const pdir=path.join(OUT_DIR,pair);if(!fs.existsSync(pdir))fs.mkdirSync(pdir,{recursive:true});
    process.stdout.write(`\n${pair}: `);
    for(let d=DAYS-1;d>=0;d--){
      const ts=END_TS-d*86400000;const ds=dateStr(ts);
      const fname=`${pair}-metrics-${ds}.csv`;
      const csvPath=path.join(pdir,fname);
      if(fs.existsSync(csvPath)&&fs.statSync(csvPath).size>1000){ok++;continue;}
      const zipPath=path.join(pdir,fname.replace('.csv','.zip'));
      const url=`https://data.binance.vision/data/futures/um/daily/metrics/${pair}/${pair}-metrics-${ds}.zip`;
      try{
        const got=await dl(url,zipPath);
        if(!got){miss++;process.stdout.write('x');continue;}
        await unzipSync(zipPath,csvPath);
        fs.unlinkSync(zipPath);
        ok++;
        if(d%30===0)process.stdout.write('.');
      }catch(e){miss++;process.stdout.write('!');}
    }
  }
  console.log(`\n\nDONE: ${ok} files downloaded, ${miss} missing`);
})();
