export function normalizeArchitecture(value){
 if(typeof value!=='string')return null;
 const arch=value.trim().toLowerCase();
 return ['x64','x86_64','amd64'].includes(arch)?'x64':['arm64','aarch64'].includes(arch)?'arm64':null;
}

export const BEDROCK_PLATFORM_MESSAGE=Object.freeze({
 id:'panel.runtime.bedrock-platform',
 en:'Bedrock needs Linux x86-64, or an ARM64 node with the managed Box64 runtime installed.',
 vi:'Bedrock cần Linux x86-64 hoặc VPS ARM64 đã cài môi trường Box64 do Vortex quản lý.',
});

export function bedrockRuntimeSupport({platform,arch}={}){
 const architecture=normalizeArchitecture(arch),supported=platform==='linux'&&architecture==='x64';
 return {supported,platform:typeof platform==='string'?platform:null,arch:architecture,hostArch:architecture,guestArch:'x64',mode:supported?'native':null,engine:supported?'native':null,engineVersion:null,reason:supported?null:BEDROCK_PLATFORM_MESSAGE.vi,reasonI18n:supported?null:BEDROCK_PLATFORM_MESSAGE};
}
