const http = require('http');
const fs = require('fs');
const path = require('path');
const root = 'D:/code/obsidian-cli';
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
http.createServer((req,res)=>{
  const u = new URL(req.url, 'http://127.0.0.1');
  const f = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
  if (!f.startsWith(path.normalize(root))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(f,(e,d)=>{
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'});
    res.end(d);
  });
}).listen(4173,'127.0.0.1');
