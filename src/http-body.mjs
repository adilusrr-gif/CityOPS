const policies=new WeakMap(),pending=new WeakMap();
export function setBodyPolicy(req,policy){policies.set(req,policy);}
function bodyError(message,status){return Object.assign(new Error(message),{status,closeConnection:true});}
export function readJson(req){
 if(pending.has(req))return pending.get(req);
 const {maxBytes=64*1024,timeoutMs=15000}=policies.get(req)||{};
 const result=new Promise((resolve,reject)=>{
  let total=0,chunks=[],settled=false,timer;
  const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
  const finish=(failure,value)=>{if(settled)return;settled=true;cleanup();chunks=[];if(failure){req.pause();reject(failure);}else resolve(value);};
  const error=()=>finish(bodyError('Передача запроса прервана',400));
  const aborted=()=>finish(bodyError('Передача запроса прервана',400));
  const data=chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;if(total>maxBytes){finish(bodyError('Запрос слишком большой',413));return;}chunks.push(bytes);};
  const end=()=>{let value;try{value=JSON.parse(Buffer.concat(chunks,total).toString('utf8')||'{}');}catch{finish(bodyError('Некорректный JSON',400));return;}if(!value||Array.isArray(value)||typeof value!=='object'){finish(bodyError('Ожидается JSON-объект',400));return;}finish(null,value);};
  const length=req.headers?.['content-length'],encoding=req.headers?.['content-encoding'];
  if(encoding&&encoding!=='identity'){finish(bodyError('Сжатое тело запроса не поддерживается',415));return;}
  if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length)))){finish(bodyError('Некорректная длина запроса',400));return;}
  if(Number(length)>maxBytes){finish(bodyError('Запрос слишком большой',413));return;}
  if(req.aborted||req.destroyed){aborted();return;}
  timer=setTimeout(()=>finish(bodyError('Истекло время передачи запроса',408)),timeoutMs);timer.unref?.();
  req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
  if(req.readableEnded)end();
 });
 pending.set(req,result);return result;
}
