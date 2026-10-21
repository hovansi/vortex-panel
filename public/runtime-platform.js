export function normalizeArchitecture(value){
 if(typeof value!=='string')return null;
 const arch=value.trim().toLowerCase();
 return ['x64','x86_64','amd64'].includes(arch)?'x64':['arm64','aarch64'].includes(arch)?'arm64':null;
}

export const BEDROCK_PLATFORM_MESSAGE=Object.freeze({
 id:'panel.runtime.bedrock-platform',
 en:'Official Bedrock requires a Linux x86-64 node. Choose an x64 node, or use Node.js/Python on ARM.',
 vi:'Bedrock chính thức cần VPS Linux x86-64. Chọn VPS x64, hoặc dùng Node.js/Python trên ARM.',
});

export function bedrockRuntimeSupport({platform,arch}={}){
 const architecture=normalizeArchitecture(arch),supported=platform==='linux'&&architecture==='x64';
 return {supported,platform:typeof platform==='string'?platform:null,arch:architecture,reason:supported?null:BEDROCK_PLATFORM_MESSAGE.vi,reasonI18n:supported?null:BEDROCK_PLATFORM_MESSAGE};
}
