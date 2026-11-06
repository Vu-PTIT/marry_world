import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GuestGender } from './types';

export const guestColors=['#578b79','#bb626f','#c49a4e','#6689af','#9276a5','#c88c66'];
export const clothingColors=['#f1e3cd','#bb626f','#c49a4e','#405366','#9276a5','#578b79'];
const skinColors=['#e5bda0','#a97556','#d7a17c','#edcbb5','#986349','#c89472'];
const hairColors=['#49372f','#28282b','#6a4531','#75533d','#302b2d','#47352d'];
type PartKind='cloth'|'clothDark'|'clothLight'|'skin'|'hair'|'fixed';
type ColorRegion={start:number;count:number;kind:PartKind;color:string};
type Pose=Record<string,[number,number,number]>;
const poseBones=['Spine','Chest','Head','UpperArmL','ForearmL','HandL','UpperArmR','ForearmR','HandR','ThighL','ShinL','FootL','ThighR','ShinR','FootR'];

function clip(name:string,duration:number,frames:{t:number;pose:Pose;y?:number}[]){
  const times=frames.map(f=>f.t*duration),tracks:THREE.KeyframeTrack[]=[];
  for(const bone of poseBones){
    const values=frames.flatMap(f=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...(f.pose[bone]||[0,0,0]))).toArray());
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`,times,values));
  }
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position',times,frames.flatMap(f=>[0,f.y??.72,0])));
  return new THREE.AnimationClip(name,duration,tracks);
}

function animationClips(){
  const idle=clip('Idle',4,[{t:0,pose:{}},{t:.5,pose:{Chest:[.016,0,.008]},y:.729},{t:1,pose:{}}]);
  const walk=clip('Walk',.8,Array.from({length:9},(_,i)=>{
    const a=i/8*Math.PI*2,s=Math.sin(a),c=Math.cos(a);
    return {t:i/8,y:.72+Math.abs(s)*.025,pose:{
      Chest:[.025,Math.sin(a)*.025,0],UpperArmL:[-s*.5,0,-.07],UpperArmR:[s*.5,0,.07],
      ForearmL:[-.12-Math.max(0,-s)*.12,0,0],ForearmR:[-.12-Math.max(0,s)*.12,0,0],
      ThighL:[s*.5,0,0],ThighR:[-s*.5,0,0],ShinL:[Math.max(0,-c)*.65,0,0],ShinR:[Math.max(0,c)*.65,0,0],
      FootL:[-Math.max(0,s)*.15,0,0],FootR:[-Math.max(0,-s)*.15,0,0],
    } as Pose};
  }));
  const gesture=(name:string,pose:Pose,duration=2.8)=>clip(name,duration,[{t:0,pose:{}},{t:.22,pose},{t:.78,pose},{t:1,pose:{}}]);
  return [idle,walk,
    clip('Wave',2.8,[{t:0,pose:{}},...Array.from({length:7},(_,i)=>({t:.15+i*.1,pose:{UpperArmR:[-.25,0,2.35],ForearmR:[0,0,Math.sin(i*Math.PI)*.25+.35],HandR:[0,.2,Math.cos(i*Math.PI)*.32],Head:[0,-.12,-.08]} as Pose})),{t:1,pose:{}}]),
    gesture('Bow',{Spine:[.38,0,0],Chest:[.13,0,0],Head:[.1,0,0],UpperArmL:[-.35,0,-.08],UpperArmR:[-.35,0,.08],ForearmL:[-.2,0,0],ForearmR:[-.2,0,0]}),
    gesture('Present',{UpperArmL:[-.95,0,-.08],UpperArmR:[-.95,0,.08],ForearmL:[-.38,0,0],ForearmR:[-.38,0,0],HandL:[1.3,0,0],HandR:[1.3,0,0],Head:[.08,0,0]}),
    gesture('Cup',{UpperArmR:[-1.1,0,.06],ForearmR:[-.9,0,0],HandR:[2,0,0],Head:[.08,-.08,0]}),
    gesture('Promise',{UpperArmR:[-.9,0,.1],ForearmR:[-.55,0,0],HandR:[1.4,0,0],UpperArmL:[-.5,0,-.1],ForearmL:[-.5,0,0],Head:[0,.1,-.05]}),
    gesture('Celebrate',{UpperArmL:[0,0,-2.2],UpperArmR:[0,0,2.2],ForearmL:[-.35,0,0],ForearmR:[-.35,0,0],Head:[-.1,0,0]}),
    clip('Dance',2,[0,.25,.5,.75,1].map(t=>({t,y:.72+Math.sin(t*Math.PI*4)*.025,pose:{
      Spine:[0,Math.sin(t*Math.PI*2)*.12,Math.sin(t*Math.PI*2)*.07],UpperArmL:[-.5,0,-.8],UpperArmR:[-.5,0,.8],
      ForearmL:[-.8,0,0],ForearmR:[-.8,0,0],ThighL:[Math.sin(t*Math.PI*2)*.2,0,0],ThighR:[-Math.sin(t*Math.PI*2)*.2,0,0],
    } as Pose}))),
    gesture('Photo',{UpperArmR:[-.35,0,1.8],ForearmR:[0,0,.4],Head:[0,-.1,-.12]}),
  ];
}

/** Original one-draw-call skinned guest; the GLB is generated from this same source. */
export function buildAvatarAsset(gender:GuestGender='male'){
  const root=new THREE.Group();root.name='WeddingGuest';
  const bones:THREE.Bone[]=[],byName:Record<string,THREE.Bone>={};
  const bone=(name:string,parent:string|null,x:number,y:number,z=0)=>{
    const b=new THREE.Bone();b.name=name;b.position.set(x,y,z);bones.push(b);byName[name]=b;
    (parent?byName[parent]:root).add(b);return b;
  };
  bone('Hips',null,0,.72);bone('Spine','Hips',0,.28);bone('Chest','Spine',0,.22);
  bone('Neck','Chest',0,.19);bone('Head','Neck',0,.27);bone('Eyes','Head',0,.025,.31);
  for(const [suffix,side]of [['L',-1],['R',1]] as const){
    bone(`UpperArm${suffix}`,'Chest',side*.335,.02);bone(`Forearm${suffix}`,`UpperArm${suffix}`,0,-.285);
    bone(`Hand${suffix}`,`Forearm${suffix}`,0,-.235);
    bone(`Thigh${suffix}`,'Hips',side*.14,-.02);bone(`Shin${suffix}`,`Thigh${suffix}`,0,-.31);bone(`Foot${suffix}`,`Shin${suffix}`,0,-.28);
  }
  const pieces:THREE.BufferGeometry[]=[],regions:ColorRegion[]=[];let vertexCount=0;
  function part(geometry:THREE.BufferGeometry,color:string,boneName:string,x:number,y:number,z=0,scale:[number,number,number]=[1,1,1],rotation:[number,number,number]=[0,0,0],kind:PartKind='fixed'){
    const geo=geometry.index?geometry.toNonIndexed():geometry;
    if(geo!==geometry)geometry.dispose();geo.deleteAttribute('uv');
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation as [number,number,number])),new THREE.Vector3(...scale)));
    const count=geo.getAttribute('position').count,c=new THREE.Color(color),colors=new Float32Array(count*3),indices=new Uint16Array(count*4),weights=new Float32Array(count*4),index=bones.indexOf(byName[boneName]);
    for(let i=0;i<count;i++){colors.set([c.r,c.g,c.b],i*3);indices[i*4]=index;weights[i*4]=1;}
    geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.setAttribute('skinIndex',new THREE.BufferAttribute(indices,4));geo.setAttribute('skinWeight',new THREE.BufferAttribute(weights,4));
    regions.push({start:vertexCount,count,kind,color});vertexCount+=count;pieces.push(geo);
  }
  const round=(w:number,h:number,d:number,r=.07)=>new RoundedBoxGeometry(w,h,d,r<.03?1:2,r);
  const ball=(r:number)=>new THREE.SphereGeometry(r,r<.06?10:14,r<.06?7:10);
  const female=gender==='female';
  part(round(female?.50:.59,.6,.36,.11),guestColors[0],'Chest',0,1.085,0,[1,1,1],[0,0,0],'cloth');
  part(round(.47,.19,.33,.06),guestColors[0],'Hips',0,.73,0,[1,1,1],[0,0,0],'clothDark');
  part(new THREE.CylinderGeometry(.085,.1,.19,12),skinColors[0],'Neck',0,1.42,0,[1,1,1],[0,0,0],'skin');
  part(ball(.335),skinColors[0],'Head',0,1.7,0,[1,.98,.95],[0,0,0],'skin');
  part(new THREE.SphereGeometry(.345,16,10,0,Math.PI*2,0,Math.PI*.43),hairColors[0],'Head',0,1.74,-.015,[1,1,1],[0,0,0],'hair');
  part(new THREE.SphereGeometry(.342,12,10,Math.PI,Math.PI,.35,Math.PI*.57),hairColors[0],'Head',0,1.74,-.02,[1,1,1],[0,0,0],'hair');
  for(const side of [-1,1]){
    part(ball(.058),skinColors[0],'Head',side*.323,1.68,.015,[.65,1,1],[0,0,0],'skin');
    part(ball(.055),'#b47c69','Head',side*.323,1.68,.035,[.5,.7,.5]);
    part(round(.145,.16,.12,.06),hairColors[0],'Head',side*.25,1.815,.23,[1,1,1],[0,0,side*.22],'hair');
    part(ball(.04),'#2f2b2b','Eyes',side*.115,1.72,.299,[.85,1.2,.65]);
    part(ball(.013),'#fff8ed','Eyes',side*.115-.009,1.735,.326);
    part(ball(.04),'#d69889','Head',side*.205,1.635,.255,[1,.4,.22]);
    part(round(.085,.018,.018,.008),hairColors[0],'Head',side*.115,1.793,.294,[1,1,1],[0,0,-side*.1],'hair');
  }
  part(round(.19,.12,.12,.045),hairColors[0],'Head',-.04,1.87,.255,[1,1,1],[0,0,-.28],'hair');
  part(ball(.039),skinColors[0],'Head',0,1.665,.317,[.8,.7,.8],[0,0,0],'skin');
  part(new THREE.TorusGeometry(.046,.009,4,12,Math.PI),'#8d5949','Head',0,1.62,.315,[1,.65,1],[0,0,Math.PI]);
  // Both outfits and their tailoring stay in the same skinned draw call.
  if(female){
    const skirt=new THREE.LatheGeometry([new THREE.Vector2(.48,.22),new THREE.Vector2(.46,.29),new THREE.Vector2(.39,.49),new THREE.Vector2(.30,.72),new THREE.Vector2(.235,.91)],40);
    const positions=skirt.getAttribute('position');
    for(let i=0;i<positions.count;i++){
      const x=positions.getX(i),z=positions.getZ(i),y=positions.getY(i),fold=1+Math.cos(Math.atan2(z,x)*10)*.035*(.95-y)/.73;
      positions.setXYZ(i,x*fold,y,z*fold);
    }
    skirt.computeVertexNormals();part(skirt,guestColors[0],'Hips',0,0,0,[1,1,1],[0,0,0],'cloth');
    const hem=new THREE.TorusGeometry(.48,.012,4,80);hem.rotateX(Math.PI/2);
    const hemPositions=hem.getAttribute('position');
    for(let i=0;i<hemPositions.count;i++){
      const x=hemPositions.getX(i),z=hemPositions.getZ(i),fold=1+Math.cos(Math.atan2(z,x)*10)*.035;
      hemPositions.setXYZ(i,x*fold,hemPositions.getY(i),z*fold);
    }
    hem.computeVertexNormals();part(hem,'#e9d5b1','Hips',0,.225,0);
    part(round(.49,.055,.375,.02),'#e9d5b1','Spine',0,.91,0);
    for(const side of [-1,1]){
      part(ball(.062),'#f2dec3','Spine',side*.052,.91,.21,[1,.65,.35],[0,0,side*.4]);
      part(round(.045,.16,.018,.01),'#e9d5b1','Spine',side*.036,.81,.21,[1,1,1],[0,0,side*.18]);
      part(round(.11,.31,.14,.055),hairColors[0],'Head',side*.285,1.65,-.06,[1,1,1],[0,0,side*.1],'hair');
      part(ball(.019),'#efdab0','Head',side*.329,1.608,.035);
    }
    part(ball(.17),hairColors[0],'Head',0,1.79,-.30,[1,.9,.8],[0,0,0],'hair');
    for(let i=0;i<7;i++){const a=(i/6-.5)*2;part(ball(.014),'#f8eddd','Chest',Math.sin(a)*.12,1.35-Math.cos(a)*.045,.18);}
  }else{
    const shirt=new THREE.BufferGeometry();shirt.setAttribute('position',new THREE.Float32BufferAttribute([-.14,1.37,0,0,.99,0,.14,1.37,0],3));shirt.computeVertexNormals();
    part(shirt,'#fff1db','Chest',0,0,.19);
    for(const side of [-1,1]){
      part(round(.115,.32,.035,.015),guestColors[0],'Chest',side*.115,1.185,.207,[1,1,1],[0,0,side*.32],'clothDark');
      part(ball(.055),'#313f45','Chest',side*.047,1.325,.217,[1,.6,.45]);
      part(round(.1,.025,.025,.008),'#f4e8d2','Chest',side*.19,1.16,.201);
    }
    part(round(.07,.06,.018,.006),'#fff1db','Chest',-.19,1.194,.201,[1,1,1],[0,0,-.15]);
    for(const y of [1.01,.91])part(ball(.015),'#d4b783','Chest',0,y,.198);
    part(round(.20,.12,.15,.055),hairColors[0],'Head',-.12,1.93,.16,[1,1,1],[0,0,-.15],'hair');
  }
  for(const [suffix,side]of [['L',-1],['R',1]] as const){
    part(new THREE.CapsuleGeometry(.103,.12,4,8),guestColors[0],`UpperArm${suffix}`,side*.335,1.115,0,[1,1,1],[0,0,0],'cloth');
    part(new THREE.CapsuleGeometry(.077,.115,4,8),female?skinColors[0]:guestColors[0],`Forearm${suffix}`,side*.335,.84,0,[1,1,1],[0,0,0],female?'skin':'cloth');
    if(!female)part(round(.16,.045,.16,.02),'#f6ecdc',`Forearm${suffix}`,side*.335,.744,0);
    part(ball(.085),skinColors[0],`Hand${suffix}`,side*.335,.699,.015,[.86,1,1],[0,0,0],'skin');
    part(new THREE.CapsuleGeometry(.1,.13,4,8),female?skinColors[0]:guestColors[0],`Thigh${suffix}`,side*.14,.54,0,[1,1,1],[0,0,0],female?'skin':'clothDark');
    part(new THREE.CapsuleGeometry(.09,.12,4,8),female?skinColors[0]:guestColors[0],`Shin${suffix}`,side*.14,.25,0,[1,1,1],[0,0,0],female?'skin':'clothDark');
    part(round(.19,.13,.31,.05),female?'#e4ccb0':'#403730',`Foot${suffix}`,side*.14,.085,.055);
    part(round(.20,.035,.32,.012),'#746452',`Foot${suffix}`,side*.14,.028,.055);
    if(female)part(round(.19,.028,.04,.01),'#e4ccb0',`Foot${suffix}`,side*.14,.155,.02);
  }
  const geometry=mergeGeometries(pieces)!;for(const p of pieces)p.dispose();
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.82,metalness:0}));
  mesh.name='GuestSkin';mesh.userData.colorRegions=regions;mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;
  root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
  const clips=animationClips();root.animations=clips;return {root,clips};
}

const templates:Partial<Record<GuestGender,{root:THREE.Group;clips:THREE.AnimationClip[]}>>={};
const generated:Partial<Record<GuestGender,ReturnType<typeof buildAvatarAsset>>>={};
function avatarAsset(gender:GuestGender){return templates[gender]??(generated[gender]??=buildAvatarAsset(gender));}
let loading:Promise<void>|null=null;
export function preloadAvatarModel(){
  return loading??=(async()=>{
    await Promise.all((['male','female'] as const).map(async gender=>{
      const asset=await new GLTFLoader().loadAsync(gender==='female'?'/models/guest-dress.glb':'/models/guest.glb');
      templates[gender]={root:asset.scene,clips:asset.animations};
    }));
  })();
}

export class GuestModel {
  root:THREE.Group;mesh:THREE.SkinnedMesh;mixer:THREE.AnimationMixer;
  bones:Record<string,THREE.Bone>;source:'glb'|'generated';look:number;
  gender:GuestGender;clothingColor:string;
  private actions:Record<string,THREE.AnimationAction>={};private current='Idle';private accumulated=0;
  constructor(look=0,gender:GuestGender='male',cloth=guestColors[look]){
    this.look=look;this.gender=gender;this.clothingColor=cloth;
    const asset=avatarAsset(gender);
    this.source=templates[gender]?'glb':'generated';this.root=clone(asset.root) as THREE.Group;this.root.userData.avatar=true;
    this.mesh=this.root.getObjectByName('GuestSkin') as THREE.SkinnedMesh;
    this.mesh.geometry=this.mesh.geometry.clone();
    // All ten clips fit in this local-space sphere. Offscreen guests and venue guides
    // can leave the render/shadow passes without recomputing skinned bounds each frame.
    this.mesh.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,1.1,0),1.65);this.mesh.frustumCulled=true;
    this.bones=Object.fromEntries(this.mesh.skeleton.bones.map(b=>[b.name,b]));
    this.mixer=new THREE.AnimationMixer(this.root);
    for(const c of asset.clips){const a=this.mixer.clipAction(c);a.setLoop(['Idle','Walk','Dance'].includes(c.name)?THREE.LoopRepeat:THREE.LoopOnce,Infinity);a.clampWhenFinished=true;this.actions[c.name]=a;}
    this.actions.Idle.play();this.setLook(look,cloth);
  }
  setGender(gender:GuestGender){
    if(this.gender===gender)return;
    const source=avatarAsset(gender).root.getObjectByName('GuestSkin') as THREE.SkinnedMesh;
    this.mesh.geometry.dispose();this.mesh.geometry=source.geometry.clone();this.mesh.userData.colorRegions=source.userData.colorRegions;
    this.gender=gender;this.setLook(this.look,this.clothingColor);
  }
  setLook(look:number,cloth=guestColors[look]){
    this.look=look;this.clothingColor=cloth;const color=this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    for(const region of this.mesh.userData.colorRegions as ColorRegion[]){
      if(region.kind==='fixed')continue;
      const c=new THREE.Color(region.kind.startsWith('cloth')?cloth:region.kind==='skin'?skinColors[look]:hairColors[look]);
      if(region.kind==='clothDark')c.multiplyScalar(.68);
      if(region.kind==='clothLight')c.lerp(new THREE.Color('#fff6e5'),.24);
      for(let i=region.start;i<region.start+region.count;i++)color.setXYZ(i,c.r,c.g,c.b);
    }
    color.needsUpdate=true;
  }
  animate(dt:number,speed:number,gesture:string,reduced=false,distant=false){
    const name=({wave:'Wave',bow:'Bow',respect:'Bow',bows:'Bow',purification:'Bow',fire:'Bow',gifts:'Present',goose:'Present',garlands:'Present',cups:'Cup',toast:'Cup',flower:'Cup',favor:'Cup',commitment:'Promise',congratulate:'Celebrate',congratulations:'Celebrate',petals:'Celebrate',dance:'Dance',photo:'Photo',blessing:'Present'} as Record<string,string>)[gesture]||(speed>.15?'Walk':'Idle');
    if(name!==this.current){const prev=this.actions[this.current],next=this.actions[name];next.reset().setEffectiveWeight(1).play();prev.crossFadeTo(next,reduced?.08:.2,false);this.current=name;}
    this.actions.Walk.timeScale=THREE.MathUtils.clamp(speed/3.8,.45,1.6);
    this.accumulated+=dt;if(distant&&this.accumulated<.1)return;
    this.mixer.update(this.accumulated);this.accumulated=0;
    const blink=(this.mixer.time+this.look*.43)%4.6;
    this.bones.Eyes.scale.y=!reduced&&blink<.12?.1:1;
  }
  dispose(){this.mixer.stopAllAction();this.mixer.uncacheRoot(this.root);this.mesh.skeleton.dispose();}
}

export class GuestPreview {
  private renderer:THREE.WebGLRenderer;private scene=new THREE.Scene();private camera=new THREE.PerspectiveCamera(32,120/150,.1,20);
  private guest=new GuestModel(0,'female',clothingColors[0]);private last=0;private paused=false;
  constructor(canvas:HTMLCanvasElement){
    this.renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    this.renderer.setSize(192,240,false);this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.NeutralToneMapping;
    this.scene.add(new THREE.HemisphereLight('#fff7ef','#b7b49e',2.25));
    const light=new THREE.DirectionalLight('#fff0e2',2.2);light.position.set(-2,4,4);this.scene.add(light);
    this.guest.root.rotation.y=-.25;this.scene.add(this.guest.root);this.camera.position.set(0,1.2,4.6);this.camera.lookAt(0,1.05,0);
    this.renderer.setAnimationLoop(time=>{if(this.paused||document.hidden)return;const dt=Math.min((time-this.last)/1000,.05);this.last=time;
      this.guest.animate(dt,0,'',matchMedia('(prefers-reduced-motion:reduce)').matches);this.renderer.render(this.scene,this.camera);});
  }
  setLook(index:number){this.guest.setLook(index);}
  setAppearance(gender:GuestGender,color:string){this.guest.setGender(gender);this.guest.setLook(0,color);}
  setPaused(paused:boolean){this.paused=paused;}
}
