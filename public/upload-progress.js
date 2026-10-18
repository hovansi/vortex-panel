import {wireText,getLanguage} from './i18n.js';
export function uploadWithProgress(path,body,{csrfToken,onProgress=()=>{},onUnauthorized=()=>{}}={}){
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open('POST',`/api${path}`);request.withCredentials=true;
    request.setRequestHeader('Accept-Language',getLanguage());if(csrfToken)request.setRequestHeader('X-CSRF-Token',csrfToken);
    request.upload.onprogress=event=>onProgress({loadedBytes:event.loaded,totalBytes:event.lengthComputable?event.total:null,percent:event.lengthComputable?Math.min(100,Math.floor(event.loaded/event.total*100)):null,processing:false});
    request.upload.onload=()=>onProgress({loadedBytes:null,totalBytes:null,percent:null,processing:true});
    request.onerror=()=>reject(new Error(wireText('Upload connection failed.',{en:'Upload connection failed.',vi:'Kết nối tải lên thất bại.'})));
    request.onabort=()=>reject(new Error(wireText('Upload cancelled.',{en:'Upload cancelled.',vi:'Đã hủy tải lên.'})));
    request.onload=()=>{
      let data;try{data=JSON.parse(request.responseText);}catch{data={error:`HTTP ${request.status}`};}
      if(request.status>=200&&request.status<300)resolve(data);else{if(request.status===401)onUnauthorized();const error=new Error(wireText(data.error,data.errorI18n)||`HTTP ${request.status}`);error.status=request.status;reject(error);}
    };
    request.send(body);
  });
}
