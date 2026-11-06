import { districts,districtById,worldMap,toWorld,paths,findPath,type Point } from './map';
import type { CameraMode,Evidence,WeddingEvent,WorldState,District,GuestGender } from './types';
import { GardenScene } from './scene';
import { WorldConnection } from './network';
import { GuestPreview,clothingColors } from './avatar-model';
import { download,renderCertificate,saveEvidence,savePDF,verifyEvidence } from './certificate';

const h=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icons:Record<string,string>={
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z"/><path d="M9 3v16M15 5v16"/>',
  compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/>',
  pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
  heart:'<path d="M20 5c-2-2-6-1-8 2-2-3-6-4-8-2-4 4 1 10 8 15 7-5 12-11 8-15Z"/>',
  camera:'<path d="m8 5 2-2h4l2 2h4a2 2 0 0 1 2 2v12H2V7a2 2 0 0 1 2-2h4Z"/><circle cx="12" cy="12" r="4"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  grid:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  follow:'<circle cx="12" cy="6" r="3"/><path d="m8 21 2-7-4-2 3-3m7 12-2-7 4-2-3-3M4 18l-2 3h20l-2-3"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  sound:'<path d="m11 4-6 4H2v8h3l6 4V4Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 18"/>',
  mute:'<path d="m11 4-6 4H2v8h3l6 4V4Zm5 5 6 6m-6 0 6-6"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  share:'<circle cx="18" cy="4" r="3"/><circle cx="5" cy="12" r="3"/><circle cx="18" cy="20" r="3"/><path d="m8 11 7-5M8 13l7 5"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  flower:'<path d="M12 12c-9 2-10-7-5-7 0-6 10-6 10 0 5 0 4 9-5 7Zm0 0c8 4 4 12 0 7-4 5-8-3 0-7Z"/><circle cx="12" cy="11" r="2"/>',
  door:'<path d="M3 21h18M6 21V3h12v18M10 21V6l8-3M14 13h.1"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .4-1 1-1 2m0 3h.01"/>',
};
export const icon=(name:string)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.flower}</svg>`;
const rings='<svg class="brand-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><ellipse cx="16" cy="24" rx="9" ry="13" transform="rotate(-28 16 24)" stroke="currentColor" stroke-width="1.6"/><ellipse cx="28" cy="24" rx="9" ry="13" transform="rotate(28 28 24)" stroke="currentColor" stroke-width="1.6"/><path d="m22 3 2.7 4.5-2.7 4.5-2.7-4.5L22 3Z" fill="currentColor"/></svg>';
const stateLabel=(state:string)=>({QUEUED:'In the wedding queue',VENUE_ASSIGNED:'Your venue is ready',READY_CHECK:'It’s almost your moment',CEREMONY_ACTIVE:'A ceremony in progress'}[state]||state);
const slotLabel=(d:District)=>`${Math.round((120+d.program.reduce((sum,p)=>sum+p.duration,0))/60)} minute slot`;

export class WorldUI {
  state:WorldState|null=null;
  private invitation:WeddingEvent|null=null;
  private invitationSlug:string|undefined;
  private selectedAvatar=0;
  private selectedGender:GuestGender='female';
  private selectedClothingColor=clothingColors[0];
  private colorCustomized=false;
  private toastTimer=0;
  private modalKind='';
  private directoryFilter='all';
  private renderingKey='';
  private certificate:HTMLCanvasElement|null=null;
  private evidence:Evidence|null=null;
  private audio:AudioContext|null=null;
  private audioTimer=0;
  private sound=false;
  private entered=false;
  private connecting=false;
  private filtersRendered=false;
  private resumeInvitation=false;
  private guestPreview:GuestPreview;
  private stopJoystick=()=>{};
  private directoryOpener:HTMLElement|null=null;

  constructor(private root:HTMLElement,public scene:GardenScene,public connection:WorldConnection){
    this.root.insertAdjacentHTML('beforeend',this.shell());
    this.guestPreview=new GuestPreview(this.$<HTMLCanvasElement>('#avatar-preview'));
    this.root.addEventListener('click',event=>{
      const button=(event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if(button)this.action(button).catch(error=>this.toast(error.message));
    });
    this.root.addEventListener('submit',event=>{event.preventDefault();this.submit(event.target as HTMLFormElement).catch(error=>this.toast(error.message));});
    this.root.addEventListener('input',event=>this.input(event));
    this.$<HTMLDialogElement>('#modal').addEventListener('close',()=>{this.modalKind='';this.resetMovement();this.scene.controlsEnabled=this.$('#directory-drawer').hidden;});
    this.$('#drawer-close').addEventListener('click',()=>this.closeDirectory());
    document.addEventListener('keydown',e=>{if(e.code==='Escape'){this.closeDirectory();this.setPhotoMode(false);this.setCameraMenu(false);}});
    connection.addEventListener('state',event=>this.update((event as CustomEvent<WorldState>).detail));
    connection.addEventListener('connected',()=>{this.connecting=false;this.entered=true;this.root.classList.add('in-world');this.guestPreview.setPaused(true);this.scene.activate();this.$('#connection-status').textContent='Connected';this.$('#connection-status').classList.remove('offline');this.$('#reconnect-banner').hidden=true;
      if(this.resumeInvitation&&this.invitation){this.resumeInvitation=false;this.connection.command('watch',{eventId:this.invitation.id}).catch(error=>this.toast(error.message));}
    });
    connection.addEventListener('disconnected',()=>{if(this.entered){this.$('#connection-status').textContent='Reconnecting';this.$('#connection-status').classList.add('offline');this.$('#reconnect-banner').hidden=false;}else{this.$('#entry-error').textContent='The garden could not be reached. Check the server and try again.';this.connecting=false;this.$<HTMLButtonElement>('#enter-button').disabled=false;}});
    connection.addEventListener('session_expired',e=>{this.root.classList.remove('in-world');this.setPhotoMode(false);this.guestPreview.setPaused(false);this.scene.active=false;this.scene.resize();this.toast((e as CustomEvent).detail);this.$<HTMLButtonElement>('#enter-button').disabled=false;this.$('#resume-invitation').hidden=true;this.entered=false;this.resumeInvitation=false;this.connection.intentionalClose=false;});
    connection.addEventListener('notice',e=>this.toast((e as CustomEvent).detail));
    connection.addEventListener('completion',e=>this.receiveEvidence((e as CustomEvent<Evidence>).detail));
    scene.addEventListener('notice',e=>this.toast((e as CustomEvent).detail));
    scene.addEventListener('interact',()=>this.plan());
    scene.addEventListener('program',e=>this.program((e as CustomEvent<string>).detail));
    scene.addEventListener('camera',e=>this.updateCamera((e as CustomEvent<CameraMode>).detail));
    scene.addEventListener('navigation',e=>{const detail=(e as CustomEvent).detail;this.$('#navigation').hidden=false;this.$('#navigation-title').textContent=detail.name;});
    scene.addEventListener('navigation_end',()=>this.$('#navigation').hidden=true);
    this.setupJoystick();
    if(matchMedia('(max-width:760px)').matches)this.$<HTMLDetailsElement>('#moment-card').open=false;
    this.$('#directory-drawer').addEventListener('keydown',e=>{
      if(e.key!=='Tab')return;
      const items=Array.from(this.$('#directory-drawer').querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select'));
      const first=items[0],last=items.at(-1);
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    });
    window.setInterval(()=>this.tick(),200);
    this.loadInvitation();
    this.updateCamera('THIRD_PERSON');
  }
  private $<T extends HTMLElement=HTMLElement>(selector:string):T{return this.root.querySelector<T>(selector)!;}
  private shell(){return `
    <div class="landing" id="landing">
      <header class="landing-header"><a class="brand" href="/" aria-label="Wedding World home">${rings}<span>Wedding World</span></a>
        <nav aria-label="Welcome navigation"><button class="text-button" data-action="world-guide">The world</button><button class="text-button" data-action="guide">How to play</button><button class="sound-button" data-action="sound" aria-label="Turn sound on">${icon('mute')}<span>Sound off</span></button></nav></header>
      <section class="welcome-copy" aria-labelledby="welcome-heading"><p class="welcome-note"><span class="small-flower">✳</span> A place to celebrate being together</p>
        <h1 id="welcome-heading">A little world.<br>A moment<br>together.</h1>
        <p class="welcome-description" id="welcome-description">Wander through five wedding gardens.<br>Bring your favorite person. Stay for the joy.</p>
        <div class="invitation-actions" id="invitation-actions" hidden><button class="text-button" data-action="copy-link">${icon('copy')}Copy invitation</button><button class="text-button" data-action="device-share">${icon('share')}Share</button></div>
        <form id="enter-form"><button type="button" class="secondary resume-session" id="resume-invitation" data-action="resume-invitation" hidden>Join with my current guest ${icon('arrow')}</button><label for="nickname" id="nickname-label">What should we call you?</label><div class="entry-input-wrap"><input id="nickname" name="nickname" required minlength="2" maxlength="24" placeholder="Your temporary nickname" autocomplete="off" spellcheck="false" aria-describedby="entry-privacy entry-error"/><span>${icon('flower')}</span></div>
          <div class="guest-customizer"><div class="guest-preview"><canvas id="avatar-preview" width="192" height="240" aria-label="Live preview of your guest"></canvas><span id="outfit-caption">Váy xếp nếp · Nữ</span></div><div class="guest-options"><fieldset class="gender-picker"><legend>Nhân vật của bạn</legend><div class="gender-choices"><button type="button" data-action="gender" data-gender="female" aria-pressed="true">Nữ <span>Váy</span></button><button type="button" data-action="gender" data-gender="male" aria-pressed="false">Nam <span>Vest</span></button></div></fieldset><fieldset class="avatar-picker"><legend>Màu trang phục</legend><div class="avatar-swatches">${['Ivory','Rose','Honey','Navy','Lavender','Sage'].map((name,i)=>`<button type="button" class="avatar-color ${i===0?'selected':''}" style="--avatar-color:${clothingColors[i]}" data-action="avatar" data-avatar="${i}" aria-label="${name} avatar" aria-pressed="${i===0}"><span>${i===0?icon('check'):''}</span></button>`).join('')}</div><label class="custom-clothing-color" for="clothing-color"><input id="clothing-color" type="color" value="${clothingColors[0]}"/><span>Chọn màu khác</span></label></fieldset></div></div>
          <button type="submit" class="primary enter-button" id="enter-button"><span id="enter-label">Enter the world</span>${icon('arrow')}</button><p id="entry-error" class="form-error" role="alert"></p>
        </form><p class="privacy-note" id="entry-privacy">No account. No forever profile. Just this moment.</p>
      </section>
      <aside class="place-note" aria-label="Garden preview"><span class="place-flower">${icon('flower')}</span><div><span id="preview-native">Việt Nam</span><h2 id="preview-place">The riverside courtyard</h2><p id="preview-description">Red silk. Still water. Warm wishes.</p></div></aside>
      <footer class="landing-footer"><div class="garden-tabs" role="group" aria-label="Preview a district">${districts.map((d,i)=>`<button data-action="preview-district" data-district="${d.id}" class="garden-tab ${i===0?'selected':''}" aria-pressed="${i===0}"><span class="district-dot" style="--district-color:${d.color}"></span>${d.name}</button>`).join('')}</div><p>Five gardens. One connected world.</p></footer>
      <div class="world-loading" id="world-loading">Growing the gardens<span></span></div>
    </div>
    <div class="game-hud" id="game-hud">
      <header class="game-header"><a class="brand compact" href="/" aria-label="Wedding World">${rings}<span>Wedding World</span></a><div class="location-pill">${icon('pin')}<div><strong id="location-name">Meeting Plaza</strong><span id="connection-status">Connecting</span></div></div>
        <nav aria-label="World navigation"><button class="hud-button" data-action="directory" aria-label="Weddings">${icon('people')}<span>Weddings</span><span class="count" id="wedding-count">0</span></button><button class="hud-button plan-button" data-action="plan" aria-label="Plan a wedding">${icon('heart')}<span>Plan a wedding</span></button><button class="icon-button" data-action="guide" aria-label="How to play">${icon('help')}</button><button class="icon-button sound-button" data-action="sound" aria-label="Turn sound on">${icon('mute')}</button></nav></header>
      <div id="reconnect-banner" class="reconnect-banner" role="status" hidden>Reconnecting to the world. Movement and ceremony actions will resume after a fresh server snapshot.</div>
      <div class="guest-strip"><span class="presence-dot"></span><span id="guest-count">0 guests</span><span class="guest-separator"></span><button data-action="copy-code" class="text-button" aria-label="Copy your temporary guest code"><span id="guest-name"></span><span class="code" id="guest-code"></span>${icon('copy')}</button></div>
      <details class="moment-card" id="moment-card" open><summary>${icon('flower')}<span id="moment-summary">Your next moment</span><span class="expand-symbol">+</span></summary><section class="moment-panel" id="moment-panel" aria-label="Your next moment"></section></details>
      <section class="consent-panel" id="consent-panel" aria-live="polite"></section>
      <aside class="minimap-wrap"><button class="minimap" data-action="map" aria-label="Open world map">${this.mapSVG('mini')}<span class="map-caption">${icon('compass')}<span>The wedding park</span>${icon('map')}</span></button><p class="movement-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>or click a path to walk</span></p></aside>
      <div class="navigation" id="navigation" hidden>${icon('pin')}<div><strong id="navigation-title"></strong><span id="navigation-distance"></span></div><button data-action="stop-walking" aria-label="Stop walking" class="icon-button">${icon('close')}</button></div>
      <div class="bottom-controls"><div class="camera-controls" id="camera-menu" role="group" aria-label="Camera mode" hidden>${[['THIRD_PERSON','follow','Follow camera'],['FIRST_PERSON','eye','First person camera'],['ISOMETRIC','grid','Isometric camera'],['CINEMATIC_SPECTATOR','camera','Ceremony spectator camera']].map(([mode,symbol,label])=>`<button class="camera-button" data-action="camera" data-mode="${mode}" aria-label="${label}" aria-pressed="${mode==='THIRD_PERSON'}" title="${label}">${icon(symbol)}<span>${label.replace(' camera','')}</span></button>`).join('')}<button class="camera-button" data-action="settings" aria-label="Camera settings">${icon('settings')}<span>Settings</span></button></div><button class="camera-toggle" data-action="camera-menu" aria-label="Camera controls" aria-expanded="false" aria-controls="camera-menu">${icon('follow')}<span id="camera-caption">Follow camera</span>${icon('settings')}</button></div>
      <div class="social-controls"><button class="round-button" data-action="emotes" aria-label="Choose a gesture" title="Gestures">${icon('flower')}</button><button class="round-button" data-action="photo-mode" aria-label="Open photo mode" title="Photo mode">${icon('camera')}</button><button class="round-button keepsake-button" data-action="keepsake" aria-label="Open your received keepsake" title="Your keepsake" hidden>${icon('heart')}</button></div>
      <div class="joystick" id="joystick" role="group" aria-label="Touch movement joystick"><div class="joystick-knob" id="joystick-knob"></div></div>
      <div class="mobile-move" role="group" aria-label="Movement buttons"><button data-move="0,-1" aria-label="Walk forward">↑</button><button data-move="-1,0" aria-label="Walk left">←</button><button data-move="0,1" aria-label="Walk backward">↓</button><button data-move="1,0" aria-label="Walk right">→</button></div>
      <div class="emote-menu" id="emote-menu" hidden>${[['wave','Wave'],['bow','Bow'],['congratulate','Good wishes'],['petals','Petals'],['dance','Dance'],['toast','A toast']].map(([id,label])=>`<button data-action="emote" data-emote="${id}">${label}</button>`).join('')}</div>
      <div class="spectator-controls" id="spectator-controls" hidden><span>Optional ceremony viewpoint</span><button data-action="next-view">Next view</button><button data-action="camera" data-mode="THIRD_PERSON">Return to my camera</button></div>
    </div>
    <div class="photo-overlay" id="photo-overlay" hidden><header><span>${icon('camera')}A moment, framed.</span><button class="photo-exit" data-action="exit-photo">${icon('close')}Exit photo mode</button></header><div class="photo-frame" aria-hidden="true"></div><footer><p>Drag to compose · scroll to zoom<br>Walking controls are paused.</p><button class="primary" data-action="photo" aria-label="Save a photograph">${icon('camera')}Save photograph</button></footer></div>
    <button class="drawer-backdrop" id="drawer-backdrop" data-action="close-directory" aria-label="Dismiss wedding directory" hidden></button><aside class="directory-drawer" id="directory-drawer" role="dialog" aria-modal="true" aria-labelledby="directory-heading" hidden><div class="drawer-heading"><div><span class="drawer-flower">${icon('flower')}</span><h2 id="directory-heading">Around the world</h2></div><button class="icon-button" id="drawer-close" aria-label="Close wedding directory">${icon('close')}</button></div><p class="drawer-intro">A celebration is even lovelier with company. Find a ceremony, or wander into a garden.</p><div class="directory-filters" id="directory-filters"></div><div id="directory-list"></div><div class="drawer-footer">${icon('compass')}Public paths stay open during every ceremony.</div></aside>
    <dialog id="modal" aria-labelledby="modal-title"><div class="dialog-header"><span class="dialog-emblem">${rings}</span><button type="button" data-action="close-modal" class="icon-button" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-content" id="modal-content"></div></dialog>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden>${icon('flower')}<span></span></div>
  `;}

  private mapSVG(id:string){
    const p=(n:number)=>n*.48+130;
    return `<svg class="world-map" viewBox="0 0 260 250" role="img" aria-label="Map of five wedding gardens, the central plaza, and registrar"><path d="M48 35Q80 3 134 18T232 94Q251 158 207 213T83 232Q8 193 16 125T48 35" fill="#dce4cf" stroke="#c8d6bc" stroke-width="1"/><g fill="#b4c69f" opacity=".7">${[[48,67],[154,35],[196,73],[220,152],[172,212],[62,185],[31,133],[103,183],[173,155],[102,105]].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="5"/><circle cx="${x+5}" cy="${y+2}" r="4"/>`).join('')}</g><g stroke="#faf7e9" stroke-width="6" fill="none" stroke-linejoin="round">${paths.map(path=>`<path d="M${p(path.a[0])} ${p(path.a[1])}L${p(path.b[0])} ${p(path.b[1])}"/>`).join('')}</g><polyline id="${id}-route" fill="none" stroke="#ac703b" stroke-width="2.5" stroke-dasharray="3 3"/><circle cx="130" cy="130" r="13" fill="#f4e7ca" stroke="#c5bda1"/><circle cx="130" cy="130" r="5" fill="#8fa77a"/><g fill="#345348" font-family="DM Sans,sans-serif" font-size="8" text-anchor="middle">${districts.map(d=>`<g transform="translate(${p(d.center[0])},${p(d.center[1])})"><rect x="-15" y="-14" width="30" height="28" rx="10" fill="${d.color}" stroke="#fcfaed" stroke-width="2"/><path d="m-9-1 9-7 9 7M-6 0v7h12V0M-2 7V2h4v5" fill="none" stroke="#fff8e8" stroke-width="1.5"/><text y="27">${d.name}</text></g>`).join('')}<text x="130" y="155">Meeting Plaza</text></g><path d="m${p(worldMap.registrar[0])} ${p(worldMap.registrar[1])-4} 3 3-3 3-3-3Z" fill="#b67b44" stroke="#fffaf0"/><g id="${id}-player" transform="translate(130,130)"><circle r="8" fill="#244e43" fill-opacity=".12"/><circle r="4" fill="#244e43" stroke="#fff" stroke-width="2"/></g><path d="M238 13v14m-3-10 3-4 3 4" fill="none" stroke="#526b59"/><text x="238" y="38" font-size="8" text-anchor="middle" fill="#526b59">N</text></svg>`;
  }
  private updateCamera(mode:CameraMode){
    for(const el of this.root.querySelectorAll<HTMLElement>('.camera-button[data-mode]'))el.setAttribute('aria-pressed',String(el.dataset.mode===mode));
    this.$('#camera-caption').innerHTML=`${{THIRD_PERSON:'Follow camera',FIRST_PERSON:'First person',ISOMETRIC:'Isometric view',CINEMATIC_SPECTATOR:'Ceremony viewpoint'}[mode]} <kbd>${mode==='CINEMATIC_SPECTATOR'?'C':'V'}</kbd>`;
    this.$('#spectator-controls').hidden=mode!=='CINEMATIC_SPECTATOR';
  }
  private async loadInvitation(){
    const match=location.pathname.match(/^\/w\/([A-Za-z0-9_-]{12,40})\/?$/);
    this.invitationSlug=match?.[1];
    if(!this.invitationSlug)return;
    const refresh=async()=>{
      if(this.entered)return;
      try{
        const response=await fetch(`/api/invitations/${encodeURIComponent(this.invitationSlug!)}`);
        if(!response.ok){this.invitation=null;this.invitationSlug=undefined;this.$('#invitation-actions').hidden=true;this.$('#welcome-heading').innerHTML='This invitation<br>has drifted away.';this.$('#welcome-description').textContent='This invitation is expired or unavailable. The park is still open for you to explore.';this.$('#enter-label').textContent='Explore the world';window.clearInterval(timer);return;}
        this.invitation=await response.json();
        this.$('#landing').classList.add('invitation-landing');
        this.$('#resume-invitation').hidden=!this.connection.hasSavedSession();
        const e=this.invitation!;this.previewDistrict(e.district);
        this.$('#welcome-heading').innerHTML=`${h(e.couple[0])}<span class="couple-amp">&</span>${h(e.couple[1])}`;
        this.$('#welcome-heading').classList.add('couple-heading');
        this.$('#welcome-description').innerHTML=`You’re invited to a moment together.<br>${h(e.venue||districtById[e.district].venue)}<br><span class="invitation-status">${h(stateLabel(e.state))}</span>`;
        this.$('#enter-label').textContent='Join the wedding';
        this.$('#invitation-actions').hidden=false;
      }catch{this.$('#entry-error').textContent='The invitation cannot be reached. Check the server connection and try again.';}
    };
    const timer=window.setInterval(refresh,4000);await refresh();
  }
  private previewDistrict(id:string){
    const d=districtById[id];this.scene.setLandingDistrict(id);
    this.$('#preview-native').textContent=d.nativeName;this.$('#preview-place').textContent=d.venue;this.$('#preview-description').textContent=d.description;
    for(const tab of this.root.querySelectorAll<HTMLElement>('.garden-tab')){tab.classList.toggle('selected',tab.dataset.district===id);tab.setAttribute('aria-pressed',String(tab.dataset.district===id));}
  }
  ready(){this.$('#world-loading').classList.add('loaded');window.setTimeout(()=>this.$('#world-loading').remove(),500);}
  toast(message:string){
    const toast=this.$('#toast');toast.querySelector('span')!.textContent=message;toast.hidden=false;
    window.clearTimeout(this.toastTimer);this.toastTimer=window.setTimeout(()=>toast.hidden=true,6500);
  }
  private show(title:string,content:string,kind:string,wide=false){
    this.setPhotoMode(false);this.closeDirectory();this.setCameraMenu(false);this.resetMovement();
    const dialog=this.$<HTMLDialogElement>('#modal');this.modalKind=kind;
    dialog.classList.toggle('wide-dialog',wide);dialog.classList.toggle('certificate-dialog',kind==='keepsake');
    this.$('#modal-content').innerHTML=`<h2 id="modal-title">${title}</h2>${content}`;
    this.scene.controlsEnabled=false;
    if(!dialog.open)dialog.showModal();
  }
  private closeModal(){this.$<HTMLDialogElement>('#modal').close();this.scene.controlsEnabled=true;}
  private go(point:Point,name:string){
    const navigate=()=>{this.closeDirectory();this.scene.navigate(point,name);};
    const dialog=this.$<HTMLDialogElement>('#modal');
    // Start the new route after the dialog's close handler has cleared old input.
    if(dialog.open){dialog.addEventListener('close',navigate,{once:true});this.closeModal();}
    else navigate();
  }
  private async action(button:HTMLElement){
    const action=button.dataset.action!,event=this.state?.wedding||this.invitation;
    if(action==='avatar'){
      this.selectedClothingColor=clothingColors[Number(button.dataset.avatar)];this.colorCustomized=true;this.updateAppearance();return;
    }
    if(action==='gender'){
      this.selectedGender=button.dataset.gender as GuestGender;
      if(!this.colorCustomized)this.selectedClothingColor=clothingColors[this.selectedGender==='female'?0:3];
      this.updateAppearance();return;
    }
    if(action==='preview-district')return this.previewDistrict(button.dataset.district!);
    if(action==='close-modal')return this.closeModal();
    if(action==='guide')return this.guide();
    if(action==='world-guide')return this.worldGuide();
    if(action==='sound')return this.toggleSound();
    if(action==='plan')return this.plan();
    if(action==='directory'){this.directoryOpener=button;this.resetMovement();this.scene.controlsEnabled=false;this.setCameraMenu(false);this.$('#directory-drawer').hidden=false;this.$('#drawer-backdrop').hidden=false;this.$('#game-hud').inert=true;this.renderDirectory();this.$('#drawer-close').focus();return;}
    if(action==='close-directory')return this.closeDirectory();
    if(action==='filter'){this.directoryFilter=button.dataset.filter!;return this.renderDirectory();}
    if(action==='copy-code'){await this.copy(this.state!.self.code);this.toast('Guest code copied. Share it with the person joining you.');return;}
    if(action==='resume-invitation'){this.resumeInvitation=true;if(!this.connection.restore()){this.resumeInvitation=false;this.$('#resume-invitation').hidden=true;this.toast('Choose a temporary nickname to enter.');}return;}
    if(action==='map')return this.showMap();
    if(action==='route-district'){const d=districtById[button.dataset.district!];return this.go(toWorld(d,0,29),d.venue);}
    if(action==='route-registrar')return this.go(worldMap.registrar as Point,'Wedding Registrar');
    if(action==='stop-walking')return this.scene.stopWalking();
    if(action==='camera')return this.scene.setMode(button.dataset.mode as CameraMode);
    if(action==='camera-menu')return this.setCameraMenu(this.$('#camera-menu').hidden);
    if(action==='settings')return this.settings();
    if(action==='program')return this.program(button.dataset.district!);
    if(action==='share')return this.share();
    if(action==='copy-link'){await this.copy(this.invitationURL(event!));return this.toast('Public wedding link copied. It does not grant a family role.');}
    if(action==='device-share'){
      const url=this.invitationURL(event!);
      if(navigator.share){try{await navigator.share({title:`${event!.couple.join(' & ')} — Wedding World`,url});}catch(error){if((error as Error).name!=='AbortError')this.toast('Device sharing is unavailable. Use Copy link instead.');}}else{await this.copy(url);this.toast('Invitation link copied.');}return;
    }
    if(action==='group')return this.group();
    if(action==='alternatives'){
      const available=this.state!.venues.filter(v=>!v.occupied&&v.availableAt<=this.connection.now());
      return this.show('Another garden, another moment.',`<p>Your current queue place stays reserved while you look. ${available.length?'These gardens currently have a free stage:':'The other gardens are also occupied right now.'}</p><div class="map-destinations">${available.map(v=>`<button class="secondary" data-action="program" data-district="${v.district}">${h(districtById[v.district].name)} · ${slotLabel(districtById[v.district])}</button>`).join('')}</div><p>To choose another garden, cancel this registration and meet the registrar again. Both participants must agree to the new district before a new invitation is made.</p><button class="primary" data-action="cancel">Cancel and choose again</button><button class="secondary" data-action="close-modal">Keep our queue place</button>`,'alternatives');
    }
    if(action==='ready-location'){if(event)return this.go(toWorld(districtById[event.district],0,24),'Ready-check circle');return;}
    if(action==='confirm-ready'){await this.connection.command('ready',{eventId:event?.id});return this.toast('Your ready confirmation reached the registrar. Both participants must confirm before the deadline.');}
    if(action==='consent'){await this.connection.command('consent',{proposalId:button.dataset.proposal,accept:button.dataset.accept==='true'});this.closeModal();return;}
    if(action==='withdraw'){await this.connection.command('withdraw_proposal',{proposalId:button.dataset.proposal});return;}
    if(action==='answer-role'){await this.connection.command('answer_role',{eventId:button.dataset.event,accept:button.dataset.accept==='true'});return;}
    if(action==='remove-role'){await this.connection.command('remove_role',{eventId:event?.id,guestId:Number(button.dataset.guest)});return;}
    if(action==='role-seat'||action==='role-stage'){
      const result=await this.connection.command(action==='role-seat'?'seat':'enter_stage',{eventId:button.dataset.event});
      return this.go(result.destination,action==='role-seat'?'Your priority place':'Called role position');
    }
    if(action==='cancel')return this.show('Leave this wedding?',`<p>Either participant can cancel. The invitation, group, and reservation will be removed immediately. You can stay in the park and register again.</p><button class="danger" data-action="confirm-cancel">Cancel our wedding</button><button class="secondary" data-action="close-modal">Keep our wedding</button>`,'cancel');
    if(action==='confirm-cancel'){await this.connection.command('cancel',{eventId:event?.id});this.closeModal();return;}
    if(action==='ceremony-action'){await this.connection.command('ceremony_action',{eventId:event?.id,phaseId:event?.phase?.id});return this.toast('Your gesture is part of this moment.');}
    if(action==='role-ceremony-action'){await this.connection.command('ceremony_action',{eventId:button.dataset.event,phaseId:button.dataset.phase});return this.toast('Your family gesture is part of the celebration.');}
    if(action==='follow-wedding'){
      const e=this.state?.directory.find(e=>e.id===button.dataset.event);if(!e)return this.toast('This invitation is expired or unavailable.');
      const result=await this.connection.command('watch',{eventId:e.id});
      if(result.overflow){this.toast('Public viewing is full. You can follow the same ceremony in a lighter spectator view.');this.scene.setMode('CINEMATIC_SPECTATOR',e.id);}
      else this.go(toWorld(districtById[e.district],-6,18),`${e.couple.join(' & ')} · public viewing`);return;
    }
    if(action==='stop-viewing'){await this.connection.command('leave_viewing');this.scene.setMode('THIRD_PERSON');return;}
    if(action==='emotes'){this.setCameraMenu(false);this.$('#emote-menu').hidden=!this.$('#emote-menu').hidden;return;}
    if(action==='emote'){this.$('#emote-menu').hidden=true;await this.connection.command('emote',{emote:button.dataset.emote});return;}
    if(action==='reception'){const result=await this.connection.command('reception_activity');this.toast(result.message);return;}
    if(action==='route-reception'){const d=districtById[this.state!.self.zone];return this.go(toWorld(d,...worldMap.reception as Point),'Reception & photo garden');}
    if(action==='route-photo'){const d=districtById[this.state!.self.zone];return this.go(toWorld(d,...(d.photoPoint||[-26,-31]) as Point),'Photo garden');}
    if(action==='route-zone'){const d=districtById[button.dataset.district!],[x,z]=button.dataset.point!.split(',').map(Number);return this.go(toWorld(d,x,z),button.dataset.label||d.venue);}
    if(action==='photo-mode')return this.setPhotoMode(true);
    if(action==='exit-photo')return this.setPhotoMode(false);
    if(action==='photo'){download(this.scene.capture(),`wedding-world-photo-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.png`);return this.toast('Your photograph was saved to your device.');}
    if(action==='keepsake')return this.showCertificate();
    if(action==='save-png'&&this.certificate&&this.evidence)return download(this.certificate.toDataURL('image/png'),`wedding-world-${this.evidence.payload.eventReference}.png`);
    if(action==='save-pdf'&&this.certificate&&this.evidence)return savePDF(this.certificate,this.evidence);
    if(action==='save-evidence'&&this.evidence)return saveEvidence(this.evidence);
    if(action==='next-view'){this.scene.cinematicIndex++;return;}
    if(action==='leave')return this.show('Leave the garden?',`<p>Your guest session is temporary. ${event?'Leaving during a ceremony starts the 45-second reconnect window. An absent participant cannot receive a keepsake.':'You can come back with a new nickname any time.'}</p><button class="primary" data-action="confirm-leave">Leave the world</button><button class="secondary" data-action="close-modal">Keep exploring</button>`,'leave');
    if(action==='confirm-leave'){this.connection.leave();location.href='/';return;}
  }

  private async submit(form:HTMLFormElement){
    const data=new FormData(form);
    if(form.id==='enter-form'){
      if(this.connecting)return;this.connecting=true;
      this.$<HTMLButtonElement>('#enter-button').disabled=true;this.$('#enter-label').textContent='Joining the garden…';this.$('#entry-error').textContent='';
      try{await this.connection.enter(String(data.get('nickname')).trim(),this.selectedAvatar,this.invitationSlug,this.selectedGender,this.selectedClothingColor);}
      catch(error){this.connecting=false;this.$<HTMLButtonElement>('#enter-button').disabled=false;this.$('#enter-label').textContent=this.invitation?'Join the wedding':'Enter the world';this.$('#entry-error').textContent=(error as Error).message;}return;
    }
    if(form.id==='registration-form'){
      if(!data.get('consent'))return;
      const button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;button.disabled=true;
      try{await this.connection.command('propose',{partnerCode:String(data.get('partnerCode')),district:String(data.get('district'))});this.closeModal();this.toast('Your request is waiting for the other person’s explicit consent.');}finally{button.disabled=false;}return;
    }
    if(form.id==='role-form'){
      await this.connection.command('invite_role',{eventId:this.state?.wedding?.id,code:String(data.get('code')),role:String(data.get('role')),side:Number(data.get('side'))});
      form.querySelector<HTMLInputElement>('[name="code"]')!.value='';this.toast('Role invitation sent. The guest must accept before receiving access.');this.renderGroupMembers();return;
    }
  }
  private input(event:Event){
    const el=event.target as HTMLInputElement;
    if(el.id==='clothing-color'){this.selectedClothingColor=el.value;this.colorCustomized=true;this.updateAppearance();}
    if(el.id==='camera-sensitivity')this.scene.sensitivity=Number(el.value);
    if(el.id==='camera-distance')this.scene.zoom=Number(el.value);
    if(el.id==='reduced-motion')this.scene.reducedMotion=el.checked;
    if(el.id==='render-quality')this.scene.renderer.setPixelRatio(Number(el.value));
    if(el.id==='attire-choice')this.connection.command('attire',{eventId:this.state?.wedding?.id,choice:Number(el.value)}).catch(error=>this.toast(error.message));
  }
  private updateAppearance(){
    this.guestPreview.setAppearance(this.selectedGender,this.selectedClothingColor);
    this.$<HTMLInputElement>('#clothing-color').value=this.selectedClothingColor;
    this.$('#outfit-caption').textContent=this.selectedGender==='female'?'Váy xếp nếp · Nữ':'Vest & nơ · Nam';
    for(const el of this.root.querySelectorAll<HTMLElement>('[data-action="gender"]'))el.setAttribute('aria-pressed',String(el.dataset.gender===this.selectedGender));
    for(const el of this.root.querySelectorAll<HTMLElement>('.avatar-color')){
      const selected=clothingColors[Number(el.dataset.avatar)]===this.selectedClothingColor;
      el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',String(selected));el.querySelector('span')!.innerHTML=selected?icon('check'):'';
    }
  }
  update(state:WorldState){
    const newEvent=state.wedding?.id!==this.state?.wedding?.id;
    if(this.state?.wedding&&!state.wedding&&['share','group','cancel'].includes(this.modalKind))this.closeModal();
    this.state=state;
    this.$('#guest-count').textContent=`${state.guestCount} ${state.guestCount===1?'guest':'guests'} in the park`;
    this.$('#guest-name').textContent=state.self.nickname;this.$('#guest-code').textContent=state.self.code;
    this.$('#wedding-count').textContent=String(state.directory.length);
    this.$('#location-name').textContent=districtById[state.self.zone]?.venue||'Meeting Plaza';
    const key=JSON.stringify([state.wedding,state.proposals,state.memberships,state.viewing,state.overflow,state.self.zone]);
    if(key!==this.renderingKey){
      this.renderingKey=key;this.renderMoment();this.renderConsents();
      if(state.wedding&&(newEvent||state.wedding.state==='READY_CHECK'||state.wedding.state==='CEREMONY_ACTIVE'))this.$<HTMLDetailsElement>('#moment-card').open=true;
      if(state.proposals.some(p=>p.incoming)||state.memberships.some(m=>!m.accepted)||state.wedding?.state==='READY_CHECK')this.setPhotoMode(false);
    }
    if(!this.$('#directory-drawer').hidden)this.renderDirectory();
    if(this.modalKind==='group')this.renderGroupMembers();
    if(this.scene.mode==='CINEMATIC_SPECTATOR'&&!state.directory.some(e=>e.state==='CEREMONY_ACTIVE'&&e.district===this.scene.cinematicDistrict?.id))this.scene.setMode('THIRD_PERSON');
  }
  private renderMoment(){
    const e=this.state?.wedding,view=this.state?.viewing;
    this.$('#moment-summary').textContent=e?stateLabel(e.state):view?'Following a wedding':districtById[this.state?.self.zone||'']?.name||'Your next moment';
    if(e){
      const d=districtById[e.district],phase=e.phase;
      this.$('#moment-panel').innerHTML=`<div class="moment-heading"><span class="moment-icon" style="--district-color:${d.color}">${icon('heart')}</span><span>${h(stateLabel(e.state))}</span></div><h2>${h(e.couple.join(' & '))}</h2><p class="moment-location">${h(d.nativeName)} · ${h(e.venue||d.venue)}</p>
        ${e.state==='QUEUED'?`<p>Your place in the queue: <strong>${e.queuePosition}</strong>. An estimate can change if an earlier couple misses their ready check.</p>${e.estimatedStart?`<p class="status-subtle">Estimated call: ${new Date(e.estimatedStart*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>`:''}<button class="walk-link" data-action="alternatives">Explore another available garden ${icon('arrow')}</button>`:''}
        ${e.state==='READY_CHECK'||e.state==='VENUE_ASSIGNED'?`<div class="ready-check"><div class="ready-top"><span>Both confirmations needed</span><strong data-clock="${e.readyDeadline}">1:00</strong></div><div class="ready-progress"><span style="width:${e.readyCount*50}%"></span></div><p>${e.readyCount} of 2 ready. Reach the circle in the forecourt, then confirm.</p><button class="secondary small" data-action="ready-location">${icon('pin')}Walk to the ready circle</button><button class="primary small" data-action="confirm-ready" ${e.myReady?'disabled':''}>${e.myReady?'You are ready':"I’m here and ready"}${icon(e.myReady?'check':'arrow')}</button></div>`:''}
        ${e.state==='CEREMONY_ACTIVE'&&phase?`<div class="ceremony-moment"><span class="phase-time" data-clock="${phase.endsAt}"></span><h3>${h(phase.title)}</h3><p>${h(phase.dialogue)}</p><button class="primary small" data-action="ceremony-action" ${e.myActions?.includes(phase.id)?'disabled':''}>${h(e.myActions?.includes(phase.id)?'Your gesture is complete':phase.action)}${icon(e.myActions?.includes(phase.id)?'check':'flower')}</button>${phase.required?'<span class="required-note">Both participants need to take part in this moment.</span>':''}</div>`:''}
        <div class="moment-actions"><button data-action="share">${icon('share')}Invitation</button><button data-action="group">${icon('people')}Our group</button><button data-action="program" data-district="${d.id}" aria-label="View ceremony program">${icon('map')}</button></div>`;
    }else if(view){
      this.$('#moment-panel').innerHTML=`<div class="moment-heading">${icon('eye')}Following a wedding</div><h2>${h(view.couple.join(' & '))}</h2><p>${h(view.phase?.title||stateLabel(view.state))}</p>${view.phase?`<p class="spectator-dialogue">${h(view.phase.dialogue)}</p><span class="phase-time" data-clock="${view.phase.endsAt}"></span>`:''}<button class="walk-link" data-action="follow-wedding" data-event="${view.id}">Walk to the viewing garden ${icon('arrow')}</button><div class="moment-actions"><button data-action="program" data-district="${view.district}">View program</button><button data-action="stop-viewing">Stop following</button></div>`;
    }else if(this.state&&districtById[this.state.self.zone]){
      const d=districtById[this.state.self.zone];
      this.$('#moment-panel').innerHTML=`<div class="moment-heading">${icon('flower')}A little time in ${h(d.name)}</div><h2>${h(d.venue)}</h2><p>${h(d.description)}</p>${d.layoutTitle?`<p class="status-subtle">${h(d.layoutTitle)}</p>`:''}<button class="walk-link" data-action="program" data-district="${d.id}">Explore this ceremony ${icon('arrow')}</button><button class="walk-link" data-action="route-reception">Walk to the reception garden ${icon('pin')}</button><button class="walk-link" data-action="route-photo">Walk to the photo pavilion ${icon('camera')}</button><button class="secondary small" data-action="reception">${h(d.activity)}</button>`;
    }else{
      this.$('#moment-panel').innerHTML=`<div class="moment-heading">${icon('flower')}A day with possibility</div><h2>Every story starts<br>with a hello.</h2><p>Explore a garden, find a celebration, or meet the registrar with someone special.</p><button class="walk-link" data-action="route-registrar">Meet the Wedding Registrar ${icon('arrow')}</button>`;
    }
  }
  private renderConsents(){
    const state=this.state!;
    this.$('#consent-panel').innerHTML=state.proposals.map(p=>`<article class="consent-request"><span class="request-icon">${icon('heart')}</span><div><h3>${p.incoming?`${h(p.proposer)} would like to register with you`:'Waiting for a little yes'}</h3><p>${h(districtById[p.district].name)} · ${slotLabel(districtById[p.district])}</p><p>${p.incoming?'Only agree if you freely choose this virtual wedding. Your event and public invitation are created after your consent.':`${h(p.partner)} has received your request. A public wedding will be created only if they agree.`}</p><span data-clock="${p.expiresAt}"></span><div class="request-actions">${p.incoming?`<button class="primary small" data-action="consent" data-proposal="${p.id}" data-accept="true">I agree to this wedding</button><button class="text-button" data-action="consent" data-proposal="${p.id}" data-accept="false">Decline</button>`:`<button class="text-button" data-action="withdraw" data-proposal="${p.id}">Withdraw request</button>`}</div></div></article>`).join('')+
      state.memberships.map(m=>`<article class="role-request"><span class="request-icon">${icon('people')}</span><div><h3>${m.accepted?'Your wedding group':`An invitation to be ${h(m.role)}`}</h3><p>${h(m.event.couple.join(' & '))}</p><p>${h(m.role)} · ${h(m.event.couple[m.side])}’s side</p><div class="request-actions">${!m.accepted?`<button class="primary small" data-action="answer-role" data-event="${m.event.id}" data-accept="true">Accept role</button><button class="text-button" data-action="answer-role" data-event="${m.event.id}" data-accept="false">Decline</button>`:`<button class="secondary small" data-action="role-seat" data-event="${m.event.id}">Find my place</button>${m.event.phase?.calledRoles?.includes(m.role)?`<button class="primary small" data-action="role-stage" data-event="${m.event.id}">My role is called</button><button class="secondary small" data-action="role-ceremony-action" data-event="${m.event.id}" data-phase="${m.event.phase.id}">${h(m.event.phase.action)}</button>`:''}`}</div></div></article>`).join('');
  }
  private plan(){
    if(!this.connection.connected){this.toast('Enter the world with a temporary nickname first.');this.$('#nickname').focus();return;}
    if(this.state?.wedding){this.group();return;}
    if(Math.hypot(this.scene.position[0]-worldMap.registrar[0],this.scene.position[1]-worldMap.registrar[1])>7){this.go(worldMap.registrar as Point,'Wedding Registrar');this.toast('Follow the garden path to the registrar’s desk beside the plaza.');return;}
    const guests=(this.state?.nearby||[]).filter(g=>g.id!==this.state?.self.id);
    this.show('A moment for the two of you.',`<p class="dialog-lead">Welcome to the Wedding Registrar. Both of you choose this together, then we find a public place to celebrate.</p><p class="your-code">Your guest code <strong>${h(this.state?.self.code)}</strong><button class="icon-button" data-action="copy-code" aria-label="Copy guest code">${icon('copy')}</button></p>
      <form id="registration-form"><label for="partner-code">The other person’s guest code</label><input id="partner-code" name="partnerCode" list="nearby-guests" placeholder="e.g. A7K2PW" required minlength="6" maxlength="6" autocomplete="off"/><datalist id="nearby-guests">${guests.map(g=>`<option value="${h(g.code)}">${h(g.nickname)}</option>`).join('')}</datalist><p class="field-note">They’ll find their code beside their nickname in the world.</p>
      <fieldset class="district-options"><legend>Where would you like to celebrate?</legend>${districts.map((d,i)=>`<label class="district-option"><input type="radio" name="district" value="${d.id}" ${i===0?'checked':''}/><span class="district-option-dot" style="background:${d.color}"></span><span><strong>${d.name}</strong><small>${d.venue} · ${slotLabel(d)}</small></span></label>`).join('')}</fieldset>
      <label class="checkbox-label"><input type="checkbox" name="consent" required/><span>I freely agree to register this symbolic virtual wedding and create a public invitation if the other person also agrees.</span></label><button type="submit" class="primary">Ask for their consent ${icon('arrow')}</button></form><p class="fine-print">No account, legal marriage, or permanent wedding record. Family roles are optional and require a separate invitation.</p>`,'register');
  }
  private invitationURL(event:WeddingEvent){return `${location.origin}/w/${event.slug}`;}
  private share(){
    const e=this.state?.wedding;if(!e)return;
    const d=districtById[e.district];
    this.show('A little invitation.',`<div class="invitation-preview" style="--district-color:${d.color}"><span class="invitation-flower">${icon('flower')}</span><p>Join us in ${h(d.name)}</p><h3>${h(e.couple[0])}<span>&</span>${h(e.couple[1])}</h3><p>${h(e.venue||d.venue)}</p><span>${h(stateLabel(e.state))}</span></div><label for="invitation-link">Public wedding link</label><div class="share-link"><input id="invitation-link" readonly value="${h(this.invitationURL(e))}"/><button class="icon-button" data-action="copy-link" aria-label="Copy invitation link">${icon('copy')}</button></div><div class="two-buttons"><button class="primary" data-action="copy-link">Copy link ${icon('copy')}</button><button class="secondary" data-action="device-share">Share ${icon('share')}</button></div><p class="fine-print">Everyone with the link may join as a public guest. Family roles are assigned separately. The invitation disappears when your wedding ends or is cancelled.</p>`,'share');
  }
  private group(){
    const e=this.state?.wedding;if(!e)return;
    const active=e.state==='CEREMONY_ACTIVE',d=districtById[e.district];
    this.show('The people beside you.',`<p class="dialog-lead">Invite family and friends to your temporary wedding group. They choose whether to accept. Optional roles never hold up your ceremony.</p><div id="group-members"></div>
      ${!active?`<form id="role-form" class="role-form"><label for="role-code">Guest code</label><input id="role-code" name="code" required minlength="6" maxlength="6" placeholder="Their guest code" autocomplete="off"/><div class="form-row"><label>Role<select name="role">${['father','mother','brother','sister','sibling','friend'].map(r=>`<option value="${r}">${r[0].toUpperCase()+r.slice(1)}</option>`).join('')}</select></label><label>Whose side?<select name="side">${e.couple.map((name,i)=>`<option value="${i}">${h(name)}</option>`).join('')}</select></label></div><button class="primary" type="submit">Invite to our group ${icon('people')}</button></form><label for="attire-choice">My ceremony clothing</label><select id="attire-choice">${d.attire.map((label,i)=>`<option value="${i}" ${this.state?.self.attire===i?'selected':''}>${h(label)}</option>`).join('')}</select>`:'<p>Roles are fixed for the ceremony. Family participants may enter the stage only when their role is called.</p>'}
      <p class="fine-print">16 priority places in total, at most eight per side. Parent places are nearest the ceremony. A public wedding link gives no priority access.</p><button class="text-button danger-text" data-action="cancel">Cancel this wedding</button>`,'group');this.renderGroupMembers();
  }
  private renderGroupMembers(){
    const container=this.root.querySelector('#group-members'),e=this.state?.wedding;if(!container||!e)return;
    container.innerHTML=`<p class="group-capacity">${e.priorityUsed} of ${e.priorityLimit} priority places reserved</p><ul class="member-list">${e.members?.map(m=>`<li><span class="member-initial">${h(m.nickname.slice(0,1))}</span><div><strong>${h(m.nickname)}</strong><span>${h(m.role)} · ${h(e.couple[m.side])}’s side</span></div><span class="membership-status">${m.accepted?'Accepted':'Invited'}</span>${e.state!=='CEREMONY_ACTIVE'?`<button class="icon-button" data-action="remove-role" data-guest="${m.guest_id}" aria-label="Remove ${h(m.nickname)} from group">${icon('close')}</button>`:''}</li>`).join('')||'<li class="empty-members">A small circle is lovely too. Your ceremony works with just the two of you.</li>'}</ul>`;
  }
  private renderDirectory(){
    const state=this.state;if(!state)return;
    if(!this.filtersRendered){this.$('#directory-filters').innerHTML=['all',...districts.map(d=>d.id)].map(id=>`<button data-action="filter" data-filter="${id}" aria-pressed="${this.directoryFilter===id}">${id==='all'?'All gardens':districtById[id].name}</button>`).join('');this.filtersRendered=true;}
    for(const button of this.root.querySelectorAll<HTMLElement>('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===this.directoryFilter));
    const events=state.directory.filter(e=>this.directoryFilter==='all'||e.district===this.directoryFilter);
    this.$('#directory-list').innerHTML=`${events.length?`<div class="directory-events">${events.map(e=>{const d=districtById[e.district];return `<article class="directory-event" style="--district-color:${d.color}"><span class="event-state ${e.state==='CEREMONY_ACTIVE'?'live':''}">${h(e.state==='CEREMONY_ACTIVE'?'Live ceremony':stateLabel(e.state))}</span><h3>${h(e.couple.join(' & '))}</h3><p>${h(d.name)} · ${h(e.venue||d.venue)}</p>${e.phase?`<p class="event-current">${h(e.phase.title)}</p>`:''}<button class="walk-link" data-action="follow-wedding" data-event="${e.id}">Follow this wedding ${icon('arrow')}</button></article>`;}).join('')}</div>`:`<div class="directory-empty">${icon('flower')}<h3>The gardens are quiet.</h3><p>No weddings are registered ${this.directoryFilter==='all'?'right now':'in this garden'}. There’s still a whole world to wander.</p></div>`}
      <h3 class="garden-list-heading">Find your next garden</h3><div class="garden-list">${districts.filter(d=>this.directoryFilter==='all'||d.id===this.directoryFilter).map(d=>`<article><span class="garden-initial" style="--district-color:${d.color}">${d.symbol}</span><div><h4>${d.name}</h4><p>${h(d.venue)}</p><small>${slotLabel(d)} · ${state.venues.find(v=>v.district===d.id)?.occupied?'Stage in use':'Stage available'}</small></div><button class="icon-button" data-action="route-district" data-district="${d.id}" aria-label="Walk to ${d.name}">${icon('arrow')}</button><button class="icon-button" data-action="program" data-district="${d.id}" aria-label="View ${d.name} ceremony program">${icon('map')}</button></article>`).join('')}</div>`;
  }
  private closeDirectory(){
    if(this.$('#directory-drawer').hidden)return;
    this.$('#directory-drawer').hidden=true;this.$('#drawer-backdrop').hidden=true;this.$('#game-hud').inert=false;
    this.resetMovement();this.scene.controlsEnabled=!this.$<HTMLDialogElement>('#modal').open;
    this.directoryOpener?.focus();this.directoryOpener=null;
  }
  private resetMovement(){this.scene.resetInput();this.stopJoystick();}
  private setCameraMenu(open:boolean){if(open)this.$('#emote-menu').hidden=true;this.$('#camera-menu').hidden=!open;this.$('[data-action="camera-menu"]').setAttribute('aria-expanded',String(open));}
  private setPhotoMode(enabled:boolean){
    if(enabled===this.scene.photoMode)return;
    this.resetMovement();if(enabled){this.scene.stopWalking();this.setCameraMenu(false);this.$('#emote-menu').hidden=true;}
    this.scene.photoMode=enabled;this.root.classList.toggle('photo-mode',enabled);this.$('#photo-overlay').hidden=!enabled;this.$('#game-hud').inert=enabled;
    if(enabled)this.$('[data-action="exit-photo"]').focus();
    else this.scene.canvas.focus();
  }
  private showMap(){
    const travel=(destination:Point)=>{
      const route=findPath(this.scene.position,destination,this.scene.grants);if(!route.length)return 'Public path';
      let distance=0,from=this.scene.position;for(const point of route){distance+=Math.hypot(point[0]-from[0],point[1]-from[1]);from=point;}
      const seconds=Math.ceil(distance/worldMap.speed);return seconds<60?`About ${Math.max(1,seconds)} sec walk`:`About ${Math.ceil(seconds/60)} min walk`;
    };
    this.show('Where shall we wander?',`<p class="dialog-lead">Five gardens, a shared promenade, and a place for your next hello.</p><div class="map-layout"><div><div class="large-map">${this.mapSVG('large')}</div><div class="map-legend"><span><i class="you-dot"></i>You are here</span><span><i class="registrar-dot"></i>Registrar</span><span><i class="path-line"></i>Public path</span></div><p class="map-footnote">All gardens stay connected during ceremonies. Family and ritual areas open to invited participants.</p></div><div class="map-destinations"><button class="map-destination" data-action="route-registrar"><span class="destination-symbol plaza-symbol">${icon('compass')}</span><span><strong>Meeting Plaza</strong><small>Wedding Registrar · ${travel(worldMap.registrar as Point)}</small></span>${icon('arrow')}</button>${districts.map(d=>`<button class="map-destination" data-action="route-district" data-district="${d.id}"><span class="destination-symbol" style="--district-color:${d.color}">${d.symbol}</span><span><strong>${d.name}</strong><small>${h(d.venue)}</small><small>${travel(toWorld(d,0,29))}</small></span>${icon('arrow')}</button>`).join('')}</div></div>`,'map',true);
  }
  private worldGuide(){this.show('Five gardens. One world.',`<p class="dialog-lead">A public wedding park connected by a continuous promenade. Visit in either direction, stop for a celebration, or simply take a walk.</p><div class="world-guide-list">${districts.map(d=>`<article style="--district-color:${d.color}"><span>${d.symbol}</span><div><h3>${d.name} · <small>${h(d.venue)}</small></h3><p>${h(d.description)}</p>${d.layoutTitle?`<p class="architecture-summary"><strong>${h(d.layoutTitle)}</strong> — ${h(d.layoutSummary||'')}</p>`:''}<button class="text-button" data-action="program" data-district="${d.id}">Explore ceremony & architecture</button></div></article>`).join('')}</div>`,'world-guide',true);}
  private program(id:string){
    const d=districtById[id];
    const zones=d.spatialZones?.length?`<div class="architecture-card" style="--district-color:${d.color}"><h3>${h(d.layoutTitle||'Architectural layout')}</h3><p>${h(d.layoutSummary||'')}</p><ul class="spatial-zones-list">${d.spatialZones.map(z=>`<li><div><strong>${h(z.name)}</strong><span>${h(z.role)}</span></div>${this.entered?`<button class="text-button" data-action="route-zone" data-district="${d.id}" data-point="${z.point[0]},${z.point[1]}" data-label="${h(z.name)}">${icon('pin')}Walk here</button>`:''}</li>`).join('')}</ul></div>`:'';
    this.show(`${h(d.name)}, in good company.`,`<p class="dialog-lead">${h(d.venue)} · ${slotLabel(d)}</p><p class="cultural-note">${h(d.inspiration)}. A symbolic game celebration, not religious officiation or a universal national practice.</p>${zones}<ol class="program-list">${d.program.map(p=>`<li><div><h3>${h(p.title)}</h3><span>${Math.floor(p.duration/60)}:${String(p.duration%60).padStart(2,'0')}</span></div><p>${h(p.dialogue)}</p></li>`).join('')}</ol><p class="fine-print">Before the program: both participants have up to 60 seconds to confirm at the venue. Afterward: one minute for the stage to clear. Optional reception: ${h(d.activity.toLowerCase())}.</p>${this.entered?`<button class="primary" data-action="route-district" data-district="${d.id}">Walk to ${d.name} ${icon('arrow')}</button>`:''}`,'program',true);
  }
  private guide(){this.show('Make yourself at home.',`<div class="guide-section"><h3>Come as a guest</h3><p>A nickname is all you need. The people you see in the park are other connected guests. NPCs at the registrar and venues guide the experience.</p></div><div class="guide-section"><h3>Find your way</h3><p>Use WASD or arrow keys, click an accessible path, or choose a garden on the map. On touch screens, use the movement pad and drag the scene to look around.</p></div><div class="control-guide"><span><kbd>V</kbd>Cycle camera</span><span><kbd>C</kbd>Optional ceremony view</span><span><kbd>E</kbd>Meet the registrar</span><span>Drag to look · Scroll to zoom</span></div><div class="guide-section"><h3>Share a moment</h3><p>Meet the registrar with another real guest. Exchange guest codes, choose a garden, and both consent. Invite friends to temporary roles, then reach the ready-check circle and both confirm within 60 seconds.</p></div><div class="guide-section"><h3>Keep a memory</h3><p>Both participants take the required ceremony actions when called. A successful ceremony sends a signed keepsake to their connected browsers. Save it before leaving or refreshing: the server deletes the wedding immediately and cannot retrieve a missed keepsake.</p></div><p class="fine-print">You can leave a ceremony at any time. Active couples have 45 seconds to reconnect; both must be present at the end. Queued couples have a 90-second disconnect window. Guest sessions expire 120 seconds after disconnecting. Public guests keep their own camera and can leave freely.</p>${this.entered?'<button class="secondary" data-action="leave">Leave the world</button>':''}`,'guide');}
  private settings(){
    this.show('Your view of the world.',`
      <label for="camera-distance">Camera distance</label><input type="range" id="camera-distance" min="4" max="36" value="${this.scene.zoom}"/>
      <label for="camera-sensitivity">Look sensitivity</label><input type="range" id="camera-sensitivity" min="0.3" max="2" step="0.1" value="${this.scene.sensitivity}"/>
      <label for="render-quality">Image detail</label><select id="render-quality"><option value="1">Gentle on your device</option><option value="1.5" ${this.scene.renderer.getPixelRatio()>1?'selected':''}>Detailed</option></select>
      <label class="checkbox-label"><input type="checkbox" id="reduced-motion" ${this.scene.reducedMotion?'checked':''}/><span>Reduce camera transitions and decorative motion</span></label>
      <div class="two-buttons"><button class="secondary sound-button" data-action="sound" aria-label="Turn sound ${this.sound?'off':'on'}">${icon(this.sound?'sound':'mute')}<span>Sound ${this.sound?'on':'off'}</span></button><button class="secondary" data-action="guide">${icon('help')}How to play</button></div>
      <p>Drag the scene to orbit. Camera controls never move your character or change your ceremony access.</p><p class="fine-print">A live ceremony enables optional spectator viewpoints. Your current render rate is ${this.scene.frameRate} frames per second.</p>`,'settings');
  }
  private async receiveEvidence(evidence:Evidence){
    if(!await verifyEvidence(evidence,this.connection.publicKey)){this.toast('The completion evidence could not be verified. No certificate was generated.');return;}
    this.evidence=evidence;this.certificate=await renderCertificate(evidence);
    for(const button of this.root.querySelectorAll<HTMLElement>('.keepsake-button'))button.hidden=false;
    this.showCertificate();
  }
  private showCertificate(){
    if(!this.evidence||!this.certificate)return this.toast('A keepsake becomes available after a successfully completed ceremony.');
    this.show('A moment to keep.',`<p>Your game-issued completion evidence has been verified. Your wedding data has now left the server.</p><img class="certificate-preview" src="${this.certificate.toDataURL('image/png')}" alt="Virtual Wedding Certificate for ${h(this.evidence.payload.couple.join(' and '))}"/><div class="two-buttons"><button class="primary" data-action="save-pdf">Save A4 PDF</button><button class="secondary" data-action="save-png">Save high-resolution PNG</button></div><button class="text-button evidence-download" data-action="save-evidence">Save signed evidence for offline verification</button><p class="fine-print">Save before you refresh or close this tab. No post-event retrieval is available. A participant disconnected during completion may miss the evidence.</p>`,'keepsake');
  }
  private async copy(text:string){
    try{await navigator.clipboard.writeText(text);}catch{const input=document.createElement('textarea');input.value=text;this.root.appendChild(input);input.select();document.execCommand('copy');input.remove();}
  }
  private toggleSound(){
    this.sound=!this.sound;
    if(this.sound){
      this.audio??=new AudioContext();this.audio.resume();
      const play=()=>{if(!this.sound||!this.audio)return;const now=this.audio.currentTime;for(const [i,f]of [261.63,329.63,392,523.25].entries()){
        const oscillator=this.audio.createOscillator(),gain=this.audio.createGain();oscillator.type='sine';oscillator.frequency.value=f;
        gain.gain.setValueAtTime(0,now+i*.65);gain.gain.linearRampToValueAtTime(.012,now+i*.65+.03);gain.gain.exponentialRampToValueAtTime(.0001,now+i*.65+3.5);
        oscillator.connect(gain).connect(this.audio.destination);oscillator.start(now+i*.65);oscillator.stop(now+i*.65+4);
      }};play();this.audioTimer=window.setInterval(play,14000);
    }else{window.clearInterval(this.audioTimer);this.audio?.suspend();}
    for(const button of this.root.querySelectorAll<HTMLElement>('.sound-button')){button.innerHTML=`${icon(this.sound?'sound':'mute')}${button.closest('.landing,#modal')?`<span>Sound ${this.sound?'on':'off'}</span>`:''}`;button.setAttribute('aria-label',`Turn sound ${this.sound?'off':'on'}`);}
  }
  private setupJoystick(){
    const pad=this.$('#joystick'),knob=this.$('#joystick-knob');let owner:number|null=null;
    const update=(event:PointerEvent)=>{const rect=pad.getBoundingClientRect(),x=(event.clientX-rect.left-rect.width/2)/32,z=(event.clientY-rect.top-rect.height/2)/32,length=Math.max(1,Math.hypot(x,z));this.scene.setJoystick(x/length,z/length);knob.style.transform=`translate(${x/length*24}px,${z/length*24}px)`;};
    pad.addEventListener('pointerdown',e=>{if(owner!==null||!this.scene.controlsEnabled)return;owner=e.pointerId;pad.setPointerCapture(e.pointerId);update(e);});pad.addEventListener('pointermove',e=>{if(e.pointerId===owner)update(e);});
    const stop=()=>{owner=null;this.scene.setJoystick(0,0);knob.style.transform='';};this.stopJoystick=stop;
    for(const name of ['pointerup','pointercancel','lostpointercapture'])pad.addEventListener(name,e=>{if((e as PointerEvent).pointerId===owner)stop();});
    window.addEventListener('blur',stop);document.addEventListener('visibilitychange',stop);
    for(const button of this.root.querySelectorAll<HTMLElement>('[data-move]')){
      button.addEventListener('pointerdown',e=>{if(owner!==null||!this.scene.controlsEnabled)return;owner=e.pointerId;button.setPointerCapture(e.pointerId);const [x,z]=button.dataset.move!.split(',').map(Number);this.scene.setJoystick(x,z);});for(const name of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(name,e=>{if((e as PointerEvent).pointerId===owner)stop();});
    }
  }
  private tick(){
    for(const clock of this.root.querySelectorAll<HTMLElement>('[data-clock]')){const seconds=Math.max(0,Math.ceil(Number(clock.dataset.clock)-this.connection.now()));clock.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
    if(!this.entered)return;
    for(const id of ['mini-player','large-player']){const marker=this.root.querySelector<SVGGElement>(`#${id}`);if(marker)marker.setAttribute('transform',`translate(${130+this.scene.position[0]*.48},${130+this.scene.position[1]*.48})`);}
    for(const id of ['mini','large']){const route=this.root.querySelector(`#${id}-route`);route?.setAttribute('points',this.scene.destination?[this.scene.position,...this.scene.route].map(([x,z])=>`${130+x*.48},${130+z*.48}`).join(' '):'');}
    if(this.scene.destination){let distance=0,previous=this.scene.position;for(const p of this.scene.route){distance+=Math.hypot(p[0]-previous[0],p[1]-previous[1]);previous=p;}const seconds=Math.ceil(distance/worldMap.speed);this.$('#navigation-distance').textContent=`${Math.round(distance)} m · about ${seconds<60?`${seconds} sec`:`${Math.ceil(seconds/60)} min`}`;}
  }
}
