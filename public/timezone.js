// Main VPS timezone is authoritative for panel display. UTC timestamps and
// interval schedules remain unchanged; this module only formats instants.
const cacheKey='vortex-panel-timezone',formatters=new Map();
function valid(value){if(typeof value!=='string'||!value||value.length>128)return false;try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}}
let timezone='UTC';
try{const cached=globalThis.localStorage?.getItem(cacheKey);if(valid(cached))timezone=cached;}catch{}
export const getPanelTimezone=()=>timezone;
export function setPanelTimezone(value){
 if(!valid(value))return false;
 const changed=timezone!==value;timezone=value;
 try{globalThis.localStorage?.setItem(cacheKey,value);}catch{}
 if(changed){formatters.clear();if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('vortex:timezonechange',{detail:{timezone:value}}));}
 return true;
}
export function formatPanelDate(value,locale='en-US',options={}){
 const instant=value instanceof Date?value:new Date(value);if(!Number.isFinite(instant.getTime()))return '—';
 const settings={...options,timeZone:timezone},key=JSON.stringify([locale,settings]);
 if(!formatters.has(key)){if(formatters.size>=64)formatters.clear();formatters.set(key,new Intl.DateTimeFormat(locale,settings));}
 return formatters.get(key).format(instant);
}
