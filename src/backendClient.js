const http = require('http');
const https = require('https');

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url); const body = JSON.stringify(payload); const client = target.protocol === 'https:' ? https : http;
    const request = client.request({hostname:target.hostname,port:target.port,path:target.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, response => {
      let text=''; response.on('data',chunk=>text+=chunk); response.on('end',()=>{
        try { const json=JSON.parse(text); if(response.statusCode >= 300) return reject(new Error(json.error || `Backend HTTP ${response.statusCode}`)); resolve(json); }
        catch (_) { reject(new Error('Backend returned invalid JSON.')); }
      });
    }); request.on('error',reject); request.write(body); request.end();
  });
}
module.exports={post};
