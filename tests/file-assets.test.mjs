import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createAssetStore,offloadText,readText} from '../file-assets.mjs';
function fixture({corrupt=false, fail=false}={}) {
 const files=new Map();let writes=0;
 const assets=createAssetStore({prefix:'test-body',headers:()=>({'X-CSRF':'fixture'}),request:async(url,opts={})=>{
  if(url==='/api/files/upload'){
   writes++;if(fail)return new Response('',{status:500});
   assert.equal(opts.headers['X-CSRF'],'fixture');const {name,data}=JSON.parse(opts.body);
   files.set('/user/files/'+name,corrupt?Buffer.from('wrong'):Buffer.from(data,'base64'));
   return Response.json({path:'user/files/'+name});
  }
  if(url==='/api/files/delete'){files.delete('/'+JSON.parse(opts.body).path);return new Response('');}
  assert.match(url,/^\/user\/files\/test-body-/);
  return files.has(url)?new Response(files.get(url)):new Response('',{status:404});
 }});
 return {assets,files,writes:()=>writes};
}
test('verified Unicode body moves out of settings and lazily reloads exact text',async()=>{
 const f=fixture(),record={id:7,body:'한글💗\n\n'+ 'long body '.repeat(30000)};
 const original=record.body;assert.equal(await offloadText(record,'body',f.assets),true);
 assert.equal('body' in record,false);assert.ok(record.bodyPreview.length<=80);assert.equal(record.id,7);
 assert.equal(await readText(record,'body',f.assets),original);
 assert.ok(JSON.stringify(record).length<500);assert.equal(f.writes(),1);
 const copy={body:original};await offloadText(copy,'body',f.assets);assert.equal(f.writes(),1);
 assert.equal(copy.bodyFile,record.bodyFile);
});
test('failed upload or read-back never removes inline original',async()=>{
 for(const options of [{fail:true},{corrupt:true}]){const f=fixture(options),r={body:'중요한 편지'};
 await assert.rejects(offloadText(r,'body',f.assets));assert.deepEqual(r,{body:'중요한 편지'});}
});
test('concurrent edit wins and empty/legacy inline text remains readable',async()=>{
 const record={body:'old'};await offloadText(record,'body',{putText:async()=>{record.body='new';return '/ignored';}});
 assert.deepEqual(record,{body:'new'});assert.equal(await offloadText({body:''},'body',fixture().assets),false);
 assert.equal(await readText(record,'body',{}),'new');
});
test('missing file is an explicit error, not an empty body, and external paths are rejected',async()=>{
 const f=fixture();await assert.rejects(readText({bodyFile:'/user/files/test-body-'+ 'a'.repeat(64)+'.txt'},'body',f.assets),/404/);
 await assert.rejects(f.assets.text('https://example.com/user/files/test-body-'+ 'a'.repeat(64)+'.txt'));
 await assert.rejects(f.assets.remove('/user/files/other.json'));
});
test('plain HTTP fallback matches SHA-256 and exactly preserves original image bytes',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try{Object.defineProperty(globalThis,'crypto',{value:{},configurable:true});
 for(const text of ['abc','한글💗','x'.repeat(100000),Array.from({length:256},(_,i)=>String.fromCharCode(i)).join('')]){
  const f=fixture();const url=await f.assets.putText(text);assert.ok(url.includes(createHash('sha256').update(text).digest('hex')));
 }
 const f=fixture(),raw=Buffer.from([0,1,2,255,123,44]);const url=await f.assets.image('data:image/png;base64,'+raw.toString('base64'));
 assert.deepEqual(f.files.get(url),raw);await f.assets.remove(url);assert.equal(f.files.size,0);
 }finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else globalThis.crypto=webcrypto;}
});
