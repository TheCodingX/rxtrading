#!/usr/bin/env node
'use strict';
// Download Deribit DVOL historical hourly for BTC/ETH
// Public API, no auth. Endpoint: /api/v2/public/get_volatility_index_data
const fs=require('fs');const https=require('https');
const CURRENCIES=['BTC','ETH'];
function hg(u){return new Promise((r,j)=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>r({status:res.statusCode,data:d}));}).on('error',j);});}
async function getDvol(cur){
  const end=Date.now();const start=end-730*86400*1000;
  // Deribit limits per request; chunk by 30d
  const all=[];let cur0=start;
  while(cur0<end){
    const to=Math.min(end,cur0+30*86400*1000);
    const u=`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${cur}&start_timestamp=${cur0}&end_timestamp=${to}&resolution=3600`;
    try{
      const r=await hg(u);
      if(r.status===200){
        const j=JSON.parse(r.data);
        if(j.result&&j.result.data)for(const row of j.result.data)all.push({t:row[0],o:row[1],h:row[2],l:row[3],c:row[4]});
      }
    }catch(e){console.log(`  chunk err ${e.message}`);}
    cur0=to+1;
    await new Promise(r=>setTimeout(r,200));
  }
  return all;
}
async function main(){
  console.log('Downloading Deribit DVOL (2y hourly)...');
  for(const c of CURRENCIES){
    process.stdout.write(c+'_DVOL ');
    const data=await getDvol(c);
    if(!data.length){console.log('✗ empty');continue;}
    fs.writeFileSync(`/tmp/deribit-dvol-${c.toLowerCase()}.json`,JSON.stringify(data));
    console.log(`✓ ${data.length} bars`);
  }
  console.log('Done. Files: /tmp/deribit-dvol-{btc,eth}.json');
}
main().catch(e=>{console.error(e);process.exit(1);});
