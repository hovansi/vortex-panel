import {wireText,uiHTML,uiText,formatUI} from './i18n.js';
import {beginButtonBusy} from './button-busy.js';
import {formatPanelDate} from './timezone.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const manifests=new Set(['package.json','package-lock.json','npm-shrinkwrap.json','requirements.txt']);
const lockfiles=new Set(['package-lock.json','npm-shrinkwrap.json']);
const detailKeys=new Set([...manifests,'packages']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const dependencyLabels={installed:['Manifest unchanged since install','Tệp khai báo chưa đổi sau lần cài'], 'not-installed':['No recorded installation','Chưa có lần cài được ghi nhận'],unknown:['Not verified','Chưa xác minh'],outdated:['Manifest changed · reinstall','Tệp khai báo đã đổi · cần cài lại']};
const projectStopped=server=>server.status==='stopped'&&!server.busy&&!server.recoveryRequired&&server.nodeOnline!==false;
const sampled=project=>typeof project?.inspectedAt==='string'&&Number.isFinite(Date.parse(project.inspectedAt));
const lifecycle=server=>JSON.stringify([server.status,!!server.busy,!!server.recoveryRequired,server.nodeOnline===false,server.consoleRunId??null]);

function projectFreshnessMarkup(project,server,cached=false){
 if(!project||!Array.isArray(project.manifests))return'';
 const hasSample=sampled(project),stopped=projectStopped(server),stale=cached||project.inspectionAvailable===false||!stopped;
 let label=hasSample?text('Inspected','Đã kiểm tra'):null;
 if(stale&&stopped)label=hasSample?text('Cached inspection. Refresh to inspect the current project files and installed package metadata.','Kết quả kiểm tra đã lưu. Làm mới để kiểm tra tệp dự án và thông tin gói hiện tại.'):text('Refresh to inspect project files and installed package metadata.','Làm mới để kiểm tra tệp dự án và thông tin gói đã cài.');
 else if(stale)label=hasSample?text('Last inspected while stopped. Stop the application and refresh to inspect its current files.','Lần kiểm tra trước khi chạy. Dừng ứng dụng và làm mới để kiểm tra tệp hiện tại.'):text('Stop the application to inspect project files and installed package metadata.','Dừng ứng dụng để kiểm tra tệp dự án và thông tin gói đã cài.');
 return label?`<p class="application-project-freshness${stale?' is-cached':''}">${escape(label)}${hasSample?` <time datetime="${escape(project.inspectedAt)}">${escape(formatUI(project.inspectedAt,(locale,value)=>formatPanelDate(value,locale,{dateStyle:'short',timeStyle:'medium'})))}</time>`:''}</p>`:'';
}

export function projectFileName(value){if(!manifests.has(value))throw Error(text('Choose a project manifest from this workspace.','Chọn tệp khai báo của dự án trong workspace này.'));return value;}
export const projectManifestCanCreate=name=>manifests.has(name)&&!lockfiles.has(name);
export function projectManifestTemplate(name){projectFileName(name);if(!projectManifestCanCreate(name))throw Error(text('Generate lockfiles with the project package manager.','Tạo tệp khóa bằng công cụ quản lý gói của dự án.'));return name==='package.json'?JSON.stringify({private:true,scripts:{start:'node server.js'},dependencies:{}},null,2)+'\n':'# Add Python package requirements here, one per line.\n';}

export function applicationProjectMarkup(data,{icon=()=>'',canManage=()=>false}={}){
 const server=data.server,project=data.project,stopped=projectStopped(server),editable=stopped&&canManage(server);
 const head=`<div class="application-project-heading"><div><h3>${escape(text('Project & packages','Dự án & các gói thư viện'))}</h3></div><button type="button" class="icon-button" data-app-project-refresh aria-label="${escape(text('Refresh project inspection','Làm mới kiểm tra dự án'))}" ${server.nodeOnline===false?'disabled':''}>${icon('refresh')}</button></div>`;
 const freshness=`<div data-app-project-freshness>${projectFreshnessMarkup(project,server)}</div>`;
 if(!project||!Array.isArray(project.manifests))return`${head}${freshness}<p class="application-project-unavailable">${escape(text('Project inspection is unavailable on this node. Update its agent to inspect manifests and installed packages here.','VPS này chưa hỗ trợ kiểm tra dự án. Cập nhật agent để xem tệp khai báo và các gói đã cài tại đây.'))}</p><p data-app-project-message role="status"></p>`;
 const runtime=project.runtime||server.runtime,state=project.dependencyState||{},status=dependencyLabels[state.status]||dependencyLabels.unknown,reportedPackages=Array.isArray(project.packages)?project.packages.filter(row=>row&&typeof row.name==='string'&&typeof row.version==='string'):[],packages=reportedPackages.slice(0,200),uiTruncated=reportedPackages.length>packages.length;
 const fact=(label,value)=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
 const runtimeMarkup=runtime?`<dl class="application-project-facts">${fact(text('Runtime policy','Chính sách môi trường'),runtime.mode==='managed'?text('Pinned official runtime','Ghim môi trường chính thức'):text('Host runtime · legacy application','Môi trường host · ứng dụng cũ'))}${typeof runtime.version==='string'?fact(runtime.mode==='managed'?text('Pinned version','Phiên bản đã ghim'):text('Host version','Phiên bản host'),runtime.version):''}${typeof runtime.source==='string'?fact(text('Source','Nguồn'),runtime.source):''}${runtime.method?fact(text('Installation method','Cách cài'),runtime.method==='official-source'?text('Official source build','Biên dịch nguồn chính thức'):runtime.method==='official-binary'?text('Official binary package','Gói binary chính thức'):runtime.method):''}</dl>`:'';
 const manifestMarkup=project.manifests.filter(row=>row&&manifests.has(row.name)).map(row=>{
  const scripts=Array.isArray(row.scripts)?row.scripts.filter(script=>script&&typeof script.name==='string'&&typeof script.command==='string').slice(0,64):[];
  return`<article class="application-manifest"><div class="application-manifest-heading"><span aria-hidden="true">${icon('file')}</span><div><strong>${escape(row.name)}</strong><small>${escape(row.present===true?text('Present in project','Có trong dự án'):text('Not found','Chưa có tệp'))}${row.packageManager?` · ${escape(row.packageManager)}`:''}</small></div><button type="button" class="btn text" data-app-project-file="${escape(row.name)}" data-present="${row.present===true}" ${editable&&(row.present===true||projectManifestCanCreate(row.name))?'':'disabled'}>${icon(row.present===true?'sliders':'plus')}<span>${escape(row.present===true?text('Edit file','Sửa tệp'):text('Create file','Tạo tệp'))}</span></button></div>${row.present===true?`<div class="application-manifest-counts">${integer(row.dependencies)?`<span>${row.dependencies} ${escape(text('dependencies','thư viện'))}</span>`:''}${integer(row.devDependencies)?`<span>${row.devDependencies} ${escape(text('development dependencies','thư viện phát triển'))}</span>`:''}</div>`:''}${scripts.length?`<details class="application-project-scripts" data-app-project-details="${escape(row.name)}"><summary>${escape(text('Package scripts','Các script của gói'))} <span>${scripts.length}</span></summary><dl>${scripts.map(script=>`<div><dt>${escape(script.name)}</dt><dd><code>${escape(script.command)}</code></dd></div>`).join('')}</dl></details>`:''}</article>`;
 }).join('');
 const installed=`<div class="application-installed-state"><span class="application-installation-label">${escape(text('Last installation','Lần cài gần nhất'))}</span><span class="badge ${state.status==='installed'?'':'neutral'}">${escape(text(...status))}</span>${state.manifest?`<code>${escape(state.manifest)}</code>`:''}${typeof state.installedAt==='string'&&Number.isFinite(Date.parse(state.installedAt))?`<time datetime="${escape(state.installedAt)}">${escape(formatUI(state.installedAt,(locale,value)=>formatPanelDate(value,locale,{dateStyle:'short',timeStyle:'medium'})))}</time>`:''}</div>`;
 const packageMarkup=packages.length?`<details class="application-package-list" data-app-project-details="packages"><summary>${escape(text('Installed package metadata','Thông tin các gói đã cài'))}<span>${packages.length}${uiTruncated?` / ${reportedPackages.length}${project.packagesTruncated===true?'+':''}`:project.packagesTruncated===true?'+':''}</span></summary><dl>${packages.map(row=>`<div><dt>${escape(row.name)}</dt><dd>${escape(row.version)}</dd></div>`).join('')}</dl>${uiTruncated?`<p>${escape(text(`Showing ${packages.length} of ${reportedPackages.length} reported package records.`,`Hiển thị ${packages.length} trong ${reportedPackages.length} bản ghi gói đã báo cáo.`))}</p>`:''}${project.packagesTruncated===true?`<p>${escape(text('This bounded inspection omits additional package records.','Lần kiểm tra có giới hạn này không hiển thị các gói còn lại.'))}</p>`:''}</details>`:`<p class="application-empty-note">${escape(text('No installed package information available.','Chưa có thông tin các gói đã cài.'))}</p>`;
 return`${head}${freshness}${runtimeMarkup}<div class="application-project-manifests">${manifestMarkup}</div>${installed}${packageMarkup}<p data-app-project-message role="status"></p>`;
}

export function bindApplicationProject(panel,data,context){
 const root=panel.querySelector('[data-app-project]');if(!root)return{sync(){},destroy(){}};
 let disposed=false,working=false,latest=data,cached=data.project?.inspectionAvailable===false,observed=lifecycle(data.server),epoch=0,freshnessSignature=null;
 const current=()=>!disposed&&panel.isConnected&&(!context.isCurrent||context.isCurrent());
 const actual=()=>context.findServer?.(data.server.id)||latest.server;
 const observe=()=>{const server=actual(),next=lifecycle(server);if(next!==observed){observed=next;epoch++;cached=true;}if(!projectStopped(server))cached=true;return server;};
 const editable=()=>{const server=actual();return context.canManage(server)&&projectStopped(server);};
 const sync=()=>{
  if(!current())return;
  const server=observe(),slot=root.querySelector('[data-app-project-freshness]'),markup=projectFreshnessMarkup(latest.project,server,cached);
  if(slot&&markup!==freshnessSignature){uiHTML(slot,markup);freshnessSignature=markup;}
  for(const button of root.querySelectorAll('[data-app-project-file]'))button.disabled=working||!editable()||!projectManifestCanCreate(button.dataset.appProjectFile)&&button.dataset.present!=='true';
  const refresh=root.querySelector('[data-app-project-refresh]');if(refresh)refresh.disabled=working||server.nodeOnline===false;
 };
 const refresh=async()=>{
  if(!current())return;
  observe();const requestEpoch=epoch;cached=true;sync();
  const result=await context.api(`/servers/${encodeURIComponent(data.server.id)}/application`);
  if(result?.server?.id!==data.server.id||result?.server?.kind!==data.server.kind)throw Error(text('Project identity changed. Reload this workspace.','Định danh dự án đã đổi. Tải lại workspace.'));
  if(!current())return;
  const server=observe();cached=!(result.project?.inspectionAvailable===true&&sampled(result.project)&&projectStopped(result.server)&&projectStopped(server)&&epoch===requestEpoch);
  const expanded=new Set([...root.querySelectorAll('details[data-app-project-details]')].filter(detail=>detail.open&&detailKeys.has(detail.dataset.appProjectDetails)).map(detail=>detail.dataset.appProjectDetails));
  latest=result;uiHTML(root,applicationProjectMarkup(result,context));
  for(const detail of root.querySelectorAll('details[data-app-project-details]'))if(detailKeys.has(detail.dataset.appProjectDetails))detail.open=expanded.has(detail.dataset.appProjectDetails);
  freshnessSignature=null;sync();
 };
 const click=async event=>{
  const button=event.target.closest('[data-app-project-file],[data-app-project-refresh]');if(!button||!root.contains(button)||button.disabled||working||!current())return;
  working=true;sync();const finish=beginButtonBusy(button);
  try{if(button.hasAttribute('data-app-project-refresh'))await refresh();else{if(!editable())return;const name=projectFileName(button.dataset.appProjectFile),row=latest.project?.manifests?.find(row=>row.name===name);if(!row)throw Error(text('Refresh the project before opening this file.','Làm mới dự án trước khi mở tệp này.'));await context.editProjectFile?.(name,row.present===true,refresh);}}
  catch(error){if(current())uiText(root.querySelector('[data-app-project-message]'),error.message);}
  finally{finish();working=false;if(current())sync();}
 };
 root.addEventListener('click',click);sync();return{sync,destroy(){disposed=true;root.removeEventListener('click',click);}};
}
