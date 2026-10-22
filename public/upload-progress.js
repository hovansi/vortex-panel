import {wireText,getLanguage} from './i18n.js';

export function uploadWithProgress(path,body,{csrfToken,signal,onProgress=()=>{},onUnauthorized=()=>{},idleTimeoutMs=120000,processingTimeoutMs=600000}={}){
  return new Promise((resolve,reject)=>{
    let request,timer,settled=false,phase='upload',lastLoaded=0;
    const duration=(value,fallback)=>Number.isFinite(value)&&value>0?Math.min(value,2147483647):fallback;
    const issue=(message,vi,code)=>Object.assign(new Error(wireText(message,{en:message,vi})),{code,phase,...(phase==='processing'?{outcomeUnknown:true}:{})});
    const cancelled=()=>Object.assign(issue('Upload cancelled.','Đã hủy tải lên.','UPLOAD_CANCELLED'),{name:'AbortError'});
    const timedOut=()=>phase==='processing'
      ?issue('Upload sent, but the panel did not finish processing in time. Check the server before trying again.','Đã gửi tệp, nhưng panel chưa xử lý xong trong thời gian chờ. Kiểm tra máy chủ trước khi thử lại.','UPLOAD_TIMEOUT')
      :issue('Upload stalled. Check your connection and try again.','Tải lên bị gián đoạn. Kiểm tra kết nối và thử lại.','UPLOAD_TIMEOUT');
    const cleanup=()=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(request){request.onload=request.onerror=request.onabort=request.ontimeout=null;request.upload.onprogress=request.upload.onload=null;}
    };
    const finish=(error,data)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(data);};
    const stop=error=>{if(settled)return;finish(error);try{request?.abort();}catch{}};
    const abort=()=>stop(cancelled());
    const watch=timeout=>{clearTimeout(timer);timer=setTimeout(()=>stop(timedOut()),timeout);};
    const progressFailed=error=>stop(error instanceof Error?error:new Error(String(error)));
    const progress=value=>{try{const result=onProgress(value);if(result&&typeof result.then==='function')Promise.resolve(result).catch(progressFailed);}catch(error){progressFailed(error);}};
    if(signal?.aborted){finish(cancelled());return;}
    try{
      request=new XMLHttpRequest();request.open('POST',`/api${path}`);request.withCredentials=true;
      request.setRequestHeader('Accept-Language',getLanguage());if(csrfToken)request.setRequestHeader('X-CSRF-Token',csrfToken);
      request.upload.onprogress=event=>{
        if(settled||phase!=='upload')return;
        if(Number.isFinite(event.loaded)&&event.loaded>lastLoaded){lastLoaded=event.loaded;watch(duration(idleTimeoutMs,120000));}
        const total=event.lengthComputable&&event.total>0?event.total:null;
        progress({loadedBytes:event.loaded,totalBytes:total,percent:total===null?null:Math.min(100,Math.floor(event.loaded/total*100)),processing:false});
      };
      request.upload.onload=()=>{
        if(settled||phase!=='upload')return;
        phase='processing';watch(duration(processingTimeoutMs,600000));
        progress({loadedBytes:null,totalBytes:null,percent:null,processing:true});
      };
      request.onerror=()=>finish(issue('Upload connection failed.','Kết nối tải lên thất bại.','UPLOAD_CONNECTION_FAILED'));
      request.onabort=()=>finish(cancelled());request.ontimeout=()=>stop(timedOut());
      request.onload=()=>{
        if(settled)return;
        let data;try{data=JSON.parse(request.responseText);}catch{}
        const valid=data!==null&&typeof data==='object'&&!Array.isArray(data);
        if(request.status>=200&&request.status<300){
          if(!valid){const error=issue('The panel returned an invalid upload response. Check the server before trying again.','Panel trả về phản hồi tải lên không hợp lệ. Kiểm tra máy chủ trước khi thử lại.','UPLOAD_RESPONSE_INVALID');error.status=request.status;error.outcomeUnknown=true;finish(error);}
          else finish(null,data);
          return;
        }
        const error=new Error(valid&&wireText(data.error,data.errorI18n)||`HTTP ${request.status}`);error.status=request.status;
        if(valid){if(typeof data.code==='string')error.code=data.code;if(data.errorI18n)error.errorI18n=data.errorI18n;if(data.outcomeUnknown===true)error.outcomeUnknown=true;}
        // Session teardown may abort transfers; preserve this HTTP error first.
        const unauthorized=request.status===401;finish(error);if(unauthorized){try{Promise.resolve(onUnauthorized()).catch(()=>{});}catch{}}
      };
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      watch(duration(idleTimeoutMs,120000));request.send(body);
    }catch(error){stop(error);}
  });
}
