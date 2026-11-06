import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { districts, districtById, worldMap, toWorld, toLocal, paths, walkable, findPath, zoneAt, type Point } from './map';
import type { CameraMode, District, Snapshot, PlayerSnapshot, WorldState } from './types';
import type { WorldConnection } from './network';
import { GuestModel, guestColors, preloadAvatarModel } from './avatar-model';
import { LocalMovement, SnapshotTrack } from './movement';

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string, roughness = .85) {
  const key = color + roughness;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }));
  return materials.get(key)!;
}
function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material(color)); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function box(parent: THREE.Object3D, w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0) { return mesh(parent, new THREE.BoxGeometry(w, h, d), color, x, y, z); }
function sphere(parent: THREE.Object3D, r: number, color: string, x = 0, y = 0, z = 0, detail = 1) { return mesh(parent, new THREE.IcosahedronGeometry(r, detail), color, x, y, z); }
function cylinder(parent: THREE.Object3D, top: number, bottom: number, height: number, color: string, x = 0, y = 0, z = 0, sides = 12) { return mesh(parent, new THREE.CylinderGeometry(top, bottom, height, sides), color, x, y, z); }
function lineBeam(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, color: string) {
  const m = cylinder(parent, r, r, a.distanceTo(b), color); m.position.copy(a).add(b).multiplyScalar(.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); return m;
}
function textSprite(text: string, color = '#244e43', background = 'rgba(247,248,242,.94)', size = 5): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 160;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = background; ctx.beginPath(); ctx.roundRect(0, 0, 768, 160, 38); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '500 58px "DM Sans", sans-serif'; ctx.fillText(text, 384, 83, 700);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })); sprite.scale.set(size, size * 160 / 768, 1); return sprite;
}
let randomSeed = 20261105;
function random() { randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0; return randomSeed / 4294967296; }
const crownGeometry = new THREE.IcosahedronGeometry(1, 2);
crownGeometry.userData.instanced = true;
const cypressGeometry = new THREE.SphereGeometry(1, 9, 8);
cypressGeometry.userData.instanced = true;

interface Avatar {
  group: THREE.Group; model: GuestModel; label: THREE.Sprite; effect: THREE.Sprite;
  target: PlayerSnapshot; lastPosition: THREE.Vector3; meta: string; walkTime: number; district: string | null;
  wardrobe: THREE.Group; headwear: THREE.Group; prop: THREE.Group; propKey: string;
  track: SnapshotTrack; speed: number;
}

export class GardenScene extends EventTarget {
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(43, 1, .1, 900);
  renderer: THREE.WebGLRenderer;
  mode: CameraMode = 'THIRD_PERSON'; active = false; controlsEnabled = true; photoMode = false;
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  yaw = .8; pitch = .28; zoom = 13; sensitivity = 1;
  position: Point = [0, 24]; predicted: Point = [0, 24]; grants = new Set<string>();
  route: Point[] = []; destination: Point | null = null; destinationName = '';
  landingDistrict = districts[0]; cinematicDistrict: District | null = null; cinematicIndex = 0;
  frameRate = 0;
  private avatars = new Map<number, Avatar>();
  private hosts: GuestModel[] = [];
  private hangingLanterns: THREE.Object3D[] = [];
  private wavingFlags: { geometry: THREE.BufferGeometry; baseX: Float32Array; baseY: Float32Array; phase: number }[] = [];
  private colliders: THREE.Object3D[] = [];
  private foliageView = { focus: { value: new THREE.Vector3() }, camera: { value: new THREE.Vector3() }, enabled: { value: 0 } };
  private keys = new Set<string>();
  private joystick: Point = [0, 0];
  private movement = new LocalMovement();
  private sentMoving = false;
  private currentInput: Point = [0, 0];
  private routeLine: THREE.Line | null = null;
  private routeMarker: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  private raycaster = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private lastInput = 0; private renderTime = 0; private frameCount = 0; private fpsTime = 0;
  private pointer: { x: number; y: number; startX: number; startY: number; time: number; id: number } | null = null;
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private cameraTarget = new THREE.Vector3();
  private previewTarget = new THREE.Vector3();
  private state: WorldState | null = null;
  private localRevision = -1;
  private cameraSnap = true;

  constructor(public canvas: HTMLCanvasElement, private connection: WorldConnection) {
    super();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer:coarse)').matches ? 1.3 : 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#eadfd8'); this.scene.fog = new THREE.FogExp2('#eadfd8', .0015);
    this.scene.add(new THREE.HemisphereLight('#fff7ef', '#b7b49e', 2.25));
    this.sun = new THREE.DirectionalLight('#fff0e2', 2.2); this.sun.position.set(-180, 110, 70);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -75; this.sun.shadow.camera.right = 75; this.sun.shadow.camera.top = 75; this.sun.shadow.camera.bottom = -75;
    this.sun.shadow.camera.near = 5; this.sun.shadow.camera.far = 240; this.sun.shadow.normalBias = .045; this.sun.shadow.bias = -.0003;
    this.scene.add(this.sun, this.sun.target);
    this.buildWorld();
    preloadAvatarModel().catch(() => this.dispatchEvent(new CustomEvent('notice', { detail: 'The guest model is using its built-in version while the model file is unavailable.' })));
    this.routeMarker = mesh(this.scene, new THREE.TorusGeometry(.65, .07, 6, 32), '#f2e4ad', 0, .1, 0);
    this.routeMarker.rotation.x = -Math.PI / 2; this.routeMarker.visible = false; this.routeMarker.userData.dynamic = true;
    this.batchStatic();
    this.loadProps();
    this.previewTarget.fromArray([districts[0].center[0], 0, districts[0].center[1]]);
    this.setupInput(); this.resize();
    window.addEventListener('resize', () => this.resize());
    connection.addEventListener('snapshot', e => this.snapshot((e as CustomEvent<Snapshot>).detail));
    connection.addEventListener('state', e => this.setState((e as CustomEvent<WorldState>).detail));
    connection.addEventListener('disconnected', () => { this.resetInput(); this.movement.reset(this.predicted); });
    document.addEventListener('visibilitychange', () => { this.resetInput(); this.clock.getDelta(); });
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildWorld() {
    const water = cylinder(this.scene, 650, 650, .3, '#83b7b7', 0, -.72, 0, 96); water.castShadow = false;
    cylinder(this.scene, 268, 270, 1.8, '#829572', 0, -1.4, 0, 96);
    // Grass sits below paving, so the full walking network stays visible.
    cylinder(this.scene, 265, 268, .45, '#7b9c72', 0, -.30, 0, 96);
    for (let i = 0; i < 95; i++) {
      const angle = random() * Math.PI * 2, r = 43 + random() * 205, x = Math.sin(angle) * r, z = Math.cos(angle) * r;
      if (districts.some(d => { const p = toLocal(d, x, z); return Math.abs(p[0]) < 50 && Math.abs(p[1]) < 59; })) continue;
      const patch = cylinder(this.scene, 5 + random() * 8, 5 + random() * 8, .012, i % 2 ? '#87a479' : '#73916d', x, -.067, z, 14); patch.scale.z = .55 + random() * .6; patch.rotation.y = angle;
    }
    // Paths are full-width, level connections. District-to-district links form a loop.
    for (const path of paths) {
      const a = new THREE.Vector3(path.a[0], .035, path.a[1]), b = new THREE.Vector3(path.b[0], .035, path.b[1]);
      const road = box(this.scene, path.width, .12, a.distanceTo(b), '#e9d9bb');
      road.position.copy(a).add(b).multiplyScalar(.5); road.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      const direction = b.clone().sub(a), normal = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
      for (const side of [-1, 1]) {
        const curb = box(this.scene, .18, .16, a.distanceTo(b), '#b6a87b'); curb.position.copy(a).add(b).multiplyScalar(.5).addScaledVector(normal, side * (path.width / 2 + .12)); curb.rotation.y = road.rotation.y;
      }
      for (let t = 12; t < a.distanceTo(b) - 8; t += 17) {
        const p = a.clone().lerp(b, t / a.distanceTo(b));
        for (const side of [-1, 1]) {
          const q = p.clone().addScaledVector(normal, side * 7.5);
          this.tree(this.scene, q.x, q.z, 4.2 + random() * 1.5, '#64875d');
          if (t % 34 < 17) this.flowers(this.scene, q.x - normal.x * side * 2, q.z - normal.z * side * 2, '#e3b0b6', .8);
          if (side === 1 && Math.floor(t / 17) % 3 === 0) { const lamp = p.clone().addScaledVector(normal, 5.1); this.gardenLamp(this.scene, lamp.x, lamp.z); }
        }
      }
    }
    // A flush round landing joins the promenade branches at each garden gate.
    for(const d of districts){const p=toWorld(d,...worldMap.gate as Point);cylinder(this.scene,4.15,4.15,.025,'#eadfc9',p[0],.12,p[1],32);}
    this.buildCentralPlaza();
    for(const d of districts)this.buildDistrict(d);
    for(let i=0;i<145;i++){
      const angle=random()*Math.PI*2,radius=211+random()*47;
      const x=Math.sin(angle)*radius,z=Math.cos(angle)*radius;
      if(districts.some(d=>{const p=toLocal(d,x,z);return Math.abs(p[0])<49&&Math.abs(p[1])<56;}))continue;
      this.tree(this.scene,x,z,4+random()*4,i%9===0?'#b1ad80':'#62835b');
    }
    this.buildTransitions();
  }

  private buildCentralPlaza(){
    // 1. NỀN QUẢNG TRƯỜNG ĐÁ KHẢM LA BÀN GIAO HÒA 5 NỀN VĂN HÓA (r = 34.4)
    cylinder(this.scene,34.6,34.8,.15,'#dfd3bc',0,.035,0,96);
    cylinder(this.scene,33.6,33.6,.15,'#eadfc9',0,.042,0,96);
    cylinder(this.scene,26.8,26.8,.04,'#dcd4bc',0,.13,0,80);
    cylinder(this.scene,18.2,18.2,.045,'#efe7d4',0,.135,0,72);
    cylinder(this.scene,9.2,9.2,.05,'#dfd6c0',0,.14,0,64);
    // Các vòng nhẫn đá & đồng khảm đồng tâm trên mặt sân quảng trường
    for(const [r,w,c,y] of [[7.6,.12,'#c7b083',.168],[13.8,.1,'#c9c2ad',.165],[18.2,.14,'#bfa87a',.168],[26.8,.14,'#c4b79b',.165],[33.4,.18,'#b8a98a',.165]] as [number,number,string,number][]){
      const ring=mesh(this.scene,new THREE.TorusGeometry(r,w,6,80),c,0,y,0);ring.rotation.x=Math.PI/2;
    }
    // 16 tia khảm đá phụ tạo họa tiết mặt trời hướng tâm
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8;
      const strip=box(this.scene,.14,.012,32.5,'#cbc4ae',Math.sin(a)*16.5,.162,Math.cos(a)*16.5);strip.rotation.y=a;
    }
    // 5 Mũi tên La Bàn Đá Khảm chính hướng thẳng về 5 Khu Vườn Cưới (mỗi hướng mang sắc màu văn hóa riêng)
    for(const d of districts){
      const angle=Math.atan2(d.center[0],d.center[1]);
      const ray=new THREE.Group();ray.rotation.y=angle;this.scene.add(ray);
      box(ray,1.35,.016,25.2,d.color,0,.166,19.8);
      box(ray,.78,.02,24.4,'#f4ede0',0,.17,19.8);
      box(ray,.24,.024,23.6,d.color,0,.174,19.8);
      // Họa tiết kim cương ở đầu mũi la bàn (r = 10.5 và r = 29.5)
      for(const rz of [10.2,29.8]){
        const gem=box(ray,.95,.026,.95,d.color,0,.176,rz);gem.rotation.y=Math.PI/4;
      }
    }

    // 2. ĐÀI PHUN NƯỚC TRUNG TÂM & ĐÌNH VÒM NHẪN CƯỚI GIAO HÒA (r <= 5.0 tại [0, 0])
    this.plazaFountain();

    // 3. VÒNG GHẾ NGHỈ & BỒN HOA QUẢNG TRƯỜNG (r = 12.2, chừa lối 5 đại lộ)
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4;
      if (districts.some(d => {
        const da = Math.atan2(d.center[0], d.center[1]);
        return Math.abs(Math.atan2(Math.sin(a - da), Math.cos(a - da))) < .25;
      })) continue;
      const bench=new THREE.Group();bench.position.set(Math.sin(a)*12.2,0,Math.cos(a)*12.2);bench.rotation.y=a;
      this.bench(bench,0,0,'#9e7b56');this.scene.add(bench);
      const lampAngle=a+Math.PI/8;
      if(i%2===0)this.gardenLamp(this.scene,Math.sin(lampAngle)*15.2,Math.cos(lampAngle)*15.2);
    }

    // 4. HÀNG LAN CAN ĐÁ CON TIỆN & BỒN HOA NGOẠI VI QUẢNG TRƯỜNG (r = 33.6, chừa lối 5 đại lộ & Lầu Đăng Ký)
    for(let i=0;i<36;i++){
      const a=(i+.5)*Math.PI*2/36,x=Math.sin(a)*33.5,z=Math.cos(a)*33.5;
      // Chừa rộng lối vào của 5 đại lộ hướng về 5 khu vực cưới và khu vực Lầu Đăng Ký Kết Hôn
      if(districts.some(d=>{const da=Math.atan2(d.center[0],d.center[1]);return Math.abs(Math.atan2(Math.sin(a-da),Math.cos(a-da)))<.22;}))continue;
      if(Math.hypot(x-worldMap.registrar[0],z-worldMap.registrar[1])<8.5)continue;
      const seg=new THREE.Group();seg.position.set(x,0,z);seg.rotation.y=a;this.scene.add(seg);
      box(seg,3.8,.22,.48,'#d6cab2',0,.24,0);
      for(const bx of [-1.35,-.45,.45,1.35])cylinder(seg,.08,.11,.68,'#e5dcc8',bx,.66,0,10);
      box(seg,3.9,.14,.54,'#dfd4be',0,1.05,0);
      if(i%3===0){
        box(seg,.68,1.18,.68,'#cfc2a8',0,.72,0);
        cylinder(seg,.34,.22,.36,'#e8dec9',0,1.45,0,12);
        this.flowers(seg,0,0,i%2?'#e8b4bc':'#f2d49b',.48).position.y=1.42;
      }
    }

    // Hàng cây Mộc Lan (Magnolia) tỏa bóng bên ngoài vành đai quảng trường (r = 38.5)
    for(let i=0;i<10;i++){
      const angle=(i+.5)*Math.PI/5,x=Math.sin(angle)*38.5,z=Math.cos(angle)*38.5;
      if(paths.some(p=>{const dx=p.b[0]-p.a[0],dz=p.b[1]-p.a[1],t=Math.max(0,Math.min(1,(x*dx+z*dz)/(dx*dx+dz*dz)));return Math.hypot(x-dx*t,z-dz*t)<6.5;}))continue;
      if(Math.hypot(x-worldMap.registrar[0],z-worldMap.registrar[1])<9.5)continue;
      this.tree(this.scene,x,z,6.8,'#597f68','broadleaf');
    }

    // 5. LẦU ĐĂNG KÝ KẾT HÔN HOA VIÊN (WEDDING REGISTRAR CONSERVATORY PAVILION TẠI [-20, 6])
    this.buildRegistrarPavilion();

    // 6. 5 CỔNG CHÀO VĂN HÓA MỞ RA 5 ĐẠI LỘ KHU VỰC CƯỚI (r = 32.5)
    this.buildCulturalPortals();
  }

  private buildRegistrarPavilion(){
    const registrar=new THREE.Group();registrar.position.set(...[worldMap.registrar[0],0,worldMap.registrar[1]] as [number,number,number]);
    registrar.rotation.y=.5;this.scene.add(registrar);
    // Bệ đá cẩm thạch tròn 2 cấp & viền đồng vàng
    cylinder(registrar,5.6,5.8,.04,'#dfd5be',0,.155,-1.1,48);
    cylinder(registrar,5.1,5.2,.04,'#f0e8d5',0,.18,-1.1,48);
    const rim=mesh(registrar,new THREE.TorusGeometry(5.12,.06,6,48),'#c7a86b',0,.205,-1.1);rim.rotation.x=Math.PI/2;
    // Thảm lụa đỏ đón đôi uyên ương dẫn vào trước bàn đăng ký
    box(registrar,2.2,.015,2.6,'#b84a49',0,.205,1.4);
    for(const sx of [-1.02,1.02])box(registrar,.08,.018,2.6,'#e3c16f',sx,.207,1.4);

    // 6 Cột đá cẩm thạch & khung vòm sắt rèn nghệ thuật xếp hình bán nguyệt phía sau & hai bên bàn đăng ký
    const archCols:[number,number][]=[[-4.1,-.3],[-3.3,-2.8],[-1.3,-4.0],[1.3,-4.0],[3.3,-2.8],[4.1,-.3]];
    for(const [cx,cz] of archCols){
      cylinder(registrar,.26,.32,.38,'#d4c7ad',cx,.36,cz,12);
      cylinder(registrar,.15,.19,3.8,'#f2ead9',cx,2.35,cz,14);
      cylinder(registrar,.26,.18,.28,'#d4c7ad',cx,4.32,cz,12);
    }
    // Dầm vòm đá & Mái hiên lượn sóng kết hợp Mái Vòm Kính Hoa Viên (Conservatory Cupola)
    for(let i=0;i<12;i++){
      const canopy=box(registrar,.72,.10,4.9,i%2?'#f8edcf':'#6e8f7d',-3.96+i*.72,4.45,-2.15);canopy.rotation.x=-.1;
      box(registrar,.72,.28,.10,i%2?'#f8edcf':'#6e8f7d',-3.96+i*.72,4.08,.22);
      const scallop=mesh(registrar,new THREE.CircleGeometry(.36,12,0,Math.PI),i%2?'#f8edcf':'#6e8f7d',-3.96+i*.72,3.94,.27);scallop.rotation.z=Math.PI;
    }
    // Đỉnh vòm Belvedere trung tâm trên nóc Lầu Đăng Ký
    cylinder(registrar,2.3,2.5,.28,'#e8dec7',0,4.72,-2.15,24);
    const dome=mesh(registrar,new THREE.SphereGeometry(2.2,24,14,0,Math.PI*2,0,Math.PI/2),'#789886',0,4.82,-2.15);dome.scale.y=.68;
    for(let i=0;i<8;i++){
      const rib=mesh(registrar,new THREE.TorusGeometry(2.21,.035,6,20,Math.PI/2),'#e5c98a',0,4.82,-2.15);
      rib.rotation.y=i*Math.PI/4;rib.scale.y=.68;
    }
    cylinder(registrar,.12,.22,.42,'#d4af63',0,6.42,-2.15,10);
    // Biểu tượng đôi nhẫn vàng giao nhau trên đỉnh Lầu Đăng Ký
    for(const side of [-1,1]){
      const ringTop=mesh(registrar,new THREE.TorusGeometry(.36,.045,8,28),'#e8c25a',side*.18,6.92,-2.15);
      ringTop.rotation.y=side*.35;ringTop.rotation.z=side*.2;
    }

    // Phông vòm hoa hồng kem & bảng gỗ danh dự phía sau NPC Registrar
    box(registrar,3.2,2.9,.14,'#4f6e5c',0,1.75,-3.45);
    box(registrar,2.85,2.55,.16,'#f5ede0',0,1.75,-3.43);
    const backArch=mesh(registrar,new THREE.TorusGeometry(1.6,.12,8,28,Math.PI),'#d4b26f',0,2.85,-3.38);backArch.rotation.z=0;
    for(let a=0;a<=Math.PI;a+=Math.PI/6)this.flowers(registrar,Math.cos(a)*1.65,-3.32,'#f2c6c2',.38).position.y=2.65+Math.sin(a)*1.55;

    // Bàn Đăng Ký Kết Hôn gỗ gụ & mặt đá cẩm thạch chạm chỉ vàng (được bảo vệ bởi collider, nhân vật không đi xuyên)
    box(registrar,4.4,1.28,1.25,'#356955',0,.72,-1.1);
    box(registrar,4.8,.16,1.65,'#f0e6d0',0,1.42,-1.1);
    box(registrar,4.1,.055,.04,'#d2b67b',0,1.08,-.46);box(registrar,4.1,.055,.04,'#d2b67b',0,.42,-.46);
    for(let i=0;i<13;i++)box(registrar,.055,.55,.04,'#638a70',-1.92+i*.32,.75,-.44);
    // Sổ Đăng Ký Kết Hôn mở đôi, cặp hộp nhẫn nhung đỏ & bình hoa sứ trên mặt bàn
    box(registrar,.92,.08,.62,'#7d2e29',0,1.53,-1.02);
    for(const sx of [-.21,.21])box(registrar,.4,.03,.54,'#fbf6e8',sx,1.58,-1.02);
    for(const rx of [-.85,-.58]){
      box(registrar,.18,.12,.18,'#a32929',rx,1.54,-.98);
      mesh(registrar,new THREE.TorusGeometry(.045,.012,6,16),'#f2ca52',rx,1.62,-.98);
    }
    for(const x of [-1.85,1.85]){
      cylinder(registrar,.19,.27,.38,'#d3b184',x,1.66,-1.1,12);
      this.flowers(registrar,x,-1.1,'#e5c2ab',.34).position.y=1.58;
    }
    for(let i=0;i<3;i++)box(registrar,.65,.08,.48,i%2?'#b58d5e':'#ece1bc',.95,1.54+i*.08,-1.2);

    const npc=this.makeAvatar(0);npc.group.position.set(0,.18,-2.3);npc.group.scale.setScalar(1.15);registrar.add(npc.group);
    this.hosts.push(npc.model);
    npc.label.visible=false;npc.effect.visible=false;
    box(npc.wardrobe,.09,.12,.02,'#e6d2a9',-.15,1.17,.2);
    const sign=textSprite('Wedding Registrar · Lầu Đăng Ký','#244e43','rgba(247,248,242,.95)',7.4);sign.position.set(0,5.85,-1.6);registrar.add(sign);sign.userData.dynamic=true;
  }

  private buildCulturalPortals(){
    // Tại điểm giao giữa Quảng Trường Trung Tâm (r = 32.2) và 5 đại lộ dẫn về 5 khu vực cưới:
    // dựng Đôi Trụ Cổng Biểu Tượng mang kiến trúc đặc trưng của từng quốc gia ở hai bên lề đường (side = ±5.1)
    for(const d of districts){
      const angle=Math.atan2(d.center[0],d.center[1]);
      const portal=new THREE.Group();
      portal.position.set(Math.sin(angle)*32.2,0,Math.cos(angle)*32.2);
      portal.rotation.y=angle;
      this.scene.add(portal);
      for(const side of [-1,1]){
        const px=side*5.1;
        if(d.id==='vietnam'){
          // Đôi Trụ Biểu Tam Quan gạch đỏ & búp sen vàng Việt Nam
          box(portal,.95,.35,.95,'#7d847d',px,.28,0);
          box(portal,.72,3.8,.72,'#9e3e33',px,2.3,0);
          box(portal,.92,.22,.92,'#752b25',px,4.3,0);
          sphere(portal,.28,'#e5be55',px,4.68,0,1).scale.set(.85,1.3,.85);
        }else if(d.id==='japan'){
          // Đôi Trụ Gỗ Hinoki & Đèn Đá Tōrō Nhật Bản
          box(portal,.88,.32,.88,'#8c9187',px,.26,0);
          cylinder(portal,.26,.3,3.6,'#c93829',px,2.2,0,14);
          box(portal,1.15,.22,1.15,'#2e363b',px,4.12,0);
          box(portal,.58,.48,.58,'#f5e4b8',px,4.48,0);
          cylinder(portal,.12,.82,.38,'#3a434a',px,4.88,0,6);
        }else if(d.id==='korea'){
          // Đôi Cột Tròn Hanok Đấu Củng Dancheong & Đèn Lồng Cheongsa-chorong Hàn Quốc
          cylinder(portal,.38,.42,.35,'#b8b3a6',px,.28,0,12);
          cylinder(portal,.24,.27,3.7,'#874736',px,2.25,0,14);
          box(portal,.95,.26,.95,'#38756c',px,4.2,0);
          cylinder(portal,.18,1.05,.55,'#364852',px,4.6,0,4).rotation.y=Math.PI/4;
          cylinder(portal,.22,.22,.36,'#2e5878',px-side*.42,3.55,0,10);
          cylinder(portal,.22,.22,.36,'#b8352b',px-side*.42,3.18,0,10);
        }else if(d.id==='india'){
          // Đôi Trụ Đá Sa Thạch Hồng Đội Vòm Chhatri & Hoa Vạn Thọ Ấn Độ
          box(portal,.95,.36,.95,'#d98468',px,.28,0);
          cylinder(portal,.26,.32,3.5,'#e8be74',px,2.2,0,12);
          box(portal,1.05,.24,1.05,'#f0cfa0',px,4.05,0);
          sphere(portal,.62,'#f5deb5',px,4.52,0,2).scale.set(1,.78,1);
          cylinder(portal,.05,.12,.42,'#d99f2b',px,5.08,0,8);
        }else{
          // Đôi Cột Đá Travertine Cổ Điển & Bình Hoa Medici Urn Ý
          box(portal,.92,.38,.92,'#d8ccb4',px,.28,0);
          cylinder(portal,.24,.28,3.6,'#efe7d3',px,2.25,0,14);
          box(portal,.88,.24,.88,'#d8ccb4',px,4.15,0);
          cylinder(portal,.36,.22,.45,'#e5dac3',px,4.5,0,12);
          sphere(portal,.28,'#5a7d52',px,4.88,0,1);
        }
        this.flowers(portal,px+side*.75,0,d.flower,.62);
      }
      // Bảng chỉ dẫn thanh lịch đặt bên lề phải của cổng chào
      box(portal,3.8,.76,.16,d.color,5.1,2.65,.52);
      box(portal,3.56,.58,.18,'#fcf9ef',5.1,2.65,.53);
      const name=textSprite(`${d.name} · ${d.venue} →`,'#244e43','rgba(0,0,0,0)',3.5);
      name.position.set(5.1,2.66,.65);portal.add(name);
    }
  }

  private buildTransitions(){
    for(const t of worldMap.transitions){
      const a=toWorld(districtById[t.from],0,40),b=toWorld(districtById[t.to],0,40);
      const x=(a[0]+b[0])/2,z=(a[1]+b[1])/2;
      const group=new THREE.Group();group.position.set(x,0,z);group.rotation.y=Math.atan2(b[0]-a[0],b[1]-a[1]);this.scene.add(group);
      if(t.kind==='bamboo'){
        // Cầu Tre & Thủy Tạ Trúc Xanh (Vietnam ↔ Japan)
        box(group,9.6,.06,18,'#569ca6',0,-.04,0).castShadow=false;
        box(group,8.2,.16,14.5,'#b89f78',0,.13,0);
        for(const side of [-1,1]){
          for(let j=-7;j<=7;j+=2){
            cylinder(group,.09,.1,1.15,'#7e8f5e',side*3.9,.65,j,8);
            cylinder(group,.11,.11,.08,'#b5bd8c',side*3.9,.95,j,8);
          }
          cylinder(group,.07,.07,14.6,'#8f9e6b',side*3.9,1.18,0,8).rotation.x=Math.PI/2;
          cylinder(group,.05,.05,14.6,'#8f9e6b',side*3.9,.75,0,8).rotation.x=Math.PI/2;
          for(let j=0;j<9;j++){
            const bx=side*(5.2+random()*3.8),bz=random()*14-7;
            cylinder(group,.08,.1,5.2+random()*2,'#7f9662',bx,3,bz,6);
            sphere(group,.82,'#8ca372',bx,5.2+random(),bz).scale.set(1,.42,1);
          }
        }
      }else if(t.kind==='pergola'){
        // Hành Lang Giàn Hoa Đá Cổ Điển (India ↔ Italy)
        for(const pz of [-6,0,6]){
          this.pergola(group,0,pz,'#e4d8b8');
          for(const side of [-1,1]){
            cylinder(group,.28,.2,.38,'#c97b53',side*4.8,.35,pz,10);
            this.flowers(group,side*4.8,pz,'#f0b643',.65).position.y=.48;
          }
        }
      }else if(t.kind==='stone'){
        // Vườn Đá Thiền & Tháp Đá Seoktap / Tōrō (Japan ↔ South Korea)
        for(const side of [-1,1]){
          cylinder(group,3.8,3.8,.03,'#e6e0d0',side*7.2,.08,0,24);
          for(let j=0;j<3;j++){
            const stone=sphere(group,1.05+j*.26,'#9da195',side*(6.2+j*.8),.48,j*4.2-4.2);
            stone.scale.set(1,.52,1.25);
          }
          // Tháp đá 3 tầng nhỏ bên vườn sỏi
          for(let tier=0;tier<3;tier++){
            const s=1-tier*.22;
            box(group,.95*s,.38,.95*s,'#a8aba0',side*6.8,.35+tier*.52,4.5);
            box(group,1.25*s,.14,1.25*s,'#8d9186',side*6.8,.58+tier*.52,4.5);
          }
        }
      }else if(t.kind==='water'){
        // Hành Lang Hồ Nước & Đài Sen (Italy ↔ Vietnam)
        for(const side of [-1,1]){
          box(group,7.5,.04,32,'#58a6b0',side*9.2,-.05,0).castShadow=false;
          box(group,.24,.45,30,'#dcd2be',side*4.8,.32,0);
          for(let i=-4;i<=4;i+=2){
            cylinder(group,.55,.55,.025,'#64965c',side*8.5,.04,i*3.2,12);
            this.flowers(group,side*8.5,i*3.2,'#f2afc0',.45).position.y=.05;
          }
        }
      }else{
        // Đường Hoa Đào & Vạn Thọ (South Korea ↔ India)
        for(const pz of [-5,5]){
          for(const side of [-1,1])cylinder(group,.16,.2,3.6,'#8c4c38',side*4.2,1.9,pz,10);
          const arch=mesh(group,new THREE.TorusGeometry(4.2,.18,8,28,Math.PI),'#d98d4f',0,3.6,pz);arch.rotation.z=0;
        }
        for(const side of [-1,1])for(let j=-8;j<9;j+=3)this.flowers(group,side*5.8,j,j%2?'#e5b8c3':'#f0b643',1.35);
      }
      const name=textSprite(t.name,'#4a6558','rgba(247,248,242,.92)',7);name.position.set(0,5.2,0);group.add(name);name.userData.dynamic=true;
    }
  }

  private plazaFountain(){
    // ĐÀI PHUN NƯỚC GIAO HÒA & THÁP VÒM CẨM THẠCH 5 CỘT (Nằm gọn trong bán kính collider r <= 5.0 tại [0, 0])
    cylinder(this.scene,7.2,7.4,.09,'#b8c7a3',0,.17,0,64);
    // Thành bể đá Travertine chạm khắc & vòng viền đá cẩm thạch trắng
    cylinder(this.scene,4.95,5.1,.52,'#c7bfa8',0,.42,0,64);
    cylinder(this.scene,4.65,4.65,.07,'#5da5b0',0,.66,0,64).castShadow=false;
    const outerRim=mesh(this.scene,new THREE.TorusGeometry(4.88,.2,10,64),'#f4ebd2',0,.72,0);outerRim.rotation.x=Math.PI/2;
    const brassRim=mesh(this.scene,new THREE.TorusGeometry(5.04,.045,6,64),'#c9a663',0,.73,0);brassRim.rotation.x=Math.PI/2;

    // 8 Đầu phun nước điêu khắc bằng đá & vòng hoa nổi trên mặt hồ
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4,sx=Math.sin(a)*4.72,sz=Math.cos(a)*4.72;
      box(this.scene,.46,.34,.46,'#e5dbc3',sx,.82,sz).rotation.y=a;
      sphere(this.scene,.18,'#d4b475',sx,1.04,sz,1);
      const stream=cylinder(this.scene,.022,.04,1.1,'#aee2e8',Math.sin(a)*3.85,.95,Math.cos(a)*3.85,6);
      stream.rotation.z=-Math.sin(a)*.45;stream.rotation.x=Math.cos(a)*.45;stream.castShadow=false;
      // Cụm hoa sen / hoa trà nổi trên mặt nước
      const fa=a+Math.PI/8;
      cylinder(this.scene,.38,.38,.02,'#669460',Math.sin(fa)*3.4,.70,Math.cos(fa)*3.4,12);
      sphere(this.scene,.15,i%2?'#f2b6c0':'#f7d98c',Math.sin(fa)*3.4,.74,Math.cos(fa)*3.4,1);
    }

    // Đảo đá cẩm thạch trung tâm & 5 Cột Corinth Đá Trắng (Tượng trưng cho 5 Khu Vườn Văn Hóa hội tụ)
    cylinder(this.scene,2.65,2.85,.42,'#ebe2cc',0,.86,0,40);
    cylinder(this.scene,2.35,2.45,.18,'#f6efe0',0,1.12,0,40);
    for(let i=0;i<5;i++){
      const a=i*Math.PI*2/5,cx=Math.sin(a)*2.05,cz=Math.cos(a)*2.05;
      cylinder(this.scene,.22,.26,.28,'#dcd0b6',cx,1.32,cz,12);
      cylinder(this.scene,.14,.17,2.45,'#f7f1e3',cx,2.65,cz,14);
      cylinder(this.scene,.24,.16,.24,'#e0cfa9',cx,3.95,cz,12);
    }
    // Vòng dầm tròn Entablature & Mái Vòm Kính Lồng Đèn (Belvedere Cupola)
    const architrave=mesh(this.scene,new THREE.TorusGeometry(2.05,.18,10,48),'#efe6d2',0,4.15,0);architrave.rotation.x=Math.PI/2;
    const goldBand=mesh(this.scene,new THREE.TorusGeometry(2.18,.045,6,48),'#d4af62',0,4.22,0);goldBand.rotation.x=Math.PI/2;
    for(let i=0;i<10;i++){
      const rib=mesh(this.scene,new THREE.TorusGeometry(2.05,.04,6,24,Math.PI/2),'#d9b972',0,4.2,0);
      rib.rotation.y=i*Math.PI/5;rib.scale.y=.78;
    }
    cylinder(this.scene,.55,.72,.28,'#efe5ce',0,5.82,0,20);
    // Tháp đài phun nước tầng 2 & tầng 3 bên trong lòng 5 cột
    cylinder(this.scene,.48,.72,1.15,'#cbb894',0,1.72,0,20);
    cylinder(this.scene,1.45,1.05,.24,'#f2e8d2',0,2.32,0,36);
    cylinder(this.scene,1.3,1.3,.04,'#6ebbc2',0,2.45,0,36).castShadow=false;
    cylinder(this.scene,.26,.38,.85,'#d4c098',0,2.85,0,16);
    cylinder(this.scene,.78,.52,.18,'#f6efe0',0,3.32,0,28);

    // Biểu tượng Đôi Nhẫn Cưới Vàng Giao Hòa tỏa sáng trên đỉnh vòm trung tâm (y = 6.5)
    for(const side of [-1,1]){
      const ring=mesh(this.scene,new THREE.TorusGeometry(.95,.095,12,64),'#e0b85c',side*.42,6.55,0);
      ring.rotation.y=side*.42;ring.rotation.z=side*.22;
    }
    sphere(this.scene,.18,'#ffe89e',0,7.45,0,1);
    for(let i=0;i<12;i++){
      const a=i*Math.PI/6;
      const stream=cylinder(this.scene,.018,.032,1.35,'#aee2e8',Math.sin(a)*1.28,1.65,Math.cos(a)*1.28,5);stream.castShadow=false;
    }
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8;
      this.flowers(this.scene,Math.sin(a)*6.35,Math.cos(a)*6.35,i%2?'#f4d5a1':'#d9868e',.62);
    }
  }

  private tree(parent: THREE.Object3D, x: number, z: number, size: number, color: string, kind: 'broadleaf' | 'blossom' | 'cypress' = 'broadleaf') {
    const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
    g.updateWorldMatrix(true, false); const center = g.localToWorld(new THREE.Vector3(0, size * .78, 0));
    g.userData.treeSphere = new THREE.Vector4(center.x, center.y, center.z, size * .56);
    cylinder(g, size * .035, size * .067, size * .82, '#78634c', 0, size * .41, 0, 9).userData.foliage = true;
    const light = '#' + new THREE.Color(color).lerp(new THREE.Color(kind === 'blossom' ? '#ffe0de' : '#c4d885'), .3).getHexString();
    const dark = '#' + new THREE.Color(color).multiplyScalar(.75).getHexString();
    if (kind === 'cypress') {
      for (let i = 0; i < 3; i++) {
        const crown = mesh(g, cypressGeometry, i % 2 ? color : dark, 0, size * (.53 + i * .19), 0); crown.scale.set(size * (.17 - i * .035), size * .29, size * (.17 - i * .035)); crown.userData.foliage = true;
      }
      return;
    }
    g.rotation.y = random() * Math.PI * 2;
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4, cx = Math.cos(a) * size * (i === 6 ? 0 : .23), cz = Math.sin(a) * size * (i === 6 ? 0 : .23), cy = size * (i === 6 ? 1.03 : .76 + (i % 3) * .09);
      lineBeam(g, new THREE.Vector3(0, size * .4, 0), new THREE.Vector3(cx, cy, cz), size * .02, '#78634c').userData.foliage = true;
      const crown = mesh(g, crownGeometry, i % 3 === 0 ? light : i % 3 === 1 ? color : dark, cx, cy, cz); crown.scale.set(size * .32, size * (kind === 'blossom' ? .19 : .24), size * .3); crown.rotation.y = a; crown.userData.foliage = true;
    }
  }
  private flowers(parent: THREE.Object3D, x: number, z: number, color: string, size = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
    sphere(g, size * .62, '#66845d', 0, .23, 0, 1).scale.set(1, .45, 1);
    for (let j = 0; j < 3; j++) {
      const a = j * Math.PI * 2 / 3, fx = Math.sin(a) * size * .35, fz = Math.cos(a) * size * .35, fy = .4 + size * .2 + (j % 2) * .16;
      cylinder(g, .018, .025, fy, '#71875d', fx, fy / 2, fz, 5);
      for (let k = 0; k < 5; k++) { const b = k * Math.PI * 2 / 5; const petal = sphere(g, size * .14, color, fx + Math.sin(b) * size * .15, fy, fz + Math.cos(b) * size * .15, 1); petal.scale.y = .5; }
      sphere(g, size * .095, '#dcc27b', fx, fy + .035, fz, 1).scale.y = .55;
    }
    return g;
  }
  private bench(parent: THREE.Object3D, x: number, z: number, color: string) {
    for (let i = 0; i < 4; i++)box(parent, 3, .11, .16, color, x, .69, z - .3 + i * .2);
    for (let i = 0; i < 3; i++)box(parent, 3, .17, .12, color, x, .99 + i * .23, z + .38);
    for (const side of [-1, 1]) {
      box(parent, .12, .68, .7, '#5e705b', x + side * 1.12, .35, z);
      box(parent, .13, 1.35, .13, '#5e705b', x + side * 1.12, .7, z + .36);
      box(parent, .12, .62, .12, '#5e705b', x + side * 1.4, .81, z - .25);
      box(parent, .18, .09, .85, color, x + side * 1.4, 1.13, z + .03);
    }
  }
  private gardenLamp(parent: THREE.Object3D, x: number, z: number) {
    cylinder(parent, .14, .22, .22, '#6a7860', x, .21, z, 10);
    cylinder(parent, .055, .09, 2.8, '#68795f', x, 1.6, z, 8);
    box(parent, .48, .63, .48, '#f1ddb1', x, 3.15, z);
    for (const a of [-1, 1]) for (const b of [-1, 1]) box(parent, .035, .7, .035, '#68795f', x + a * .23, 3.16, z + b * .23);
    cylinder(parent, .03, .4, .22, '#68795f', x, 3.62, z, 4).rotation.y = Math.PI / 4;
  }
  private pergola(parent: THREE.Object3D, x: number, z: number, color: string) {
    for (const side of [-1, 1]) box(parent, .25, 4, .25, color, x + side * 4, 2, z);
    box(parent, 9, .2, .35, color, x, 4, z);
    for (let j = -4; j <= 4; j++)box(parent, .15, .15, 1.7, color, x + j, 4.2, z);
    for (const side of [-1, 1]) this.flowers(parent, x + side * 4, z, '#e0c1b4', .8);
  }
  private roof(parent: THREE.Object3D, w: number, depth: number, height: number, y: number, z: number, color: string, curved = false) {
    const roof = new THREE.Group(); parent.add(roof);
    const elevation = (x: number, dz: number) => {
      const u = Math.abs(x) / (w / 2), v = Math.abs(dz) / (depth / 2);
      return height * Math.pow(1 - u, curved ? 1.55 : 1) + (curved ? .5 * Math.pow(u, 10) + .38 * Math.pow(u, 6) * Math.pow(v, 8) : 0);
    };
    const positions: number[] = [], indices: number[] = [], nx = 24, nz = 12;
    for (let j = 0; j <= nz; j++)for (let i = 0; i <= nx; i++) {
      const x = (i / nx - .5) * w, dz = (j / nz - .5) * depth; positions.push(x, elevation(x, dz), dz);
    }
    for (let j = 0; j < nz; j++)for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setIndex(indices); geo.computeVertexNormals();
    const m = mesh(roof, geo, color, 0, y, z); this.colliders.push(m);
    const underside = mesh(roof, geo.clone(), '#514738', 0, y - .13, z); underside.material = material('#514738').clone(); underside.material.side = THREE.BackSide;
    const trim = '#' + new THREE.Color(color).lerp(new THREE.Color('#dfc28b'), .25).getHexString();
    // Curved tile courses follow the roof surface instead of floating above a flat slab.
    for (let dz = -depth / 2; dz <= depth / 2 + .01; dz += 1.05) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) { const x = (i / 24 - .5) * w; points.push(new THREE.Vector3(x, y + elevation(x, dz) + .045, z + dz)); }
      const edge = Math.abs(dz) > depth / 2 - .5;
      mesh(roof, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 30, edge ? .075 : .035, 4, false), trim);
    }
    cylinder(roof, .15, .15, depth + .55, trim, 0, y + height + .09, z, 10).rotation.x = Math.PI / 2;
    for (const side of [-1, 1]) {
      box(roof, .17, .23, depth - .4, '#746046', side * (w / 2 - .2), y + .2, z);
      if (curved) for (const front of [-1, 1]) {
        const finial = mesh(roof, new THREE.TorusGeometry(.46, .065, 5, 12, Math.PI * .7), trim, side * (w / 2 - .35), y + .99, z + front * depth / 2); finial.rotation.z = side < 0 ? Math.PI : .0;
      }
    }
    for (const front of [-1, 1]) {
      box(roof, w - 3, .23, .22, '#785d40', 0, y - .2, z + front * (depth / 2 - 1));
      lineBeam(roof, new THREE.Vector3(0, y + height - .4, z + front * (depth / 2 - .6)), new THREE.Vector3(-w * .34, y + .25, z + front * (depth / 2 - .6)), .09, '#785d40');
      lineBeam(roof, new THREE.Vector3(0, y + height - .4, z + front * (depth / 2 - .6)), new THREE.Vector3(w * .34, y + .25, z + front * (depth / 2 - .6)), .09, '#785d40');
    }
    return roof;
  }

  private fabricCanopy(parent: THREE.Object3D, w: number, depth: number, height: number, y: number, z: number, color: string) {
    const canopy = new THREE.Group(); parent.add(canopy);
    const positions: number[] = [], indices: number[] = [], colors: number[] = [], n = 16;
    const elevation = (x: number, dz: number) => height * Math.cos(x / w * Math.PI) * Math.cos(dz / depth * Math.PI);
    for (let j = 0; j <= n; j++)for (let i = 0; i <= n; i++) {
      const x = (i / n - .5) * w, dz = (j / n - .5) * depth, h = elevation(x, dz), shade = .68 + .32 * h / height;
      positions.push(x, y + h, z + dz); colors.push(shade, shade, shade);
    }
    for (let j = 0; j < n; j++)for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
    const fabric = new THREE.BufferGeometry(); fabric.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); fabric.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); fabric.setIndex(indices); fabric.computeVertexNormals();
    const tent = mesh(canopy, fabric, color); tent.material = material(color).clone(); tent.material.side = THREE.DoubleSide; tent.material.vertexColors = true; this.colliders.push(tent);
    const trim = '#' + new THREE.Color(color).lerp(new THREE.Color('#f3dfbc'), .48).getHexString();
    for (const [endX, endZ] of [[-w / 2, 0], [w / 2, 0], [0, -depth / 2], [0, depth / 2], [-w / 2, -depth / 2], [w / 2, -depth / 2], [-w / 2, depth / 2], [w / 2, depth / 2]]) {
      const points = []; for (let i = 0; i <= 16; i++) { const x = endX * i / 16, dz = endZ * i / 16; points.push(new THREE.Vector3(x, y + elevation(x, dz) + .025, z + dz)); }
      mesh(canopy, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, .025, 4, false), trim);
    }
    cylinder(canopy, .1, .23, .3, '#c5a36a', 0, y + height + .13, z, 10); sphere(canopy, .12, '#e4c48a', 0, y + height + .35, z, 1);
    return canopy;
  }

  private buildDistrict(d: District) {
    const g = new THREE.Group(); g.position.set(d.center[0], 0, d.center[1]); g.rotation.y = d.rotation; this.scene.add(g);
    box(g, 82, .22, 94, '#89a578', 0, -.01, 0);
    // Base courtyard floor differs by architectural tradition
    if (d.id === 'vietnam') {
      // Sân gạch Bát Tràng đỏ cam đất nung & viền đá xanh Thanh Hóa
      box(g, 58, .09, 75, '#be6a50', 0, .15, -1);
      for (let z = -36; z <= 34; z += 2.2)box(g, 57.4, .008, .04, '#9e4f38', 0, .197, z);
      for (let x = -28; x <= 28; x += 2.2)box(g, .04, .008, 74.4, '#9e4f38', x, .198, -1);
      for (const x of [-30, 30]) box(g, 5, .11, 81, '#9aa299', x, .18, 0);
      for (const z of [-38, 32]) box(g, 65, .11, 5, '#9aa299', 0, .18, z);
    } else if (d.id === 'japan') {
      // Vườn sỏi trắng Karesansui (raked white gravel) & lối đá phiến xám
      box(g, 58, .08, 75, '#e9e4d5', 0, .145, -1);
      for (let x = -26; x <= 26; x += 1.1)if (Math.abs(x) > 3.2) box(g, .06, .012, 68, '#d5ceb8', x, .19, -1);
      for (const [rx, rz, rr] of [[-19, 5, 3.2], [19, -4, 2.8], [-18, -22, 3.5]]) {
        for (const k of [1, 1.6, 2.2]) { const ring = mesh(g, new THREE.TorusGeometry(rr * k * .42, .04, 5, 32), '#cfc7b0', rx, .192, rz); ring.rotation.x = Math.PI / 2; }
      }
      for (const x of [-30, 30]) box(g, 5, .11, 81, '#c7bfab', x, .18, 0);
      for (const z of [-38, 32]) box(g, 65, .11, 5, '#c7bfab', 0, .18, z);
    } else if (d.id === 'korea') {
      // Sân đất nện 마당 (Madang) vàng cát mịn & hành lang đá granite xám
      box(g, 58, .09, 75, '#dfccae', 0, .15, -1);
      for (const x of [-30, 30]) box(g, 5.2, .12, 81, '#bcb8ae', x, .18, 0);
      for (const z of [-38, 32]) box(g, 65, .12, 5.2, '#bcb8ae', 0, .18, z);
    } else if (d.id === 'india') {
      // Đá sa thạch hồng Dholpur & sọc đá cẩm thạch trắng Makrana (Charbagh)
      box(g, 58, .09, 75, '#dfa885', 0, .15, -1);
      for (const z of [-28, -10, 8, 24]) box(g, 56, .015, .45, '#f5ebd6', 0, .196, z);
      for (const x of [-14, 0, 14]) box(g, .45, .015, 72, '#f5ebd6', x, .196, -1);
      for (const x of [-30, 30]) box(g, 5, .11, 81, '#d49572', x, .18, 0);
      for (const z of [-38, 32]) box(g, 65, .11, 5, '#d49572', 0, .18, z);
    } else {
      // Bãi cỏ xanh Giardino all'Italiana cắt tỉa đối xứng & đường sỏi trắng Travertine
      box(g, 58, .08, 75, '#7c996b', 0, .145, -1);
      box(g, 28, .095, 66, '#ede3cc', 0, .155, -4);
      for (const x of [-30, 30]) box(g, 5, .11, 81, '#e8dec7', x, .18, 0);
      for (const z of [-38, 32]) box(g, 65, .11, 5, '#e8dec7', 0, .18, z);
    }
    box(g, 8.5, .09, 18, '#dedbc3', 0, .17, 38);
    // Quiet forecourt, public boards, and the ready circle sit outside circulation.
    this.buildReadyCircle(g, d);
    this.buildInfoBoards(g, d);
    this.buildPrepRooms(g, d);
    this.buildColliderWalls(g, d);
    this.buildSeatingAndAisle(g, d);
    if (d.id === 'vietnam') this.vietnam(g, d);
    if (d.id === 'japan') this.japan(g, d);
    if (d.id === 'korea') this.korea(g, d);
    if (d.id === 'india') this.india(g, d);
    if (d.id === 'italy') this.italy(g, d);
    this.venueDetails(g, d);
    const officiant = this.makeAvatar(2); officiant.group.position.set(0, .3, -25); officiant.group.rotation.y = 0;
    this.hosts.push(officiant.model);
    officiant.label.visible = false; officiant.effect.visible = false; g.add(officiant.group);
    officiant.model.setLook(2, d.id === 'japan' ? '#dedcc4' : d.id === 'vietnam' ? '#a83834' : d.id === 'korea' ? '#3f5e6e' : d.id === 'india' ? '#d98b3a' : '#556b58');
    const label = textSprite(`${d.nativeName} · ${d.venue}`, '#244e43', 'rgba(247,248,242,.95)', 9.5); label.position.set(0, 8.3, -27); g.add(label); label.userData.dynamic = true;
    // District-specific perimeter vegetation, reception zone, and photo garden
    this.buildReceptionAndPhoto(g, d);
  }

  private buildReadyCircle(g: THREE.Group, d: District) {
    // Vòng điểm danh dưới mặt sân chỉ dùng viền đá mảnh thanh lịch, tuyệt đối không đặt cờ hay biểu tượng dưới đất
    const outerStone = mesh(g, new THREE.TorusGeometry(3.12, .045, 6, 48), '#cbc3b0', 0, .215, 24); outerStone.rotation.x = -Math.PI / 2;
    const circle = mesh(g, new THREE.TorusGeometry(3, .065, 6, 48), d.color, 0, .23, 24); circle.rotation.x = -Math.PI / 2;
    // Dựng cột cờ nghi lễ và 1 lá cờ đang tung bay trong gió bên cạnh khu vực tập kết (x = 5.8, z = 24.5)
    this.buildFlyingFlag(g, d, 5.8, 24.5);
  }

  private buildFlyingFlag(g: THREE.Group, d: District, x: number, z: number) {
    // Bệ đá tam cấp & chân cột đồng
    cylinder(g, .85, .98, .26, '#cfc7b4', x, .25, z, 16);
    cylinder(g, .62, .72, .24, '#dfd8c8', x, .48, z, 16);
    cylinder(g, .24, .32, .45, '#8c734b', x, .8, z, 12);
    // Thân cột cờ cao 7.4m & quả cầu vàng trên đỉnh cột
    cylinder(g, .055, .11, 7.2, '#ebe6da', x, 4.2, z, 14);
    sphere(g, .16, '#e5be55', x, 7.92, z, 2);
    // Dây kéo cờ dọc thân cột
    cylinder(g, .012, .012, 6.8, '#c9b382', x + .09, 4.3, z, 6);

    // Lá cờ đang bay (Subdivided PlaneGeometry neo cạnh x=0 vào cột cờ, uốn lượn 3D theo gió)
    const width = 2.45, height = 1.55, segX = 20, segY = 12;
    const geo = new THREE.PlaneGeometry(width, height, segX, segY);
    geo.translate(width / 2, 0, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const baseX = new Float32Array(pos.count), baseY = new Float32Array(pos.count);
    const phase = districts.indexOf(d) * 1.35;
    for (let i = 0; i < pos.count; i++) {
      baseX[i] = pos.getX(i);
      baseY[i] = pos.getY(i);
      const u = baseX[i] / width;
      pos.setZ(i, u * (Math.sin(-u * 4.5 + phase) * .22 + Math.sin(-u * 2.4 + baseY[i] * 1.2 + phase) * .07));
      pos.setY(i, baseY[i] + u * Math.cos(-u * 4.5 + phase) * .04);
    }
    geo.computeVertexNormals();
    const flagMat = new THREE.MeshStandardMaterial({ map: this.makeFlagTexture(d.id), roughness: .62, metalness: .04, side: THREE.DoubleSide });
    const flagMesh = new THREE.Mesh(geo, flagMat);
    flagMesh.position.set(x + .07, 6.85, z);
    flagMesh.rotation.y = -.25;
    flagMesh.castShadow = true;
    flagMesh.receiveShadow = true;
    flagMesh.userData.dynamic = true;
    g.add(flagMesh);
    this.wavingFlags.push({ geometry: geo, baseX, baseY, phase });
  }

  private makeFlagTexture(id: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 340;
    const ctx = canvas.getContext('2d')!;
    const W = 512, H = 340, cx = W / 2, cy = H / 2;
    if (id === 'vietnam') {
      // Quốc kỳ Việt Nam: Nền đỏ thắm, sao vàng 5 cánh ở chính giữa
      ctx.fillStyle = '#da251d'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ffff00'; ctx.beginPath();
      const outerR = 102, innerR = 39;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outerR : innerR, a = -Math.PI / 2 + i * Math.PI / 5;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    } else if (id === 'japan') {
      // Quốc kỳ Nhật Bản (Hinomaru): Nền trắng tinh khôi, vòng tròn mặt trời đỏ ở giữa
      ctx.fillStyle = '#fbfaf5'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#bc002d'; ctx.beginPath(); ctx.arc(cx, cy, 98, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'korea') {
      // Quốc kỳ Hàn Quốc (Taegeukgi): Nền trắng, vòng lưỡng nghi đỏ-xanh và 4 quẻ Càn Khôn Khảm Ly
      ctx.fillStyle = '#fbfaf5'; ctx.fillRect(0, 0, W, H);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-.56);
      const r = 82;
      ctx.fillStyle = '#cd2e3a'; ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0, false); ctx.fill();
      ctx.fillStyle = '#0047a0'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI, false); ctx.fill();
      ctx.fillStyle = '#cd2e3a'; ctx.beginPath(); ctx.arc(-r / 2, 0, r / 2, 0, Math.PI, false); ctx.fill();
      ctx.fillStyle = '#0047a0'; ctx.beginPath(); ctx.arc(r / 2, 0, r / 2, Math.PI, 0, false); ctx.fill();
      ctx.restore();
      const drawTrigram = (tx: number, ty: number, rot: number, bars: [boolean, boolean, boolean]) => {
        ctx.save(); ctx.translate(tx, ty); ctx.rotate(rot); ctx.fillStyle = '#181a1b';
        bars.forEach((solid, idx) => {
          const by = (idx - 1) * 18 - 5;
          if (solid) ctx.fillRect(-34, by, 68, 10);
          else { ctx.fillRect(-34, by, 30, 10); ctx.fillRect(4, by, 30, 10); }
        });
        ctx.restore();
      };
      drawTrigram(cx - 135, cy - 90, -.58, [true, true, true]);
      drawTrigram(cx + 135, cy + 90, -.58, [false, false, false]);
      drawTrigram(cx + 135, cy - 90, .58, [false, true, false]);
      drawTrigram(cx - 135, cy + 90, .58, [true, false, true]);
    } else if (id === 'india') {
      // Quốc kỳ Ấn Độ (Tiranga): 3 dải màu Nghệ tây - Trắng - Xanh lá và bánh xe Ashoka Chakra 24 nan hoa
      ctx.fillStyle = '#ff671f'; ctx.fillRect(0, 0, W, H / 3);
      ctx.fillStyle = '#fbfaf5'; ctx.fillRect(0, H / 3, W, H / 3);
      ctx.fillStyle = '#046a38'; ctx.fillRect(0, H * 2 / 3, W, H / 3);
      ctx.strokeStyle = '#06038d'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, 44, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#06038d'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2;
      for (let i = 0; i < 24; i++) {
        const a = i * Math.PI / 12;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * 43, cy + Math.sin(a) * 43); ctx.stroke();
      }
    } else {
      // Quốc kỳ Ý (Il Tricolore): 3 dải đứng Xanh lá - Trắng - Đỏ
      ctx.fillStyle = '#009246'; ctx.fillRect(0, 0, W / 3, H);
      ctx.fillStyle = '#fbfaf5'; ctx.fillRect(W / 3, 0, W / 3, H);
      ctx.fillStyle = '#ce2b37'; ctx.fillRect(W * 2 / 3, 0, W / 3, H);
    }
    // Hiệu ứng nếp vải dịu nhẹ và viền chỉ may
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, W - 4, H - 4);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private buildInfoBoards(g: THREE.Group, d: District) {
    for (const x of [-10, 10]) {
      if (d.id === 'vietnam') {
        // Bảng gỗ sơn son thếp vàng có mái ngói nhỏ
        for (const s of [-1.25, 1.25]) cylinder(g, .08, .09, 2.7, '#8f3531', x + s, 1.35, 30, 10);
        box(g, 2.8, 1.5, .14, '#a83b36', x, 2.0, 30);
        box(g, 2.5, 1.25, .16, '#f6ebd2', x, 2.0, 30);
        box(g, 3.3, .22, .65, '#7d3c3a', x, 2.88, 30);
      } else if (d.id === 'japan') {
        // Bảng Kosatsu gỗ Hinoki mái đồng đen
        for (const s of [-1.2, 1.2]) box(g, .14, 2.7, .14, '#7a5c40', x + s, 1.35, 30);
        box(g, 2.8, 1.45, .12, '#e5d6b8', x, 2.0, 30);
        box(g, 3.4, .18, .6, '#3c464d', x, 2.85, 30);
      } else if (d.id === 'korea') {
        // Bảng gỗ Hanok sơn xanh ngọc Dancheong & mái ngói xám
        for (const s of [-1.25, 1.25]) cylinder(g, .09, .1, 2.7, '#8c483a', x + s, 1.35, 30, 10);
        box(g, 2.8, 1.5, .14, '#3e6d68', x, 2.0, 30);
        box(g, 2.5, 1.25, .16, '#f0e5ce', x, 2.0, 30);
        box(g, 3.3, .24, .65, '#425660', x, 2.88, 30);
      } else if (d.id === 'india') {
        // Bảng đá sa thạch hồng chạm vòm Jharokha
        for (const s of [-1.3, 1.3]) cylinder(g, .1, .13, 2.7, '#c97b63', x + s, 1.35, 30, 10);
        box(g, 2.8, 1.55, .16, '#d98a6c', x, 2.0, 30);
        box(g, 2.45, 1.25, .18, '#fbf0d9', x, 2.0, 30);
        for (const s of [-.8, 0, .8]) sphere(g, .24, '#e8ae4a', x + s, 2.92, 30, 1);
      } else {
        // Bảng đá cẩm thạch Travertine khắc viền cổ điển
        for (const s of [-1.25, 1.25]) cylinder(g, .11, .13, 2.6, '#dfd5be', x + s, 1.3, 30, 12);
        box(g, 2.8, 1.5, .16, '#efe7d3', x, 2.0, 30);
        box(g, 3.1, .2, .4, '#d2c3a4', x, 2.82, 30);
      }
      const sign = textSprite(x < 0 ? 'Program' : 'Public viewing', '#4d695d', 'rgba(247,248,242,0)', 3); sign.position.set(x, 2.02, 30.14); g.add(sign); sign.userData.dynamic = true;
    }
  }

  private buildPrepRooms(g: THREE.Group, d: District) {
    for (const x of [-20, 20]) {
      const sideLabel = x < 0 ? (d.id === 'vietnam' ? 'Tả Vu · Nhà Trai' : d.id === 'japan' ? 'Hikaeshitsu · Đông' : d.id === 'korea' ? 'Haengrangchae · Tả' : d.id === 'india' ? 'Haveli · Side A' : 'Limonaia · Loggia A') : (d.id === 'vietnam' ? 'Hữu Vu · Nhà Gái' : d.id === 'japan' ? 'Hikaeshitsu · Tây' : d.id === 'korea' ? 'Haengrangchae · Hữu' : d.id === 'india' ? 'Haveli · Side B' : 'Limonaia · Loggia B');
      if (d.id === 'vietnam') {
        // Nhà Tả Vu / Hữu Vu gỗ lim 3 gian, nền gạch đỏ, bàn trưng tráp sơn son
        box(g, 13.2, .24, 12.2, '#9c503f', x, .24, 19.5);
        const r = this.roof(g, 15.4, 14.2, 2.8, 4.1, 19.5, '#8a3b37', true); r.position.x = x;
        for (const a of [x - 5.8, x - 2, x + 2, x + 5.8]) cylinder(g, .18, .22, 3.9, '#6e3226', a, 2.1, 13.8, 12);
        box(g, 4.6, .85, 1.1, '#9e3632', x, .68, 22.8);
        box(g, 4.8, .1, 1.25, '#dfb962', x, 1.14, 22.8);
        // Tráp trầu cau sơn mài đỏ nắp vàng trên bàn chuẩn bị
        for (const tx of [-1.4, 0, 1.4]) {
          cylinder(g, .38, .38, .26, '#b32e29', x + tx, 1.32, 22.8, 16);
          cylinder(g, .32, .38, .14, '#e4bd5b', x + tx, 1.5, 22.8, 16);
        }
      } else if (d.id === 'japan') {
        // Trà thất Hikaeshitsu vách giấy Shoji, hiên gỗ Hinoki & hành lang có mái
        box(g, 13.4, .28, 12.2, '#b89b72', x, .26, 19.5);
        box(g, 12.2, .06, 11.0, '#d4cfa9', x, .42, 19.5); // Chiếu Tatami xanh nhạt
        const r = this.roof(g, 15.6, 14.4, 2.4, 4.0, 19.5, '#3d484f', true); r.position.x = x;
        for (const a of [x - 6.0, x - 2.0, x + 2.0, x + 6.0]) box(g, .24, 3.8, .24, '#8c6d46', a, 2.1, 13.8);
        // Khung cửa lùa Shoji ở mặt sau phòng chuẩn bị
        for (const sx of [-3.5, 0, 3.5]) {
          box(g, 3.1, 2.8, .08, '#f5f0e1', x + sx, 1.9, 24.8);
          for (const h of [1.2, 1.9, 2.6]) box(g, 3.0, .04, .1, '#8c6d46', x + sx, h, 24.78);
        }
        // Kệ treo Kimono Uchikake chữ T (Ikō)
        for (const kx of [-1.6, 1.6]) {
          cylinder(g, .05, .07, 1.9, '#593e25', x + kx, 1.35, 22.5, 8);
          box(g, 1.5, .07, .07, '#593e25', x + kx, 2.28, 22.5);
          box(g, 1.2, 1.35, .12, x < 0 ? '#f5efe0' : '#c95b6b', x + kx, 1.55, 22.5);
        }
      } else if (d.id === 'korea') {
        // Dãy nhà phụ Haengrangchae nền đá bậc thềm, sàn gỗ Maru, bình gốm Celadon
        box(g, 13.4, .32, 12.2, '#b5afa2', x, .26, 19.5);
        box(g, 12.6, .1, 11.4, '#9e7348', x, .46, 19.5);
        const r = this.roof(g, 15.6, 14.2, 2.6, 4.1, 19.5, '#3e5059', true); r.position.x = x;
        for (const a of [x - 5.8, x - 1.9, x + 1.9, x + 5.8]) cylinder(g, .19, .22, 3.8, '#874736', a, 2.1, 13.8, 12);
        box(g, 12.4, .22, .28, '#427a70', x, 3.85, 13.8); // Dầm sơn Dancheong xanh ngọc
        box(g, 4.2, .65, 1.2, '#784f30', x, .78, 22.8);
        for (const cx of [-1.1, 1.1]) sphere(g, .28, '#7ea898', x + cx, 1.32, 22.8, 2).scale.set(1, 1.3, 1);
      } else if (d.id === 'india') {
        // Đình chuẩn bị Haveli đá hồng với 4 cột trạm trổ & mái vòm củ hành Chhatri
        box(g, 13.4, .28, 12.2, '#d99578', x, .25, 19.5);
        box(g, 11.8, .05, 10.6, '#b83b56', x, .41, 19.5); // Thảm Dhurrie đỏ hồng
        this.fabricCanopy(g, 15.2, 14.0, 1.8, 4.1, 19.5, '#b8465d').position.x = x;
        // Đỉnh vòm Chhatri ở trung tâm mái phòng chuẩn bị
        cylinder(g, 1.8, 2.1, .45, '#e3b578', x, 5.2, 19.5, 16);
        sphere(g, 1.65, '#f0d49c', x, 5.75, 19.5, 2).scale.set(1, .75, 1);
        cylinder(g, .08, .18, .65, '#d4a038', x, 6.55, 19.5, 10);
        for (const a of [x - 6.0, x - 2.2, x + 2.2, x + 6.0]) {
          cylinder(g, .2, .25, 3.9, '#deb178', a, 2.1, 13.7, 12);
          for (let fy = 1.2; fy <= 3.4; fy += .55)sphere(g, .22, d.flower, a, fy, 13.7, 1);
        }
        // Kệ treo vòng hoa vạn thọ Jaimala
        box(g, 4.4, .75, 1.1, '#c77c43', x, .78, 22.8);
        for (const gx of [-1.2, 0, 1.2]) {
          const gr = mesh(g, new THREE.TorusGeometry(.35, .08, 8, 20), '#f2ab33', x + gx, 1.45, 22.8); gr.rotation.x = Math.PI / 3;
        }
      } else {
        // Cánh biệt thự Limonaia (nhà trồng chanh vùng Tuscany) với 3 vòm Loggia bằng gạch & đá
        box(g, 13.4, .24, 12.2, '#e3d1b4', x, .23, 19.5);
        const r = this.roof(g, 15.4, 14.0, 1.85, 4.2, 19.5, '#b56b4d', false); r.position.x = x;
        for (const a of [x - 6.0, x - 2.0, x + 2.0, x + 6.0]) box(g, .48, 3.9, .48, '#e8d8bc', a, 2.1, 13.7);
        for (const archX of [x - 4.0, x, x + 4.0]) {
          const arch = mesh(g, new THREE.TorusGeometry(1.75, .22, 6, 24, Math.PI), '#dec8a4', archX, 3.1, 13.7); arch.rotation.z = 0;
        }
        // Chậu đất nung Terracotta trồng cây chanh vàng cạnh bàn chuẩn bị
        box(g, 4.0, .8, 1.0, '#d8c5a2', x, .65, 22.8);
        for (const lx of [-4.5, 4.5]) {
          cylinder(g, .48, .34, .62, '#b86748', x + lx, .55, 22.8, 12);
          sphere(g, .68, '#567848', x + lx, 1.35, 22.8, 1);
          for (const [ox, oz] of [[.35, .2], [-.3, .25], [.1, -.35]]) sphere(g, .11, '#f2cf46', x + lx + ox, 1.4, 22.8 + oz, 1);
        }
      }
      const name = textSprite(sideLabel, '#425e51', 'rgba(247,248,242,.92)', 5.6); name.position.set(x, 3.15, 13.1); g.add(name); name.userData.dynamic = true;
    }
  }

  private buildColliderWalls(g: THREE.Group, d: District) {
    for (const c of worldMap.colliders) {
      if (c.material !== 'wall' && c.material !== 'backdrop') continue;
      const b = c.bounds, w = b[1] - b[0], depth = b[3] - b[2], cx = (b[0] + b[1]) / 2, cz = (b[2] + b[3]) / 2;
      const isBackdrop = c.material === 'backdrop';
      // Wall color and architectural cap tailored per district while preserving exact collider footprint
      const wallColor = d.id === 'vietnam' ? (isBackdrop ? '#8c342f' : '#b55d47') :
        d.id === 'japan' ? (isBackdrop ? '#5e4835' : '#ded6c1') :
          d.id === 'korea' ? (isBackdrop ? '#6b4f3a' : '#d8cbb4') :
            d.id === 'india' ? (isBackdrop ? '#b54a5a' : '#d98d73') :
              (isBackdrop ? '#e5cfa6' : '#dfd3ba');
      const m = box(g, w, c.height, depth, wallColor, cx, c.height / 2 + .2, cz);
      this.colliders.push(m);
      // Add distinctive architectural crowning / surface treatment on top of the collider walls
      if (!isBackdrop) {
        if (d.id === 'vietnam') {
          // Tường gạch hoa gió & mái ngói bò viền đỉnh tường
          box(g, w + .16, .22, depth + .16, '#783937', cx, c.height + .28, cz);
        } else if (d.id === 'japan') {
          // Tường Tsuijibei chân đá, thân vữa trắng có 3 đường kẻ ngang & mái ngói xám đen
          box(g, w + .06, .65, depth + .06, '#8d8f84', cx, .52, cz);
          box(g, w + .22, .24, depth + .22, '#3f4a52', cx, c.height + .28, cz);
        } else if (d.id === 'korea') {
          // Tường hoa Kkotdam (꽃담) ốp gạch họa tiết chữ Thọ/Hoa & mái ngói Hanok
          box(g, w + .24, .26, depth + .24, '#3c4e57', cx, c.height + .29, cz);
          if (w > depth) {
            for (let fx = b[0] + 1.5; fx <= b[1] - 1.5; fx += 2.6)box(g, 1.1, 1.1, depth + .06, '#bf6952', fx, 2.1, cz);
          } else {
            for (let fz = b[2] + 1.5; fz <= b[3] - 1.5; fz += 2.6)box(g, w + .06, 1.1, 1.1, '#bf6952', cx, 2.1, fz);
          }
        } else if (d.id === 'india') {
          // Tường cung điện đá hồng với hàng chóp Kangura (battlements) trên đỉnh
          box(g, w + .14, .18, depth + .14, '#f0cfa0', cx, c.height + .25, cz);
          const span = Math.max(w, depth), steps = Math.floor(span / 1.1);
          for (let i = 0; i < steps; i++) {
            const offset = -span / 2 + .55 + i * 1.1;
            sphere(g, .24, '#d98d73', w > depth ? cx + offset : cx, c.height + .48, w > depth ? cz : cz + offset, 1);
          }
        } else {
          // Tường đá Travertine ghép phào chỉ cổ điển & bình trồng hoa trên trụ góc
          box(g, w + .18, .22, depth + .18, '#cbb997', cx, c.height + .26, cz);
        }
      }
    }
    // District-specific extra colliders (e.g. India acoustic Jaali screen wall)
    for (const c of d.colliders || []) {
      const b = c.bounds, w = b[1] - b[0], depth = b[3] - b[2], cx = (b[0] + b[1]) / 2, cz = (b[2] + b[3]) / 2;
      const m = box(g, w, c.height, depth, '#e09a7e', cx, c.height / 2 + .2, cz);
      this.colliders.push(m);
      if (c.material === 'jaali') {
        // Tường hoa gió đá chạm lộng Jaali cách âm giữa Mandap và sân nhảy Sangeet
        box(g, w + .18, .26, depth + .2, '#f2d29b', cx, c.height + .28, cz);
        for (let jz = b[2] + 1.1; jz <= b[3] - 1.1; jz += 1.6) {
          cylinder(g, .12, .12, c.height - .4, '#f5deb3', cx, c.height / 2 + .2, jz, 8);
          sphere(g, .26, '#f0b643', cx, c.height + .58, jz, 1);
        }
      }
    }
  }

  private buildSeatingAndAisle(g: THREE.Group, d: District) {
    // Priority family seating (z = -2, 2) and public viewing rows (z = 12, 16, 20)
    // Plus distinct aisle runner and stage platform per culture
    if (d.id === 'vietnam') {
      // Sập gụ / Bàn trà gia tộc hai họ gỗ lim đỏ với ấm chén sứ & khay hạt bí
      for (const z of [-2, 2]) for (const x of [-6.5, 6.5]) {
        this.bench(g, x, z, '#8c382d');
        box(g, 2.2, .52, .65, '#752b22', x, .46, z - 1.05);
        box(g, 2.35, .06, .75, '#d9b15f', x, .74, z - 1.05);
        cylinder(g, .14, .11, .22, '#f2eee1', x - .35, .86, z - 1.05, 12);
        for (const cx of [-.05, .22, .48]) cylinder(g, .06, .05, .1, '#f2eee1', x + cx, .81, z - 1.05, 10);
      }
      for (const z of [12, 16, 20]) for (const x of [-6.5, 6.5]) this.bench(g, x, z, '#9e4b3e');
      // Chiếu đỏ thảm lụa thêu viền vàng dọc lối rước lễ
      box(g, 2.5, .02, 28, '#b32e28', 0, .23, 7);
      for (const side of [-1.15, 1.15]) box(g, .12, .024, 28, '#e5c165', side, .232, 7);
      // Nền Nhà Đại Bái bậc tam cấp đá xanh & sàn gạch Bát Tràng đỏ sẫm
      box(g, 20.8, .16, 22.6, '#7d847d', 0, .19, -18);
      box(g, 20.0, .14, 22.0, '#9c3d35', 0, .25, -18);
    } else if (d.id === 'japan') {
      // Ghế băng phủ dạ đỏ Mōsen (毛氈) truyền thống trong vườn trà / đền thần đạo
      for (const z of [-2, 2, 12, 16, 20]) for (const x of [-6.5, 6.5]) {
        box(g, 3.1, .45, .72, '#c43733', x, .46, z);
        box(g, 3.16, .08, .78, '#d9433f', x, .70, z);
        for (const s of [-1.25, 1.25]) box(g, .14, .44, .66, '#332d29', x + s, .23, z);
      }
      // Lối đi đá phiến Sandō (参道) ghép từng phiến đá xám trên sỏi trắng
      box(g, 2.6, .018, 28, '#aba596', 0, .225, 7);
      for (let sz = -6; sz <= 20; sz += 1.6)box(g, 2.3, .026, 1.25, '#c8c2b2', 0, .235, sz);
      // Đài lễ gỗ Bách Hinoki (Haiden) nâng sàn với bậc thềm Kizahashi
      box(g, 20.4, .22, 22.2, '#c7aa7e', 0, .24, -18);
      box(g, 19.4, .08, 21.2, '#d9c096', 0, .36, -18);
      for (const step of [0, 1]) box(g, 5.2, .12, .65, '#b8996c', 0, .22 + step * .08, -6.8 - step * .55);
    } else if (d.id === 'korea') {
      // Sạp gỗ Pyong-sang (평상) trải đệm lụa thêu đỏ-xanh cho hai họ
      for (const z of [-2, 2]) for (const x of [-6.5, 6.5]) {
        box(g, 3.1, .12, 1.15, '#875b39', x, .56, z);
        for (const s of [-1.3, 1.3]) for (const f of [-.45, .45]) box(g, .14, .54, .14, '#6e482b', x + s, .28, z + f);
        for (const px of [-.8, .8]) box(g, 1.1, .12, .85, x < 0 ? '#b84a45' : '#3b6978', x + px, .66, z);
      }
      for (const z of [12, 16, 20]) for (const x of [-6.5, 6.5]) this.bench(g, x, z, '#8c6645');
      // Đường đá hoàng đạo 어도 (Eodo) viền lụa xanh-đỏ
      box(g, 2.5, .02, 28, '#cfc3ab', 0, .23, 7);
      box(g, 1.5, .025, 28, '#457378', 0, .234, 7);
      // Bệ đá 화강암 (Granite) & sàn gỗ 대청마루 (Daecheong-maru) nâu trầm
      box(g, 20.8, .22, 22.6, '#c2bdb2', 0, .23, -18);
      box(g, 19.8, .12, 21.6, '#855836', 0, .34, -18);
    } else if (d.id === 'india') {
      // Trường kỷ Diwan bọc nhung đỏ/vàng với gối tựa lưng tròn Masnad (Bolster) hai đầu
      for (const z of [-2, 2]) for (const x of [-6.5, 6.5]) {
        box(g, 3.2, .42, .95, '#d49b4b', x, .42, z);
        box(g, 3.05, .16, .88, x < 0 ? '#b53852' : '#d97925', x, .68, z);
        box(g, 3.05, .55, .18, '#9e2a42', x, .98, z + .38);
        for (const s of [-1.25, 1.25]) {
          const bolster = cylinder(g, .18, .18, .78, '#f2c45a', x + s, .84, z - .05, 12);
          bolster.rotation.x = Math.PI / 2;
        }
      }
      for (const z of [12, 16, 20]) for (const x of [-6.5, 6.5]) this.bench(g, x, z, '#c77c43');
      // Thảm rước Baraat đỏ thẫm rải cánh hoa cúc vạn thọ vàng cam hai bên
      box(g, 2.6, .02, 28, '#9e2b45', 0, .23, 7);
      for (let fz = -5; fz <= 20; fz += 2.2)for (const fx of [-1.45, 1.45]) sphere(g, .18, '#f5b038', fx, .26, fz, 1).scale.y = .4;
      // Bệ đá sa thạch chạm khắc & sàn Mandap trải thảm hoa
      box(g, 20.6, .22, 22.4, '#d9936a', 0, .23, -18);
      box(g, 19.6, .08, 21.4, '#f0cfa0', 0, .34, -18);
    } else {
      // Ghế gỗ Chiavari sơn trắng ngà gắn nơ lụa & nhành ô liu dọc lối đi đá Travertine
      for (const z of [-2, 2, 12, 16, 20]) for (const x of [-6.5, 6.5]) {
        this.bench(g, x, z, z < 7 ? '#efe8d5' : '#dcd3bc');
        const innerX = x < 0 ? x + 1.52 : x - 1.52;
        sphere(g, .18, '#f7efe0', innerX, .95, z - .2, 1);
        sphere(g, .14, '#6d8a63', innerX, 1.08, z - .2, 1);
      }
      // Lối đi đá Travertine trắng kem viền cỏ hoàng dương (Boxwood) thấp
      box(g, 2.6, .02, 28, '#f4eee1', 0, .23, 7);
      for (const side of [-1.5, 1.5]) box(g, .32, .28, 26, '#5c7d53', side, .34, 7);
      // Bệ đá Villa Terrazzo lát gạch xương cá sáng màu
      box(g, 20.6, .18, 22.4, '#e8dcc4', 0, .22, -18);
      box(g, 19.6, .06, 21.4, '#f3ead8', 0, .32, -18);
    }
  }

  private buildReceptionAndPhoto(g: THREE.Group, d: District) {
    // Outer trees & floral borders tailored to each district's botanical identity
    for (const z of [-31, -22, -13, 0, 31]) for (const x of [-34, 34]) this.flowers(g, x, z, d.flower, 1.5);
    for (const x of [-43, 43]) for (const z of [-35, -10, 17, 38]) {
      const treeColor = d.id === 'japan' ? '#e8b0c4' : d.id === 'italy' ? '#46694f' : d.id === 'vietnam' ? '#5c8553' : d.id === 'korea' ? '#547858' : '#6e8c52';
      const treeKind = d.id === 'japan' ? 'blossom' : d.id === 'italy' ? 'cypress' : 'broadleaf';
      this.tree(g, x, z, d.id === 'italy' ? 8.5 : 6.2 + random() * 2, treeColor, treeKind);
    }

    // 1. RECEPTION ZONE AT [26, -31] — Culturally distinct architecture & banquet layout
    if (d.id === 'vietnam') {
      // Vườn Tiệc Bàn Tròn Đỏ Vàng dưới giàn đèn lồng lụa (Không dùng Pergola Ý!)
      cylinder(g, 6.8, 6.8, .12, '#b55443', 26, .22, -31, 32);
      for (const [px, pz] of [[20, -36], [32, -36], [20, -26], [32, -26]]) {
        cylinder(g, .14, .18, 4.2, '#8f322c', px, 2.2, pz, 10);
        sphere(g, .38, '#d9382e', px, 3.8, pz, 1).scale.set(1, 1.25, 1);
      }
      lineBeam(g, new THREE.Vector3(20, 4.1, -36), new THREE.Vector3(32, 4.1, -26), .03, '#d4af53');
      lineBeam(g, new THREE.Vector3(32, 4.1, -36), new THREE.Vector3(20, 4.1, -26), .03, '#d4af53');
      // 3 Bàn tiệc tròn khăn trải bàn đỏ tươi, mâm xoay vàng & ghế đẩu gỗ đặt tại khu tiệc (z = -34.5)
      for (const [tx, tz] of [[26, -34.5], [23.2, -34.5], [28.8, -34.5]]) {
        cylinder(g, 1.45, 1.45, .78, '#b82925', tx, .6, tz, 24);
        cylinder(g, 1.52, 1.58, .18, '#d6342f', tx, .92, tz, 24);
        cylinder(g, .70, .70, .06, '#e8c468', tx, 1.03, tz, 20);
        this.flowers(g, tx, tz, '#f2c6b6', .42).position.y = 1.02;
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3;
          cylinder(g, .22, .20, .46, '#7a3728', tx + Math.cos(a) * 1.85, .45, tz + Math.sin(a) * 1.85, 12);
        }
      }
      const reception = textSprite('Tiệc Bàn Tròn & Trà Chúc Phúc', '#7d2e29', 'rgba(251,248,238,.92)', 6.5); reception.position.set(26, 4.8, -31); g.add(reception); reception.userData.dynamic = true;
    } else if (d.id === 'japan') {
      // Hiên Trà Thất Chashitsu với Ô Cửa Tròn Trăng Rằm (Marumado) & Dù Đỏ Bangasa
      box(g, 11.5, .22, 11.5, '#b89b72', 26, .24, -31);
      box(g, 10.2, .06, 10.2, '#d4cfa9', 26, .37, -31);
      // Vách tường trà thất với ô cửa tròn Marumado ở z = -36.5
      box(g, 9.5, 3.8, .22, '#eae2ce', 26, 2.1, -36.4);
      const marumado = mesh(g, new THREE.TorusGeometry(1.35, .16, 8, 32), '#5c432c', 26, 2.35, -36.25); marumado.rotation.z = 0;
      for (let i = -2; i <= 2; i++)box(g, .03, 2.5, .03, '#785e42', 26 + i * .42, 2.35, -36.26);
      this.roof(g, 12.5, 4.2, 1.6, 4.0, -36.2, '#3d484f', true).position.x = 26;
      // Dù giấy đỏ lớn Nodate Bangasa (野点傘) & bàn trà thấp cắm hoa Ikebana
      cylinder(g, .08, .08, 3.9, '#593822', 23.2, 2.1, -33.2, 10);
      cylinder(g, .15, 2.85, .65, '#c9342e', 23.2, 3.85, -33.2, 24);
      cylinder(g, 1.1, 1.1, .05, '#f2ead5', 23.2, 3.88, -33.2, 20);
      box(g, 2.8, .45, 1.5, '#6e4c2e', 26.0, .62, -34.5);
      this.flowers(g, 26.0, -34.5, '#e85a70', .58).position.y = .85;
      for (const [cx, cz] of [[24.5, -33.2], [27.5, -33.2], [24.5, -35.6], [27.5, -35.6]]) box(g, .75, .12, .75, '#b83b35', cx, .44, cz);
      const reception = textSprite('Hiên Trà Marumado & Ikebana', '#3b4f44', 'rgba(251,248,238,.92)', 6.5); reception.position.set(26, 5.0, -31); g.add(reception); reception.userData.dynamic = true;
    } else if (d.id === 'korea') {
      // Lầu Nghi Thức Gia Đình Pyebaek-sil (폐백실) với Bình Phong & Tháp Táo Đỏ / Hạt Dẻ
      box(g, 11.6, .28, 11.0, '#b8b2a4', 26, .25, -31);
      box(g, 10.6, .12, 10.0, '#8c5e3a', 26, .42, -31);
      const r = this.roof(g, 13.2, 11.8, 2.5, 4.2, -31, '#3e5059', true); r.position.x = 26;
      for (const [px, pz] of [[20.5, -35.5], [31.5, -35.5], [20.5, -26.5], [31.5, -26.5]]) cylinder(g, .2, .23, 3.8, '#874736', px, 2.1, pz, 12);
      // Bình phong 6 cánh Byeongpung (병풍) phía sau bàn Pyebaek
      for (let i = -2.5; i <= 2.5; i++) {
        const fold = box(g, 1.15, 2.4, .08, '#ede1c7', 26 + i * 1.12, 1.68, -35.6 + (Math.abs(i) % 1 === .5 ? .15 : -.15));
        fold.rotation.y = (i % 2 === 0 ? .18 : -.18);
        box(g, .85, 1.6, .09, i % 2 === 0 ? '#568278' : '#b85d4b', 26 + i * 1.12, 1.68, -35.54);
      }
      // Bàn thấp Pyebaek sơn mài với 2 tháp táo đỏ (Jujube) & hạt dẻ (Chestnut)
      box(g, 3.8, .55, 1.5, '#5e2b24', 26, .72, -34.5);
      box(g, 3.95, .08, 1.62, '#b83b35', 26, 1.02, -34.5);
      cylinder(g, .18, .48, .65, '#9e2925', 24.9, 1.38, -34.5, 16); // Tháp táo đỏ Daechu
      cylinder(g, .18, .48, .65, '#d49b4b', 27.1, 1.38, -34.5, 16); // Tháp hạt dẻ Bam
      for (const cx of [24.8, 27.2]) box(g, .9, .14, .9, '#3c677a', cx, .52, -32.8); // Đệm quỳ lạy 방석
      const reception = textSprite('Lầu Pyebaek · Chúc Phúc Gia Đình', '#385459', 'rgba(251,248,238,.92)', 6.6); reception.position.set(26, 5.2, -31); g.add(reception); reception.userData.dynamic = true;
    } else if (d.id === 'india') {
      // Sân Khấu Vũ Điệu Sangeet Tròn (Tách âm bởi tường Jaali) & Trống Dhol Hoàng Gia
      cylinder(g, 6.8, 7.2, .24, '#c97355', 26, .24, -31, 36);
      cylinder(g, 5.8, 5.8, .08, '#f2c464', 26, .38, -31, 32);
      cylinder(g, 4.2, 4.2, .09, '#b83552', 26, .41, -31, 24);
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6, petal = mesh(g, new THREE.CircleGeometry(.65, 10), i % 2 ? '#f7d060' : '#e66c40', 26 + Math.cos(a) * 4.9, .45, -31 + Math.sin(a) * 4.9);
        petal.rotation.x = -Math.PI / 2;
      }
      // Mái lều Shamiyana lục giác rực rỡ phía trên sân nhảy Sangeet
      this.fabricCanopy(g, 12.5, 12.5, 2.2, 4.6, -31, '#d44860').position.x = 26;
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3, px = 26 + Math.cos(a) * 5.8, pz = -31 + Math.sin(a) * 5.8;
        cylinder(g, .15, .2, 4.3, '#e3b568', px, 2.3, pz, 10);
      }
      // Bộ trống Dhol lớn & bục nhạc cụ bên mép sân khấu (z = -35.2)
      const dhol = cylinder(g, .48, .48, 1.1, '#8c4627', 26, 1.0, -35.2, 16); dhol.rotation.z = Math.PI / 2;
      for (const dx of [-.56, .56]) { const head = cylinder(g, .5, .5, .05, '#f5ebd1', 26 + dx, 1.0, -35.2, 16); head.rotation.z = Math.PI / 2; }
      const reception = textSprite('Sân Khấu Vũ Điệu Sangeet', '#8f2d42', 'rgba(251,248,238,.92)', 6.5); reception.position.set(26, 5.3, -31); g.add(reception); reception.userData.dynamic = true;
    } else {
      // Giàn Nho Pergola Tuscany, Bàn Tiệc Dài Imperial, Bánh Cưới 3 Tầng & Quầy Kẹo Hạnh Nhân Confettata
      box(g, 12.5, .14, 13.5, '#e3d4b6', 26, .22, -31);
      for (const pz of [-35.5, -31, -26.5]) this.pergola(g, 26, pz, '#e6d6b5');
      // Bàn tiệc dài Imperial phủ khăn lanh trắng kem & nến vàng tại z = -34.5
      box(g, 5.4, .82, 1.5, '#f4eee1', 26, .62, -34.5);
      box(g, 5.0, .05, 1.2, '#7b946e', 26, 1.05, -34.5); // Dải lá ô liu Table Runner
      for (let tx = 24.2; tx <= 27.8; tx += 1.2) {
        cylinder(g, .06, .08, .38, '#e5c378', tx, 1.25, -34.5, 8);
        sphere(g, .08, '#fff3bd', tx, 1.48, -34.5, 1);
        for (const s of [-.95, .95]) box(g, .5, .5, .5, '#dcd0b6', tx, .45, -34.5 + s);
      }
      // Quầy Bánh Cưới Millefoglie 3 tầng & 5 Hũ Kẹo Hạnh Nhân Sulmona (Confettata)
      box(g, 4.2, .88, 1.4, '#efe6d2', 26, .65, -36.2);
      cylinder(g, .95, .95, .28, '#faf4e8', 24.8, 1.22, -36.2, 24);
      cylinder(g, .7, .7, .28, '#f7eedc', 24.8, 1.50, -36.2, 24);
      cylinder(g, .46, .46, .26, '#faf4e8', 24.8, 1.77, -36.2, 24);
      for (let i = 0; i < 5; i++) {
        const jx = 26.1 + i * .38;
        cylinder(g, .14, .12, .36, '#e8f0ec', jx, 1.26, -36.2, 12);
        sphere(g, .12, i % 2 ? '#f5dce0' : '#ffffff', jx, 1.32, -36.2, 1);
      }
      const reception = textSprite('Pergola · Bàn Tiệc Dài & Confettata', '#4a6349', 'rgba(251,248,238,.92)', 6.6); reception.position.set(26, 4.9, -31); g.add(reception); reception.userData.dynamic = true;
    }

    // 2. PHOTO GARDEN ZONE AT [-26, -31] — Culturally distinct architectural pavilion & water feature
    const photoPoint = d.photoPoint || [-26, -31];
    const px = photoPoint[0], pz = photoPoint[1];
    if (d.id === 'vietnam') {
      // Thủy Đình Lục Giác Trên Hồ Sen & Cầu Gỗ Đỏ
      const pond = cylinder(g, 8.2, 8.2, .08, '#4f9ba3', px, .04, pz, 36); pond.castShadow = false;
      cylinder(g, 8.6, 8.6, .12, '#8d9678', px, -.01, pz, 36);
      // Lầu Thủy Đình 6 cột gỗ đỏ & mái cong
      cylinder(g, 3.8, 4.0, .32, '#8c3b32', px, .28, pz, 6);
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        cylinder(g, .14, .17, 3.2, '#a33b35', px + Math.cos(a) * 3.2, 1.9, pz + Math.sin(a) * 3.2, 8);
      }
      cylinder(g, .2, 4.8, 2.1, '#8a3834', px, 4.3, pz, 6);
      sphere(g, .32, '#e5c165', px, 5.45, pz, 1);
      // Cầu gỗ nối từ sân vào Thủy Đình
      box(g, 2.6, .16, 5.8, '#a3493e', px, .28, pz + 5.4);
      const photoSign = textSprite('Thủy Đình Hồ Sen · Photo Spot', '#7d2e29', 'rgba(251,248,238,.9)', 6.0); photoSign.position.set(px, 6.1, pz); g.add(photoSign); photoSign.userData.dynamic = true;
    } else if (d.id === 'japan') {
      // Cầu Vòm Đỏ Taiko-bashi (太鼓橋) bắc qua Hồ Cá Koi dưới tán Anh Đào
      const pond = cylinder(g, 7.8, 7.8, .08, '#5298a6', px, .04, pz, 36); pond.castShadow = false;
      for (let i = 0; i < 6; i++) {
        const a = i * 1.1, kx = px + Math.cos(a) * 3.5, kz = pz + Math.sin(a) * 3.5;
        sphere(g, .22, i % 2 ? '#e85d38' : '#f5eee0', kx, .09, kz, 1).scale.set(.6, .4, 1.8);
      }
      // Cầu vòm đỏ Taiko-bashi
      for (let i = -5; i <= 5; i++) {
        const t = i / 5, bz = pz + i * 1.05, by = .24 + (1 - t * t) * 1.25;
        box(g, 2.8, .12, .95, '#c43c32', px, by, bz);
        for (const s of [-1.3, 1.3]) {
          box(g, .1, .65, .1, '#c43c32', px + s, by + .35, bz);
          cylinder(g, .07, .07, .08, '#e5c467', px + s, by + .7, bz, 8);
        }
      }
      this.tree(g, px - 5.5, pz - 2, 6.8, '#edb8cb', 'blossom');
      const photoSign = textSprite('Cầu Taiko-bashi & Hồ Koi', '#3b4f44', 'rgba(251,248,238,.9)', 6.0); photoSign.position.set(px, 5.2, pz); g.add(photoSign); photoSign.userData.dynamic = true;
    } else if (d.id === 'korea') {
      // Lầu Vọng Cảnh Numaru (누마루) & Vườn Mẫu Đơn Bậc Thang Hwagye (화계)
      box(g, 7.6, .35, 7.6, '#b5afa2', px, .26, pz);
      box(g, 6.8, .14, 6.8, '#8c5e3a', px, .48, pz);
      const r = this.roof(g, 8.8, 8.8, 2.2, 3.9, pz, '#3e5059', true); r.position.x = px;
      for (const dx of [-3.0, 3.0]) for (const dz of [-3.0, 3.0]) cylinder(g, .18, .21, 3.4, '#874736', px + dx, 2.0, pz + dz, 10);
      // Vườn đá bậc thang Hwagye trồng hoa mẫu đơn (Peony) phía sau lầu
      for (let tier = 0; tier < 3; tier++) {
        const tz = pz - 5.2 - tier * 1.35, ty = .35 + tier * .55;
        box(g, 9.2, .52, 1.3, '#9e9a8e', px, ty, tz);
        for (const fx of [-3.2, -1.1, 1.1, 3.2]) this.flowers(g, px + fx, tz, '#e57a98', .65).position.y = ty + .22;
      }
      const photoSign = textSprite('Lầu Numaru & Vườn Bậc Thang Hwagye', '#385459', 'rgba(251,248,238,.9)', 6.2); photoSign.position.set(px, 5.0, pz); g.add(photoSign); photoSign.userData.dynamic = true;
    } else if (d.id === 'india') {
      // Hồ Phản Chiếu Cung Điện Hauz, Vòm Ảnh Hoàng Gia Jharokha & Đôi Voi Đá
      box(g, 9.6, .18, 9.6, '#e3b587', px, .18, pz);
      box(g, 7.8, .08, 7.8, '#54a2ad', px, .25, pz).castShadow = false;
      box(g, 4.8, .28, 4.8, '#f2dfb6', px, .32, pz);
      // Khung vòm ảnh Jharokha đá cẩm thạch & hoa vạn thọ
      for (const dx of [-1.8, 1.8]) cylinder(g, .22, .28, 3.8, '#f5ead2', px + dx, 2.1, pz - 1.6, 12);
      box(g, 4.6, .35, 1.2, '#e8be74', px, 4.0, pz - 1.6);
      sphere(g, 1.4, '#f5ead2', px, 4.65, pz - 1.6, 2).scale.set(1.2, .75, .8);
      for (let a = 0; a <= Math.PI; a += Math.PI / 8)sphere(g, .24, '#f0ab33', px + Math.cos(a) * 1.8, 2.4 + Math.sin(a) * 1.4, pz - 1.4, 1);
      // Đôi tượng voi đá Gaja chào đón hai bên lối vào hồ
      for (const ex of [-3.4, 3.4]) {
        box(g, .85, .95, 1.35, '#d9cbb0', px + ex, .75, pz + 3.2);
        sphere(g, .48, '#d9cbb0', px + ex, 1.05, pz + 3.95, 1);
        cylinder(g, .12, .08, .65, '#d9cbb0', px + ex, .75, pz + 4.35, 8);
        box(g, .7, .12, .85, '#b83552', px + ex, 1.26, pz + 3.2);
      }
      const photoSign = textSprite('Vòm Jharokha & Hồ Cung Điện', '#8f2d42', 'rgba(251,248,238,.9)', 6.0); photoSign.position.set(px, 5.6, pz - 1.6); g.add(photoSign); photoSign.userData.dynamic = true;
    } else {
      // Lầu Tròn Cột Đá Trắng Belvedere Rotunda (Tempietto) phủ Hoa Hồng Leo
      cylinder(g, 4.6, 4.9, .32, '#efe7d3', px, .26, pz, 32);
      cylinder(g, 3.8, 4.0, .18, '#f7f1e3', px, .46, pz, 32);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, cx = px + Math.cos(a) * 3.3, cz = pz + Math.sin(a) * 3.3;
        cylinder(g, .18, .21, 3.6, '#f2ead8', cx, 2.3, cz, 12);
        if (i % 2 === 0) this.flowers(g, cx, cz, '#f2c2cb', .55).position.y = 3.6;
      }
      const ring = mesh(g, new THREE.TorusGeometry(3.3, .24, 8, 32), '#e6dac2', px, 4.15, pz); ring.rotation.x = Math.PI / 2;
      const dome = mesh(g, new THREE.SphereGeometry(3.35, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), '#d9ccb2', px, 4.15, pz);
      dome.scale.y = .65;
      sphere(g, .25, '#c9b386', px, 6.45, pz, 1);
      const photoSign = textSprite('Lầu Đá Belvedere Rotunda', '#4a6349', 'rgba(251,248,238,.9)', 6.0); photoSign.position.set(px, 6.9, pz); g.add(photoSign); photoSign.userData.dynamic = true;
    }

    // Side terraces at [-51, 16] and [51, 16]
    for (const x of [-51, 51]) {
      box(g, 10, .05, 12, '#9cb08c', x, .02, 16);
      for (const z of [11, 16, 21]) this.flowers(g, x, z, d.flower, 1.4);
    }
  }

  private venueDetails(g: THREE.Group, d: District) {
    // Surface ornaments, lamps, planters, and stage borders tailored to each architectural tradition
    for (const side of [-1, 1]) {
      for (const z of [4, 25]) {
        if (d.id === 'vietnam') {
          // Chậu gốm men lam Bát Tràng & đôn sứ
          cylinder(g, .42, .48, .4, '#4a6882', side * 15, .4, z, 12);
          cylinder(g, .58, .42, .55, '#d9e0e3', side * 15, .78, z, 14);
        } else if (d.id === 'japan') {
          // Chậu bonsai đá xám thấp
          box(g, 1.1, .38, 1.1, '#8c9186', side * 15, .38, z);
        } else if (d.id === 'korea') {
          // Chum sành Onggi (옹기) nâu bóng truyền thống
          sphere(g, .58, '#633d28', side * 15, .58, z, 2).scale.set(1, 1.2, 1);
          cylinder(g, .46, .42, .14, '#4d2e1d', side * 15, 1.15, z, 14);
        } else if (d.id === 'india') {
          // Thố đồng Urli lớn thả hoa nổi trên mặt nước
          cylinder(g, .85, .45, .38, '#d49b42', side * 15, .38, z, 18);
          cylinder(g, .78, .78, .05, '#579ea8', side * 15, .55, z, 18);
        } else {
          // Bình đá có chân Medici Urn cổ điển vùng Tuscany
          cylinder(g, .32, .48, .42, '#dfd3ba', side * 15, .4, z, 12);
          cylinder(g, .65, .35, .58, '#e8dec7', side * 15, .82, z, 14);
        }
        this.flowers(g, side * 15, z, d.flower, .72).position.y = .58;
      }
      for (const z of [-34, 30]) {
        if (d.id === 'japan') {
          // Đèn đá Kasuga Tōrō (春日灯籠)
          box(g, .85, .28, .85, '#9b9e93', side * 31, .32, z);
          cylinder(g, .24, .3, 1.35, '#a6a99e', side * 31, 1.1, z, 6);
          box(g, .72, .55, .72, '#f2dfb3', side * 31, 1.95, z);
          cylinder(g, .15, 1.05, .52, '#7b8075', side * 31, 2.45, z, 6);
        } else if (d.id === 'india') {
          // Trụ đèn đồng nhiều tầng Deepstambh
          cylinder(g, .45, .6, .35, '#b87c3b', side * 31, .35, z, 12);
          cylinder(g, .14, .24, 2.8, '#cf9246', side * 31, 1.8, z, 10);
          for (const ly of [1.2, 1.9, 2.6]) {
            cylinder(g, .55, .35, .14, '#e3ae52', side * 31, ly, z, 12);
            sphere(g, .14, '#ffe494', side * 31, ly + .12, z, 1);
          }
        } else if (d.id === 'korea') {
          // Trụ đèn lồng lụa xanh-đỏ Cheongsa-chorong (청사초롱)
          cylinder(g, .12, .16, 3.2, '#6e432c', side * 31, 1.75, z, 8);
          box(g, .9, .12, .12, '#6e432c', side * 31, 3.25, z);
          cylinder(g, .28, .28, .45, '#355c7d', side * 31 + side * -.35, 2.95, z, 12);
          cylinder(g, .28, .28, .45, '#c0392b', side * 31 + side * -.35, 2.52, z, 12);
        } else {
          this.gardenLamp(g, side * 31, z);
        }
      }
      // Ranh giới khu vực ghế ưu tiên hai họ
      const curbColor = d.id === 'vietnam' ? '#9e4238' : d.id === 'japan' ? '#735b42' : d.id === 'korea' ? '#7d786d' : d.id === 'india' ? '#d99352' : '#cfc2a9';
      box(g, .14, .14, 51, curbColor, side * 13.2, .3, -7);
    }
    const gateLabel = textSprite(`${d.nativeName} · ${d.venue}`, '#425c43', 'rgba(251,248,238,.95)', 8.2); gateLabel.position.set(0, 8.2, 36); g.add(gateLabel);
    if (d.id === 'india' || d.id === 'italy') {
      // A visible support connects the suspended lantern threads to the architecture.
      for (const x of [-10.5, 10.5]) cylinder(g, .07, .1, 5.9, d.id === 'italy' ? '#bba481' : '#b67b57', x, 3, -16.7, 8);
      lineBeam(g, new THREE.Vector3(-10.5, 5.9, -16.7), new THREE.Vector3(10.5, 5.9, -16.7), .025, '#74664f');
    }
  }

  private vietnam(g: THREE.Group, d: District) {
    // 1. NHÀ ĐẠI BÁI / TỪ ĐƯỜNG 5 GIAN MẶT TIỀN ĐỒ SỘ & BÀN THỜ GIA TIÊN
    // Mái đao cong 2 tầng kiểu chồng diêm (Double-tiered curved roof with dragon ridge)
    this.roof(g, 26, 15, 3.2, 5.3, -23, d.roof, true);
    this.roof(g, 18, 10, 2.8, 7.4, -23, '#7d3532', true);
    // Đôi Lưỡng Long Chầu Nguyệt trên bờ nóc mái
    const moon = mesh(g, new THREE.TorusGeometry(.55, .09, 8, 24), '#e8c25a', 0, 10.65, -23);
    sphere(g, .28, '#ffdf78', 0, 10.65, -23, 1);
    for (const side of [-1, 1]) {
      for (let i = 1; i <= 5; i++)sphere(g, .24 - i * .02, '#d9af4c', side * (.7 + i * .65), 10.35 + Math.sin(i) * 0.18, -23, 1);
    }
    // Hệ cột cái & cột quân gỗ lim đỏ kê trên chân tảng đá xanh chạm cánh sen
    for (const x of [-10.5, -5.2, 5.2, 10.5]) for (const z of [-29, -17]) {
      cylinder(g, .46, .56, .34, '#7a8279', x, .42, z, 12);
      cylinder(g, .27, .33, 5.2, '#8f322a', x, 3.1, z, 14);
      // Câu đối đỏ chữ vàng treo dọc cột tiền đường
      if (z === -17 && (Math.abs(x) < 6)) {
        box(g, .42, 3.4, .06, '#b82925', x, 3.2, -16.62);
        box(g, .32, 3.1, .07, '#e5c158', x, 3.2, -16.6);
      }
    }
    // Bức Hoành Phi "Trăm Năm Hạnh Phúc" & Cửa Võng chạm thủng sơn son thếp vàng
    box(g, 22, .32, .9, '#7d2a24', 0, 5.3, -17);
    box(g, 7.8, 1.25, .18, '#9c241e', 0, 5.1, -16.5);
    box(g, 7.4, 1.0, .2, '#e5bf5a', 0, 5.1, -16.48);
    for (const x of [-7.5, 0, 7.5]) {
      const valance = box(g, 5.8, .85, .08, '#b32e28', x, 4.45, -16.6);
      for (let j = -2; j <= 2; j++)sphere(g, .16, '#e8c35f', x + j * 1.1, 4.05, -16.56, 1);
      valance.rotation.z = 0;
    }
    // Hậu cung vách gỗ đố lụa & Bộ Bàn Thờ Gia Tiên 3 cấp (Hương án, Đỉnh đồng, Hạc chầu, Mâm ngũ quả)
    for (let x = -9; x <= 9; x += 3) {
      box(g, 2.6, 3.6, .14, '#7a2e28', x, 2.9, -29.35);
      box(g, 2.2, 2.8, .16, '#9e3c35', x, 2.9, -29.32);
    }
    // Phông nhung đỏ chữ Song Hỷ (囍) lớn bằng vàng ròng chính giữa hậu cung
    box(g, 6.8, 3.9, .18, '#a31f1b', 0, 3.1, -29.2);
    const ring = mesh(g, new THREE.TorusGeometry(1.45, .14, 8, 40), '#e8c45c', 0, 3.8, -29.05); ring.rotation.z = 0;
    for (const sx of [-.52, .52]) {
      box(g, .13, 1.65, .12, '#e8c45c', sx, 3.8, -29.02);
      for (const sy of [3.2, 3.8, 4.4]) box(g, .75, .12, .12, '#e8c45c', sx, sy, -29.02);
    }
    // Bàn thờ Hương Án sơn son thếp vàng + Đỉnh đồng + Đôi Hạc đứng trên lưng Rùa + Đôi Lục Bình
    box(g, 7.6, 1.28, 1.75, '#87241e', 0, 1.0, -26.5);
    box(g, 8.0, .18, 2.0, '#dfb858', 0, 1.68, -26.5);
    cylinder(g, .38, .32, .65, '#d9b14e', 0, 2.1, -26.5, 14); // Đỉnh đồng trầm hương
    sphere(g, .22, '#ffe28a', 0, 2.55, -26.5, 1);
    for (const side of [-1, 1]) {
      // Hạc đồng chầu hai bên đỉnh hương
      cylinder(g, .08, .14, .85, '#e0b956', side * 1.35, 2.15, -26.5, 8);
      sphere(g, .16, '#e0b956', side * 1.35, 2.65, -26.5, 1).scale.set(.7, 1.2, 1.4);
      // Chân nến đồng & Lục bình gốm cao đặt hai bên bàn thờ
      cylinder(g, .12, .16, 1.05, '#e4bc65', side * 2.6, 2.2, -26.5, 10);
      sphere(g, .13, '#ffe69c', side * 2.6, 2.82, -26.5, 1);
      cylinder(g, .32, .24, 1.9, '#d6dfe3', side * 4.6, 1.35, -26.5, 14);
      cylinder(g, .22, .36, .55, '#3d5e78', side * 4.6, 2.45, -26.5, 14);
    }
    // 6 Đôn gỗ bày Tráp lễ vật ăn hỏi phủ khăn rồng phượng đỏ-vàng trước bàn thờ
    for (const x of [-3.2, 0, 3.2]) for (const z of [-22.2, -20.0]) {
      cylinder(g, .62, .68, .38, '#8f2d27', x, .52, z, 16);
      cylinder(g, .58, .62, .26, '#c42b25', x, .82, z, 16);
      cylinder(g, .46, .58, .16, '#e8c35f', x, 1.02, z, 16);
    }
    // 2. CỔNG TAM QUAN GẠCH CỔ 3 LỐI VÀO + CỔNG CƯỚI LÁ DỪA SONG HỶ TẠI z = 36
    // Hai trụ biểu Tứ Linh cao vút hai bên & 3 vòm cổng Tam Quan (Trung môn cao 2 tầng mái, Tả/Hữu môn 1 tầng mái)
    for (const x of [-11.5, -4.6, 4.6, 11.5]) {
      const h = Math.abs(x) < 6 ? 5.8 : 4.6;
      box(g, 1.15, h, 1.15, '#9e4838', x, h / 2 + .2, 36);
      box(g, 1.35, .28, 1.35, '#75352b', x, h + .28, 36);
      sphere(g, .34, '#e3bc59', x, h + .62, 36, 1);
    }
    // Mái lầu cổng chính Tam Quan & hai cổng phụ hai bên
    this.roof(g, 11.6, 3.4, 2.1, 6.0, 36, '#7d3532', true);
    for (const side of [-8.1, 8.1]) {
      const sr = this.roof(g, 6.8, 2.8, 1.5, 4.8, 36, '#8a3d39', true); sr.position.x = side;
    }
    // Cổng cưới kết lá dừa xanh, hoa tươi & câu đối Song Hỷ ngay lối vào chính
    for (const x of [-3.4, 3.4]) {
      cylinder(g, .24, .28, 4.6, '#528249', x, 2.5, 34.4, 10);
      this.flowers(g, x, 34.4, '#f2c5b6', 1.1).position.y = .8;
    }
    const leafArch = mesh(g, new THREE.TorusGeometry(3.4, .28, 8, 28, Math.PI), '#5c8f51', 0, 2.8, 34.4); leafArch.rotation.z = 0;
    box(g, 3.8, .75, .22, '#c42823', 0, 4.8, 34.4);
    box(g, 3.5, .55, .24, '#f0ca62', 0, 4.8, 34.4);

    // 3. HỒ SEN LỚN BÊN HÔNG TRÁI & CẦU GỖ VEN NƯỚC
    const pondEdge = cylinder(g, 11.5, 11.5, .13, '#a3ad89', -47, -.015, -12, 44); pondEdge.scale.set(.75, 1, 2.4);
    const pond = cylinder(g, 11, 11, .08, '#529da5', -47, .025, -12, 44); pond.scale.set(.75, 1, 2.4); pond.castShadow = false;
    for (let i = 0; i < 15; i++) {
      const x = -47 + (random() - .5) * 12, z = -12 + (random() - .5) * 42;
      cylinder(g, .72, .72, .025, '#64965c', x, .08, z, 12);
      for (let j = 0; j < 7; j++) { const a = j * Math.PI * 2 / 7; const petal = sphere(g, .19, '#f2afc0', x + Math.sin(a) * .2, .2, z + Math.cos(a) * .2, 1); petal.scale.set(.65, .65, 1.5); petal.rotation.y = a; }
      sphere(g, .13, '#eac16a', x, .28, z, 1);
    }
    box(g, 7, .12, 32, '#beac8a', -33, .25, -13);
    for (const z of [-28, -20, -12, -4, 2]) box(g, .16, 1.05, .16, '#8c3d35', -36, .75, z);
    box(g, .16, .14, 31, '#8c3d35', -36, 1.25, -13);
  }

  private japan(g: THREE.Group, d: District) {
    // 1. ĐIỆN THỜ GỖ BÁCH HINOKI (HAIDEN / SHINDEN) VỚI MÁI ĐỒNG ĐEN IRIMOYA & DÂY SHIMENAWA
    this.roof(g, 25.5, 17.5, 4.4, 5.8, -22, '#364047', true);
    // Thanh gỗ Chigi (千木) bắt chéo & Katsuogi (鰹木) mạ vàng trên đỉnh mái Thần đạo
    for (const side of [-1, 1]) {
      const chigiA = box(g, .18, 2.2, .18, '#c9a66b', side * 9.8, 9.9, -22); chigiA.rotation.x = .42;
      const chigiB = box(g, .18, 2.2, .18, '#c9a66b', side * 9.8, 9.9, -22); chigiB.rotation.x = -.42;
    }
    for (let kx = -6.5; kx <= 6.5; kx += 3.25) {
      const katsuogi = cylinder(g, .18, .18, 1.3, '#b89358', kx, 10.35, -22, 10); katsuogi.rotation.z = Math.PI / 2;
    }
    // Hệ cột gỗ Bách Hinoki màu mộc sáng tự nhiên & hành lang hiên gỗ Engawa có lan can Kōran
    for (const x of [-9.5, -4.8, 4.8, 9.5]) for (const z of [-28.5, -16.2]) {
      box(g, .48, .32, .48, '#5c5e58', x, .35, z);
      cylinder(g, .26, .29, 5.4, '#b89362', x, 3.0, z, 14);
    }
    box(g, 21.2, .24, 16.5, '#c7a677', 0, .34, -22);
    for (const x of [-9.6, 9.6]) {
      box(g, .16, 1.1, 16.2, '#a68456', x, .95, -22);
      cylinder(g, .1, .1, 16.6, '#c43830', x, 1.52, -22, 10).rotation.x = Math.PI / 2;
    }
    // Dây thừng thiêng Shimenawa (注連縄) tết rơm lớn & dải giấy trắng Shide (紙垂) treo trước mặt tiền Haiden
    for (let i = 0; i <= 16; i++) {
      const sx = -7.2 + i * .9, sy = 5.15 - Math.sin(i / 16 * Math.PI) * .42;
      sphere(g, .26 - .01 * Math.abs(i - 8), '#d9c38c', sx, sy, -16.0, 1).scale.set(1.3, .85, .85);
    }
    for (const sx of [-4.2, -1.4, 1.4, 4.2]) {
      for (let k = 0; k < 3; k++)box(g, .28, .32, .04, '#ffffff', sx + (k % 2 ? .08 : -.08), 4.55 - k * .26, -15.92);
    }
    // Vách gỗ Shoji trắng ngà & Cây Sakaki thiêng + Gương tròn thần đạo Yata-no-Kagami phía sau
    for (const x of [-6.4, -3.2, 0, 3.2, 6.4]) {
      box(g, 3.0, 3.5, .12, '#f4efe1', x, 3.0, -29.25);
      for (let h = 1.6; h <= 4.2; h += .65)box(g, 2.9, .04, .14, '#9e7c50', x, h, -29.22);
    }
    // Bàn nghi lễ Sanbō gỗ Hinoki đặt bộ 3 chén sơn mài đỏ San-san-kudo (三々九度) & Bình rượu Sake Chōshi
    box(g, 5.4, 1.05, 1.55, '#d4b687', 0, .92, -25);
    box(g, 5.7, .12, 1.7, '#e3c89b', 0, 1.48, -25);
    for (const [i, r] of [[-1, .18], [0, .24], [1, .30]] as [number, number][]) {
      box(g, .55, .32, .55, '#dec292', i * 1.1, 1.68, -25);
      cylinder(g, r, r * .65, .12, '#c9322b', i * 1.1, 1.9, -25, 18);
    }
    // Đôi cây Sakaki xanh buộc dải giấy trắng hai bên bàn lễ
    for (const side of [-3.6, 3.6]) {
      cylinder(g, .28, .22, .55, '#f2eee3', side, .75, -26.5, 12);
      sphere(g, .75, '#3d6e46', side, 1.65, -26.5, 1).scale.set(.8, 1.35, .8);
    }

    // 2. CỔNG MYOJIN TORII (明神鳥居) SƠN ĐỎ SON CHUẨN KIẾN TRÚC THẦN ĐẠO & TRẠM NƯỚC TEMIZUYA TẠI z = 36
    for (const x of [-5.2, 5.2]) {
      cylinder(g, .44, .48, .75, '#2b2d2f', x, .55, 36, 14); // Chân cột Nemaki sơn đen
      cylinder(g, .34, .38, 5.8, '#c93829', x, 3.3, 36, 16); // Cột trụ Hashira đỏ son
    }
    // Thanh ngang dưới Nuki (貫) & thanh ngang trên Kasagi/Shimaki uốn cong hai đầu
    box(g, 12.8, .38, .36, '#c93829', 0, 4.85, 36);
    for (let i = 0; i <= 20; i++) {
      const tx = -7.2 + i * .72, u = Math.abs(tx) / 7.2, ty = 6.15 + Math.pow(u, 2.4) * .55;
      box(g, .78, .36, .58, '#c93829', tx, ty, 36);
      box(g, .78, .18, .64, '#2b2d2f', tx, ty + .24, 36);
    }
    // Bảng tên thần đạo Gakuzukami (額束) giữa Kasagi và Nuki
    box(g, 1.1, 1.15, .28, '#2b2d2f', 0, 5.5, 36);
    box(g, .88, .92, .32, '#e5c162', 0, 5.5, 36);
    // Trạm nước thanh tẩy Temizuya (手水舎) có mái gỗ và gáo tre bên phải cổng vào (x = 9.8, z = 33.5)
    for (const [dx, dz] of [[-1.4, -1.1], [1.4, -1.1], [-1.4, 1.1], [1.4, 1.1]]) box(g, .16, 2.6, .16, '#8c6b45', 9.8 + dx, 1.45, 33.5 + dz);
    const temizuyaRoof = this.roof(g, 3.8, 3.2, 1.1, 2.75, 33.5, '#3d484f', true); temizuyaRoof.position.x = 9.8;
    box(g, 1.8, .75, 1.2, '#7d8278', 9.8, .55, 33.5);
    box(g, 1.45, .08, .9, '#589aa8', 9.8, .92, 33.5);
    // Hàng đèn đá Tōrō dọc hai bên sân
    for (const x of [-31, 31]) for (const z of [8, -10]) {
      box(g, 1.5, 1, 1.5, '#b5b6a1', x, .6, z); cylinder(g, .9, 1.1, .4, '#a1a994', x, 1.4, z, 4);
      cylinder(g, .3, .5, 1.1, '#b0b29e', x, 2, z, 4);
    }
    const pond = cylinder(g, 9, 9, .04, '#589aa8', -46, .03, -3, 32); pond.scale.set(.7, 1, 2); pond.castShadow = false;
    for (let i = 0; i < 9; i++) {
      const a = i * Math.PI * 2 / 9, stone = sphere(g, .6 + random() * .5, '#9bada4', -46 + Math.sin(a) * 6.5, .25, -3 + Math.cos(a) * 17, 1); stone.scale.set(1, .65, 1.4);
    }
  }

  private korea(g: THREE.Group, d: District) {
    // 1. ĐÀI ĐẠI LỄ HANOK (DAERYECHEONG 대례청) VỚI HỆ ĐẤU CỦNG DANCHEONG NGŨ SẮC & BÌNH PHONG NHẬT NGUYỆT
    this.roof(g, 27, 14.5, 3.8, 5.5, -23.5, '#364852', true);
    // Đôi tượng tạp tượng Japsang (잡상) & đầu rồng Yongdu trên bờ mái 팔작지붕 (Paljak-jibung)
    for (const side of [-1, 1]) {
      sphere(g, .32, '#4f636e', side * 12.5, 6.8, -17.2, 1);
      sphere(g, .32, '#4f636e', side * 12.5, 6.8, -29.8, 1);
    }
    // Hệ cột tròn gỗ thông đỏ trên chân đá 주초석 (Juchoseok) & Dầm Dancheong (단청) xanh ngọc - đỏ gạch - vàng
    for (const x of [-11, -5.5, 5.5, 11]) for (const z of [-29, -18]) {
      cylinder(g, .42, .48, .35, '#b8b3a6', x, .42, z, 12);
      cylinder(g, .24, .28, 5.1, '#8c4635', x, 2.95, z, 14);
    }
    box(g, 23.6, .34, .55, '#38756c', 0, 5.2, -18);
    box(g, 23.8, .18, .62, '#b8543d', 0, 4.94, -18);
    for (let i = 0; i < 19; i++) {
      const bx = -10.8 + i * 1.2;
      box(g, .36, .26, .68, i % 2 ? '#c45d42' : '#3d8577', bx, 4.72, -18);
      box(g, .16, .18, .72, '#e8c66b', bx, 4.52, -18);
    }
    // Bức Bình Phong Nhật Nguyệt Ngũ Nhạc Đồ (Ilwolobongdo 일월오봉도) uy nghi sau bàn lễ
    box(g, 10.5, 3.9, .16, '#1f3a52', 0, 3.0, -29.15);
    box(g, 10.9, 4.1, .12, '#875b39', 0, 3.0, -29.22);
    // Mặt trời đỏ (bên phải) & Mặt trăng trắng (bên trái) trên nền 5 đỉnh núi xanh ngọc
    mesh(g, new THREE.CircleGeometry(.62, 24), '#d9382e', 2.4, 4.15, -29.04);
    mesh(g, new THREE.CircleGeometry(.58, 24), '#f5f2e6', -2.4, 4.15, -29.04);
    for (const [mx, mh, mc] of [[-3.4, 1.5, '#2e6e5e'], [-1.7, 2.1, '#3a8270'], [0, 2.65, '#469682'], [1.7, 2.1, '#3a8270'], [3.4, 1.5, '#2e6e5e']] as [number, number, string][]) {
      cylinder(g, .15, 1.35, mh, mc, mx, 1.1 + mh / 2, -29.05, 6);
    }
    // Cửa sổ mắt cáo Hanji hai bên cánh Bình Phong
    for (const x of [-8.2, 8.2]) {
      box(g, 3.4, 3.6, .12, '#ebe0c5', x, 2.9, -29.2);
      for (let k = 0; k < 4; k++)box(g, 3.2, .05, .15, '#7a5638', x, 1.5 + k * .85, -29.15);
    }
    // Bàn Đại Lễ 초례상 (Choryesang) phủ khăn đỏ-xanh với Đôi Ngỗng Gỗ Kireogi, Chén Bầu Hapgeullye, Cây Thông & Tre
    box(g, 7.4, 1.1, 1.85, '#6e4328', 0, .92, -24.7);
    box(g, 7.7, .16, 2.05, '#9e322b', 0, 1.52, -24.7);
    // Đôi Ngỗng Gỗ Uyên Ương Kireogi (기러기) quấn dải lụa xanh-đỏ
    for (const side of [-1, 1]) {
      sphere(g, .36, '#b38652', side * .55, 1.82, -24.7, 2).scale.set(1.2, .65, .65);
      cylinder(g, .07, .1, .34, '#b38652', side * .55 + .18, 2.05, -24.7, 8);
      sphere(g, .14, '#b38652', side * .55 + .22, 2.25, -24.7, 1);
    }
    // Đôi Chén Rượu Bầu Hồ Lô Hợp cẩn (합근례 표주박) nối chỉ xanh-đỏ & Bình gốm Celadon cắm Thông - Trúc
    for (const x of [-1.8, 1.8]) {
      cylinder(g, .22, .16, .28, x < 0 ? '#3b6978' : '#b8433e', x, 1.74, -24.7, 14);
      cylinder(g, .26, .22, .58, '#78a393', x * 1.65, 1.88, -24.7, 14);
      sphere(g, .38, x < 0 ? '#3b6e4c' : '#6e9452', x * 1.65, 2.35, -24.7, 1);
    }

    // 2. CỔNG TAM MÔN SOSEUL-DAEMUN (솟을대문) MÁI GIỮA NÂNG CAO ĐẶC TRƯNG HÀN QUỐC TẠI z = 36
    // Gian cổng giữa cao vút (Soseul) & hai gian cổng phụ thấp hơn hai bên nối liền tường hoa Kkotdam
    for (const x of [-10.5, -4.4, 4.4, 10.5]) {
      const h = Math.abs(x) < 5 ? 5.5 : 4.1;
      cylinder(g, .24, .28, h, '#874736', x, h / 2 + .2, 36, 12);
    }
    box(g, 9.2, .32, .65, '#38756c', 0, 5.4, 36);
    this.roof(g, 10.8, 3.6, 1.9, 5.65, 36, '#364852', true); // Mái cổng chính nâng cao
    for (const side of [-7.5, 7.5]) {
      box(g, 6.2, 3.6, .38, '#d8cbb4', side, 2.0, 36);
      box(g, 2.2, 1.8, .44, '#bf6952', side, 2.1, 36); // Họa tiết gạch hoa Kkotdam
      const wingRoof = this.roof(g, 6.8, 3.0, 1.3, 4.1, 36, '#3e5059', true); wingRoof.position.x = side;
    }
    // Treo đôi đèn lụa xanh-đỏ Cheongsa-chorong hai bên cổng Soseul-daemun
    for (const side of [-3.6, 3.6]) {
      cylinder(g, .32, .32, .52, '#2e5878', side, 4.55, 35.2, 12);
      cylinder(g, .32, .32, .52, '#b8352b', side, 4.02, 35.2, 12);
    }
  }

  private india(g: THREE.Group, d: District) {
    // 1. ĐÌNH LỄ ROYAL RAJASTHANI MANDAP MÁI VÒM CỦ HÀNH CHHATRI, 8 CỘT CHẠM KHẮC & BẾP LỬA THIÊNG HAVAN KUND
    for (const x of [-8.2, 8.2]) for (const z of [-27.2, -19.5, -11.8]) {
      const profile = [new THREE.Vector2(.58, 0), new THREE.Vector2(.58, .28), new THREE.Vector2(.38, .45), new THREE.Vector2(.26, 1.2), new THREE.Vector2(.24, 4.8), new THREE.Vector2(.42, 5.3), new THREE.Vector2(.56, 5.6), new THREE.Vector2(.56, 5.8)];
      mesh(g, new THREE.LatheGeometry(profile, 14), '#e6be73', x, .55, z);
      // Dây hoa cúc vạn thọ quấn xoắn ốc quanh cột Mandap
      for (let j = 0; j < 16; j++) { const a = j * .9; sphere(g, .19, j % 2 ? '#f5ab29' : '#e0533c', x + Math.cos(a) * .34, 1.0 + j * .29, z + Math.sin(a) * .34, 1); }
    }
    // Mái vòm lớn trung tâm Gumbad / Chhatri Dome & 4 tháp Chhatri góc kèm chóp vàng Kalash
    this.fabricCanopy(g, 20.5, 19.5, 2.2, 6.35, -19.5, d.roof);
    cylinder(g, 3.8, 4.2, .55, '#e3b56b', 0, 8.2, -19.5, 24);
    const mainDome = sphere(g, 3.6, '#f2d59b', 0, 9.1, -19.5, 2); mainDome.scale.set(1, .78, 1);
    cylinder(g, .12, .28, 1.15, '#d99f2b', 0, 11.8, -19.5, 12); // Chóp vàng Kalash đỉnh Mandap
    sphere(g, .28, '#ffdf70', 0, 12.4, -19.5, 1);
    for (const [cx, cz] of [[-7.8, -26.8], [7.8, -26.8], [-7.8, -12.2], [7.8, -12.2]]) {
      cylinder(g, 1.1, 1.25, .35, '#deb068', cx, 6.65, cz, 14);
      sphere(g, 1.05, '#f0d296', cx, 7.15, cz, 2).scale.set(1, .75, 1);
      cylinder(g, .06, .14, .55, '#d99f2b', cx, 7.85, cz, 8);
    }
    // Diềm vòm răng cưa Mughal Cusped Arches & Chuỗi tua rua hoa vạn thọ Toran rủ quanh 4 mặt Mandap
    for (const z of [-10.2, -28.8]) {
      box(g, 20.4, .24, .24, '#d99f38', 0, 6.35, z);
      for (let i = 0; i < 10; i++) {
        const swag = mesh(g, new THREE.CircleGeometry(1.05, 16, 0, Math.PI), i % 2 ? '#d94b64' : '#9e2a45', -9 + i * 2, 6.3, z + .04); swag.rotation.z = Math.PI;
        // Dây hoa cúc vạn thọ buông thẳng xuống (Marigold Ladi)
        for (let hy = 4.8; hy <= 6.1; hy += .32)sphere(g, .13, i % 2 ? '#f5b335' : '#e86438', -10 + i * 2, hy, z + .08, 1);
      }
    }
    for (const x of [-8.2, 8.2]) for (let j = 0; j < 5; j++) {
      const drape = cylinder(g, .15, .26, 4.5, j % 2 ? '#b83b59' : '#e07b42', x + (j - 2) * .26, 3.9, -25, 8); drape.scale.z = 3.1;
    }
    // Bếp lửa thiêng Havan Kund (हवन कुंड) bậc tam cấp hình vuông bằng đồng & ngọn lửa Agni ở giữa Mandap (z = -21)
    for (const [step, w] of [[0, 2.6], [1, 2.0], [2, 1.45]] as [number, number][]) {
      box(g, w, .22, w, step % 2 ? '#c97a3e' : '#e0a64c', 0, .42 + step * .2, -21);
    }
    sphere(g, .62, '#ff9d2e', 0, 1.25, -21, 1).scale.set(.75, 1.5, .75);
    sphere(g, .38, '#ffe373', 0, 1.45, -21, 1).scale.set(.6, 1.6, .6);
    // Vòng cánh hoa cúc vạn thọ Saptapadi (7 bước) bao quanh Havan Kund
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8, petal = mesh(g, new THREE.CircleGeometry(.58, 12), i % 2 ? '#f2a830' : '#d1493b', Math.cos(a) * 2.75, .39, -21 + Math.sin(a) * 2.75);
      petal.rotation.x = -Math.PI / 2;
    }
    // Đôi Ghế Ngai Vàng Hoàng Gia (Royal Singhasan) đặt phía sau Mandap
    for (const sx of [-2.4, 2.4]) {
      box(g, 1.9, .55, 1.2, '#d99f38', sx, .65, -26.8);
      box(g, 1.8, 1.65, .22, '#a82843', sx, 1.6, -27.3);
      sphere(g, .92, '#e3b34c', sx, 2.35, -27.32, 2).scale.set(1, .65, .2);
    }

    // 2. CỔNG VÒM CUNG ĐIỆN ĐÁ HỒNG SHAHI TORAN DARWAZA 3 THÁP CHHATRI TẠI z = 36
    for (const x of [-10.2, -4.6, 4.6, 10.2]) {
      box(g, 1.6, 5.8, 1.6, '#d98468', x, 3.1, 36);
      box(g, 1.85, .35, 1.85, '#f0cfa0', x, 6.05, 36);
    }
    // Dầm thượng cổng Darwaza & Vòm đa thùy chính giữa + 2 vòm phụ
    box(g, 22.4, .95, 1.7, '#cf7659', 0, 6.55, 36);
    const mainArch = mesh(g, new THREE.TorusGeometry(3.8, .34, 8, 28, Math.PI), '#f2d5a7', 0, 3.8, 36); mainArch.rotation.z = 0;
    for (const sx of [-7.4, 7.4]) {
      const sideArch = mesh(g, new THREE.TorusGeometry(2.1, .24, 8, 20, Math.PI), '#f2d5a7', sx, 3.2, 36); sideArch.rotation.z = 0;
    }
    // 3 Tháp vòm Chhatri ngự trên đỉnh cổng Shahi Darwaza
    for (const [cx, sc] of [[-7.4, .85], [0, 1.18], [7.4, .85]] as [number, number][]) {
      for (const dx of [-.85 * sc, .85 * sc]) cylinder(g, .12 * sc, .15 * sc, 1.4 * sc, '#f0cfa0', cx + dx, 7.7, 36, 8);
      sphere(g, 1.25 * sc, '#f5deb5', cx, 8.55 * sc + (.95 * (1 - sc)), 36, 2).scale.set(1, .75, 1);
      cylinder(g, .06, .14, .55, '#e0a838', cx, 9.45 * sc + (.95 * (1 - sc)), 36, 8);
    }
    // Rèm hoa vạn thọ vàng rực giăng ngang vòm cổng
    for (let x = -4.2; x <= 4.2; x += .55)sphere(g, .36, d.flower, x, 5.5 - Math.cos(x / 4.2 * Math.PI / 2) * .55, 35.2, 0);
  }

  private italy(g: THREE.Group, d: District) {
    // 1. BIỆT THỰ CỔ ĐIỂN VILLA TOSCANA 2 TẦNG, LOGGIA 3 VÒM LA MÃ, THÁP CHUÔNG BELVEDERE & ĐÀI BÁN NGUYỆT
    const villa = box(g, 27, 8.4, 5.4, '#f0dbb4', 0, 4.4, -32.5); this.colliders.push(villa);
    this.roof(g, 30, 8.6, 2.8, 8.5, -32.5, d.roof, false);
    // Tháp vọng cảnh Torretta / Campanile vươn cao bên cánh phải biệt thự (x = 9.5, z = -33)
    box(g, 5.4, 12.2, 5.0, '#ebcfa2', 9.5, 6.3, -33.0);
    for (const tx of [8.2, 10.8]) {
      const bArch = mesh(g, new THREE.TorusGeometry(.55, .1, 6, 16, Math.PI), '#54483a', tx, 10.6, -30.45); bArch.rotation.z = 0;
      box(g, 1.1, 1.2, .08, '#54483a', tx, 10.0, -30.46);
    }
    const towerRoof = this.roof(g, 6.4, 6.0, 1.6, 12.4, -33.0, d.roof, false); towerRoof.position.x = 9.5;
    // Phào chỉ đá Travertine, các góc tường ốp đá Quoins & đầu hồi Tam giác cổ điển (Pediment)
    box(g, 27.6, .55, 5.8, '#cfb488', 0, .55, -32.5);
    box(g, 27.5, .28, 5.8, '#d8be92', 0, 4.4, -32.5);
    box(g, 27.5, .28, 5.8, '#d8be92', 0, 8.1, -32.5);
    box(g, 27, .48, 5.3, '#f0dbb4', 0, 8.55, -32.5);
    for (const qx of [-13.3, 13.3]) for (let qy = 1.1; qy <= 7.6; qy += .95)box(g, .45, .52, 5.6, '#d8be92', qx, qy, -32.5);
    const gable = new THREE.BufferGeometry(); gable.setAttribute('position', new THREE.Float32BufferAttribute([-10, 8.65, -29.75, 0, 11.4, -29.75, 10, 8.65, -29.75, -10, 8.65, -35.15, 0, 11.4, -35.15, 10, 8.65, -35.15], 3));
    gable.setIndex([0, 2, 1, 3, 4, 5, 0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 0, 3, 2, 2, 3, 5]); const gableFaces = gable.toNonIndexed(); gableFaces.computeVertexNormals(); mesh(g, gableFaces, '#f0dbb4'); gable.dispose();
    // Ô cửa sổ tròn Oculus giữa trán tường Pediment
    mesh(g, new THREE.TorusGeometry(.68, .14, 8, 24), '#d8be92', 0, 9.7, -29.7);
    // Hàng hiên 3 Vòm Đá La Mã (Triple Arched Loggia) ở tầng trệt mặt tiền Villa
    for (const ax of [-4.2, 0, 4.2]) {
      const door = mesh(g, new THREE.CircleGeometry(1.45, 24, 0, Math.PI), '#4f6b57', ax, 3.4, -29.75);
      box(g, 2.9, 2.8, .08, '#4f6b57', ax, 2.0, -29.75);
      const archivolt = mesh(g, new THREE.TorusGeometry(1.6, .18, 8, 24, Math.PI), '#e0c496', ax, 3.4, -29.68);
      if (ax === 0) { door.name = 'Villa arched doorway'; archivolt.name = 'Villa stone archivolt'; }
    }
    for (const px of [-6.3, -2.1, 2.1, 6.3]) cylinder(g, .24, .28, 3.6, '#e3caa0', px, 2.1, -29.65, 14);
    // Cửa sổ tầng lầu với cửa chớp xanh lá cây (Persiane) & bồn hoa phong lữ thảo
    for (const x of [-9.5, -4.5, 4.5, 9.5]) {
      box(g, 1.9, 2.4, .1, '#628070', x, 6.1, -29.74);
      for (const side of [-1, 1]) box(g, .55, 2.4, .14, '#4c6e5d', x + side * 1.2, 6.1, -29.68);
      box(g, 2.3, .18, .45, '#e3caa0', x, 4.85, -29.62);
      this.flowers(g, x, -29.45, '#e88d84', .48).position.y = 4.85;
    }
    // Vòm Bán Nguyệt Đá Trắng (Classical Exedra / Serlian Ceremony Arch) phủ hoa hồng trắng & lá ô liu tại sân lễ (z = -26.5)
    for (const x of [-4.8, -2.8, 2.8, 4.8]) {
      cylinder(g, .24, .28, 3.6, '#efe6d2', x, 2.1, -26.6, 14);
      box(g, .65, .3, .65, '#dfd2b8', x, .38, -26.6);
    }
    box(g, 2.6, .28, .65, '#efe6d2', -3.8, 3.95, -26.6);
    box(g, 2.6, .28, .65, '#efe6d2', 3.8, 3.95, -26.6);
    const arch = mesh(g, new THREE.TorusGeometry(2.8, .28, 8, 40, Math.PI), '#efe6d2', 0, 3.95, -26.6); arch.rotation.z = 0;
    for (let i = 0; i <= 12; i++) {
      const a = i / 12 * Math.PI;
      this.flowers(g, Math.cos(a) * 2.85, -26.45, '#f7ebd2', .52).position.y = 3.95 + Math.sin(a) * 2.85;
    }

    // 2. VƯỜN HÌNH HỌC PARTERRE ALL'ITALIANA (CẮT TỈA ĐỐI XỨNG) & ĐÀI PHUN NƯỚC ĐÁ HAI BÊN SÂN
    for (const side of [-1, 1]) for (const pz of [3, 16]) {
      const px = side * 20.5;
      // Bồn cây Hoàng Dương (Boxwood Parterre) cắt tỉa vuông vức kèm chậu chanh đất nung ở tâm
      box(g, 7.4, .42, 7.4, '#52754b', px, .38, pz);
      box(g, 5.8, .45, 5.8, '#ede3cc', px, .39, pz);
      box(g, 4.2, .52, 4.2, '#628759', px, .42, pz);
      cylinder(g, .55, .38, .68, '#bf6b4b', px, .62, pz, 12);
      sphere(g, .82, '#496e42', px, 1.5, pz, 1);
    }
    // 2 Đài phun nước đá Travertine 2 tầng ở [-20, -37] và [0, -38] phía ngoài hành lang
    for (const x of [-18, 18]) {
      cylinder(g, 2.6, 2.8, .26, '#dfd2b8', x, .3, 3.5, 24);
      cylinder(g, 2.3, 2.3, .08, '#6daab3', x, .42, 3.5, 24);
      cylinder(g, .24, .34, 1.1, '#cfc0a3', x, .9, 3.5, 12);
      cylinder(g, 1.3, 1.0, .18, '#ece1ca', x, 1.45, 3.5, 20);
    }

    // 3. CỔNG ĐÁ TRAVERTINE CỔ ĐIỂN, CỔNG SẮT UỐN & ĐẠI LỘ CÂY BÁCH TUSCANY TẠI z = 36
    for (const x of [-5.2, 5.2]) {
      box(g, 1.25, 4.8, 1.25, '#dfd3bc', x, 2.6, 36);
      box(g, 1.55, .32, 1.55, '#cbbd9f', x, 5.1, 36);
      // Bình đá cổ điển & quả thông Pigna trên đỉnh trụ cổng
      cylinder(g, .35, .48, .45, '#ebe1cc', x, 5.48, 36, 12);
      sphere(g, .42, '#dfd3bc', x, 5.95, 36, 1).scale.set(.85, 1.35, .85);
    }
    // Vòm sắt uốn mỹ thuật màu đen đồng phía trên cổng đá
    const ironArch = mesh(g, new THREE.TorusGeometry(5.2, .12, 6, 36, Math.PI), '#3b423c', 0, 4.9, 36); ironArch.rotation.z = 0;
    const innerArch = mesh(g, new THREE.TorusGeometry(4.85, .07, 6, 32, Math.PI), '#c4a662', 0, 4.85, 36); innerArch.rotation.z = 0;
    // Hàng cây Bách vùng Tuscany (Cypress Avenue) đứng sừng sững hai bên cổng vào
    for (const side of [-1, 1]) for (const [cx, cz] of [[7.8, 36], [11.2, 36], [6.8, 32.5]]) {
      this.tree(g, side * cx, cz, 8.8, '#42664a', 'cypress');
    }
    for (const x of [-41, 41]) for (const z of [-19, 7]) {
      cylinder(g, 1.3, 1.5, 1.3, '#d3b18c', x, .8, z, 12);
      this.tree(g, x, z, 4.5, '#688658');
    }
  }

  private batchStatic() {
    this.scene.updateMatrixWorld(true);
    const coverage = !!this.renderer.getContext().getContextAttributes()?.antialias;
    const groups = new Map<string, { material: THREE.MeshStandardMaterial; geometries: THREE.BufferGeometry[]; objects: THREE.Mesh[] }>();
    const instances = new Map<string, { material: THREE.MeshStandardMaterial; geometry: THREE.BufferGeometry; objects: THREE.Mesh[] }>();
    const bakedMaterials = new Map<string, THREE.MeshStandardMaterial>();
    const bakedMaterial = (source: THREE.MeshStandardMaterial, foliage: boolean, instanced: boolean) => {
      const key = `${source.roughness}:${source.side}:${foliage}:${instanced}`;
      let result = bakedMaterials.get(key); if (result) return result;
      result = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: source.roughness, vertexColors: !instanced, side: source.side, alphaToCoverage: foliage && coverage, alphaTest: foliage && !coverage ? .5 : 0 });
      if (foliage) this.configureFoliage(result);
      bakedMaterials.set(key, result); return result;
    };
    this.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object.userData.dynamic || !(object.material instanceof THREE.MeshStandardMaterial)) return;
      // Characters and sprites remain dynamic; fixed architectural meshes are baked once.
      if (object.userData.avatar) return;
      let ancestor = object.parent;
      while (ancestor) { if (ancestor.userData.avatar || ancestor.userData.dynamic) return; if (ancestor.userData.treeSphere) object.userData.treeSphere = ancestor.userData.treeSphere; ancestor = ancestor.parent; }
      const source = object.material, foliage = !!object.userData.foliage, instanced = !!object.geometry.userData.instanced;
      const p = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld), baked = bakedMaterial(source, foliage, instanced), cell = `${Math.floor(p.x / 32)}:${Math.floor(p.z / 32)}`;
      if (instanced) {
        const key = `${baked.uuid}:${object.geometry.uuid}:${cell}`;
        let group = instances.get(key); if (!group) { group = { material: baked, geometry: object.geometry, objects: [] }; instances.set(key, group); }
        group.objects.push(object); return;
      }
      const key = `${baked.uuid}:${cell}`;
      let group = groups.get(key); if (!group) { group = { material: baked, geometries: [], objects: [] }; groups.set(key, group); }
      let geometry = object.geometry.clone(); if (geometry.index) geometry = geometry.toNonIndexed();
      geometry.deleteAttribute('uv'); geometry.deleteAttribute('uv1'); geometry.applyMatrix4(object.matrixWorld);
      const colors = new Float32Array(geometry.getAttribute('position').count * 3), original = geometry.getAttribute('color');
      for (let i = 0; i < colors.length / 3; i++) {
        colors[i * 3] = source.color.r * (original?.getX(i) ?? 1); colors[i * 3 + 1] = source.color.g * (original?.getY(i) ?? 1); colors[i * 3 + 2] = source.color.b * (original?.getZ(i) ?? 1);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      if (foliage) {
        const sphere = object.userData.treeSphere as THREE.Vector4, treeBounds = new Float32Array(colors.length / 3 * 4);
        for (let i = 0; i < colors.length / 3; i++)sphere.toArray(treeBounds, i * 4);
        geometry.setAttribute('gardenTreeSphere', new THREE.BufferAttribute(treeBounds, 4));
      }
      group.geometries.push(geometry); group.objects.push(object);
    });
    for (const group of groups.values()) {
      const geometry = mergeGeometries(group.geometries, false); if (!geometry) continue;
      const merged = new THREE.Mesh(geometry, group.material); merged.castShadow = true; merged.receiveShadow = true;
      for (const object of group.objects) object.removeFromParent();
      this.scene.add(merged);
      for (const geometry of group.geometries) geometry.dispose();
    }
    for (const group of instances.values()) {
      const mesh = new THREE.InstancedMesh(group.geometry, group.material, group.objects.length);
      // Each tree's branches and crowns share one fade value, so no cut surfaces
      // or noisy holes appear when it stands between the guest and the camera.
      const geometry = group.geometry.clone(), treeBounds = new Float32Array(group.objects.length * 4); mesh.geometry = geometry;
      group.objects.forEach((object, i) => { mesh.setMatrixAt(i, object.matrixWorld); mesh.setColorAt(i, (object.material as THREE.MeshStandardMaterial).color); (object.userData.treeSphere as THREE.Vector4).toArray(treeBounds, i * 4); object.removeFromParent(); });
      geometry.setAttribute('gardenTreeSphere', new THREE.InstancedBufferAttribute(treeBounds, 4));
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere(); mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh);
    }
  }
  private configureFoliage(material: THREE.MeshStandardMaterial) {
    material.onBeforeCompile = shader => {
      shader.uniforms.gardenFocus = this.foliageView.focus; shader.uniforms.gardenCamera = this.foliageView.camera; shader.uniforms.gardenFade = this.foliageView.enabled;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 gardenTreeSphere; varying float vGardenCoverage; uniform vec3 gardenFocus; uniform vec3 gardenCamera; uniform float gardenFade;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec3 gardenRay=gardenCamera-gardenFocus;
          float gardenLength=max(length(gardenRay),.001);
          float gardenT=dot(gardenTreeSphere.xyz-gardenFocus,gardenRay)/(gardenLength*gardenLength);
          float gardenDistance=length(gardenTreeSphere.xyz-gardenFocus-gardenRay*clamp(gardenT,0.0,1.0));
          float gardenCover=1.0-smoothstep(gardenTreeSphere.w+.25,gardenTreeSphere.w+1.65,gardenDistance);
          gardenCover*=step(.01,gardenT)*step(gardenT,1.0+gardenTreeSphere.w/gardenLength)*gardenFade;
          vGardenCoverage=1.0-gardenCover;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGardenCoverage;')
        .replace('#include <alphatest_fragment>', `diffuseColor.a*=vGardenCoverage;
          #include <alphatest_fragment>`);
    };
    material.customProgramCacheKey = () => 'garden-foliage-view-v3';
  }
  private async loadProps() {
    try {
      const gltf = await new GLTFLoader().loadAsync('/models/lantern.glb');
      for (const d of districts) {
        const parent = new THREE.Group(); parent.position.set(d.center[0], 0, d.center[1]); parent.rotation.y = d.rotation;
        this.scene.add(parent);
        for (const x of [-9, -6, -3, 3, 6, 9]) {
          const lantern = gltf.scene.clone(true); lantern.position.set(x, 4.2, -16.7);
          lantern.scale.setScalar(d.id === 'vietnam' ? 1.05 : .65);
          if (d.id !== 'vietnam') lantern.traverse(o => { if (o instanceof THREE.Mesh) { o.material = material(d.id === 'japan' ? '#ecdfbe' : d.flower); } });
          parent.add(lantern);
          this.hangingLanterns.push(lantern);
          const thread = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .8, 5), material('#867955')); thread.position.set(x, 5.5, -16.7); parent.add(thread);
        }
      }
      this.dispatchEvent(new Event('assets_ready'));
    } catch { this.dispatchEvent(new CustomEvent('notice', { detail: 'A decorative lantern could not load. The park is still playable.' })); }
  }

  private makeAvatar(color: number): Avatar {
    const model = new GuestModel(color), group = model.root;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(.44, 20), new THREE.MeshBasicMaterial({ color: '#3a5645', transparent: true, opacity: .16, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = .02; group.add(shadow);
    const label = textSprite('', '#173a32', 'rgba(250,248,240,.9)', 1.8); label.position.set(0, 2.45, 0); group.add(label);
    const effect = textSprite('♡', '#a64f5a', 'rgba(247,248,242,0)', 1.4); effect.position.set(0, 2.8, 0); effect.visible = false; group.add(effect);
    const wardrobe = new THREE.Group(), headwear = new THREE.Group(), prop = new THREE.Group();
    model.bones.Chest.add(wardrobe); wardrobe.position.y = -1.22;
    model.bones.Head.add(headwear); headwear.position.y = -1.68;
    model.bones.HandR.add(prop);
    return { group, model, label, effect, wardrobe, headwear, prop, propKey: '', target: { id: 0, x: 0, z: 0, yaw: 0, ack: 0, avatar: color, emote: 0 }, lastPosition: new THREE.Vector3(), meta: '', walkTime: 0, district: null, track: new SnapshotTrack(), speed: 0 };
  }
  private clearMeshes(group: THREE.Group) {
    group.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); group.clear();
  }
  private dress(avatar: Avatar, district: string | null, choice: number) {
    this.clearMeshes(avatar.wardrobe); this.clearMeshes(avatar.headwear); const g = avatar.wardrobe;
    avatar.model.setLook(avatar.target.avatar, guestColors[avatar.target.avatar]);
    if (!district) return;
    const colors: Record<string, string[]> = { vietnam: ['#b54d4c', '#eee4ce', '#3f5872'], japan: ['#f3eddb', '#424e4b', '#b76879'], korea: ['#b9565c', '#72947d', '#3f5872'], india: ['#dca449', '#ede0c7', '#bd5855'], italy: ['#78916d', '#f3eddb', '#cbb892'] };
    const color = colors[district][choice]; avatar.model.setLook(avatar.target.avatar, color);
    const robe = (bottom: number, height: number) => cylinder(g, .28, bottom, height, color, 0, .75, 0, 12);
    if (district === 'vietnam') {
      robe(.35, 1.03); for (const x of [-.19, .19]) box(g, .31, .72, .045, color, x, .6, .27);
      box(g, .045, .78, .05, '#d6b96d', .14, .92, .29);
      const hat = mesh(avatar.headwear, new THREE.TorusGeometry(.32, .06, 8, 24), color, 0, 2.02, 0); hat.rotation.x = Math.PI / 2;
    } else if (district === 'japan') {
      robe(.45, 1.1); box(g, .61, .18, .56, choice === 1 ? '#9c9980' : '#c4aa7b', 0, .97, 0);
      if (choice === 0) { const hood = sphere(avatar.headwear, .43, '#f4eedf', 0, 2.02, -.12, 2); hood.scale.set(1.1, .7, 1); }
      else if (choice === 1) box(avatar.headwear, .35, .2, .34, '#3f4742', 0, 2.04, 0);
    } else if (district === 'korea') {
      robe(choice === 2 ? .4 : .58, 1.08); box(g, .64, .28, .5, choice === 2 ? '#677e8d' : '#e6c8a6', 0, 1.08, 0);
      box(g, .045, .24, .05, '#d6ad69', .12, .96, .29);
      if (choice === 2) { box(avatar.headwear, .5, .12, .38, '#354952', 0, 2.04, 0); for (const side of [-1, 1]) box(avatar.headwear, .25, .05, .17, '#354952', side * .32, 2.09, 0); }
    } else if (district === 'india') {
      robe(choice === 1 ? .35 : .58, 1.05); box(g, .55, .07, .5, '#dfbd6f', 0, 1.14, 0);
      if (choice === 1) { const turban = sphere(avatar.headwear, .36, '#c59b5e', 0, 2.01, -.02, 2); turban.scale.y = .65; }
      else { const drape = box(g, .19, 1.12, .09, '#dbb67d', -.25, 1, .28); drape.rotation.z = -.17; }
      for (const side of [-1, 1]) sphere(g, .04, '#dfbd6f', side * .3, 1.52, 0, 0);
    } else if (district === 'italy') {
      if (choice === 1) { robe(.58, 1.04); const veil = box(avatar.headwear, .68, 1.05, .025, '#e7e4d3', 0, 1.56, -.28); veil.rotation.x = -.12; }
      else { for (const side of [-1, 1]) { const lapel = box(g, .11, .28, .055, '#e7dfc8', side * .1, 1.14, .29); lapel.rotation.z = side * .22; } box(g, .17, .06, .06, '#50674e', 0, 1.26, .31); }
    }
  }
  private ritualProp(avatar: Avatar, key: string) {
    if (avatar.propKey === key) return; avatar.propKey = key; this.clearMeshes(avatar.prop);
    const g = avatar.prop; if (!key) return;
    if (key === 'gifts') { cylinder(g, .4, .4, .08, '#a94640', -.335, 0, .06, 20); cylinder(g, .31, .37, .12, '#d7ad66', -.335, .1, .06, 16); for (const x of [-.17, .17]) sphere(g, .1, '#8a995e', x - .335, .23, .06, 1); }
    else if (key === 'cups' || key === 'toast') { cylinder(g, .12, .065, .14, '#ad5247', 0, .075, .03, 16); cylinder(g, .115, .1, .025, '#d6b56b', 0, .15, .03, 16); }
    else if (key === 'goose') { sphere(g, .27, '#b28f66', -.335, .1, .05, 2).scale.set(1.3, .65, .7); cylinder(g, .05, .08, .3, '#b28f66', -.105, .26, .05, 8); sphere(g, .11, '#b28f66', -.105, .43, .05, 1); box(g, .15, .035, .05, '#c59f68', -.005, .41, .05); }
    else if (key === 'garlands') { const garland = mesh(g, new THREE.TorusGeometry(.32, .065, 8, 24), '#eab348', -.335, .1, .08); garland.scale.y = 1.4; for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; sphere(g, .07, i % 2 ? '#d77955' : '#eed1a1', -.335 + Math.sin(a) * .32, .1 + Math.cos(a) * .45, .08, 1); } }
    else if (key === 'commitment') { const ring = mesh(g, new THREE.TorusGeometry(.1, .025, 8, 24), '#d8b565', 0, .08, .08); ring.rotation.y = .5; }
    else if (key === 'flower') { cylinder(g, .015, .02, .35, '#799369', 0, .12, .02, 6); for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; sphere(g, .075, '#e9bdce', Math.cos(a) * .08, .37 + Math.sin(a) * .08, .02, 1); } }
    else if (key === 'favor') { box(g, .22, .07, .19, '#e9dcc2', 0, .04, .04); for (const x of [-.05, .02, .08]) sphere(g, .035, '#f6ecdb', x, .1, .04, 1).scale.x = .7; }
  }
  setState(state: WorldState) {
    this.state = state; this.grants = new Set(state.self.grants);
    if (this.localRevision !== state.self.revision) { this.movement.reset(this.predicted); if (this.destination) this.stopWalking(); this.route = []; this.localRevision = state.self.revision; }
    for (const meta of state.nearby || []) {
      const avatar = this.avatars.get(meta.id); if (!avatar) continue;
      if (avatar.meta !== `${meta.nickname}:${meta.attire}:${meta.district}`) {
        avatar.label.material.map?.dispose(); avatar.label.material.dispose(); avatar.label.removeFromParent();
        avatar.label = textSprite(meta.nickname, '#173a32', 'rgba(250,248,240,.9)', Math.max(1.6, Math.min(2.5, meta.nickname.length * .12)));
        avatar.label.position.set(0, 2.4, 0); avatar.group.add(avatar.label);
        avatar.meta = `${meta.nickname}:${meta.attire}:${meta.district}`; avatar.district = meta.district;
        this.dress(avatar, meta.district, meta.attire);
      }
    }
  }
  private snapshot(snapshot: Snapshot) {
    const ids = new Set(snapshot.players.map(p => p.id));
    for (const [id, a] of this.avatars) if (!ids.has(id)) {
      a.model.dispose();
      a.group.removeFromParent(); a.group.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      for (const sprite of [a.label, a.effect]) { sprite.material.map?.dispose(); sprite.material.dispose(); }
      this.avatars.delete(id);
    }
    for (const p of snapshot.players) {
      let avatar = this.avatars.get(p.id);
      if (!avatar) { avatar = this.makeAvatar(p.avatar); avatar.group.position.set(p.x, .23, p.z); avatar.target = p; avatar.target.id = p.id; this.scene.add(avatar.group); this.avatars.set(p.id, avatar); if (p.id === this.connection.id) { this.cameraSnap = true; const district = zoneAt(p.x, p.z), aim = district ? toWorld(district, 0, -18) : worldMap.registrar; this.yaw = Math.atan2(p.x - aim[0], p.z - aim[1]); } }
      avatar.target = p;
      const discontinuity = avatar.track.push({ time: snapshot.time, x: p.x, z: p.z, yaw: p.yaw });
      if (discontinuity && p.id !== this.connection.id) avatar.group.position.set(p.x, .23, p.z);
      if (p.id === this.connection.id) {
        const teleport = this.movement.reconcile([p.x, p.z], snapshot.time, this.connection.now(), this.grants);
        this.predicted = this.movement.position;
        if (teleport) { this.position = [p.x, p.z]; avatar.group.position.set(p.x, .23, p.z); if (this.destination) this.stopWalking(); this.route = []; this.cameraSnap = true; }
      }
    }
    if (this.state) this.setState(this.state);
  }
  activate() { this.active = true; this.cameraSnap = true; this.canvas.focus(); this.camera.clearViewOffset(); this.resize(); this.dispatchEvent(new Event('activated')); }
  setLandingDistrict(id: string) { const d = districtById[id]; if (d) { this.landingDistrict = d; this.dispatchEvent(new CustomEvent('landing_district', { detail: d })); } }
  setMode(mode: CameraMode, eventId?: string): boolean {
    if (mode === 'CINEMATIC_SPECTATOR') {
      const watched = eventId ? this.state?.directory.find(e => e.id === eventId) : this.state?.viewing || this.state?.wedding;
      const local = zoneAt(...this.position);
      const event = watched?.state === 'CEREMONY_ACTIVE' ? watched : this.state?.directory.find(e => e.state === 'CEREMONY_ACTIVE' && e.district === local?.id);
      if (!event) { this.dispatchEvent(new CustomEvent('notice', { detail: 'A spectator viewpoint becomes available near a live ceremony or while following one.' })); return false; }
      this.cinematicDistrict = districtById[event.district];
    }
    this.mode = mode; this.dispatchEvent(new CustomEvent('camera', { detail: mode })); return true;
  }
  cycleCamera() { const modes: CameraMode[] = ['THIRD_PERSON', 'FIRST_PERSON', 'ISOMETRIC']; this.setMode(modes[(modes.indexOf(this.mode) + 1) % modes.length]); }
  setJoystick(x: number, z: number) { if (Math.hypot(x, z) > .1 && this.destination) this.stopWalking(); this.joystick = [x, z]; }
  navigate(point: Point, name: string) {
    const route = findPath(this.position, point, this.grants);
    if (!route.length) { this.dispatchEvent(new CustomEvent('notice', { detail: 'That place is not accessible in your current role. Use a public path or viewing area.' })); return; }
    this.route = route; this.destination = point; this.destinationName = name;
    this.routeMarker.position.set(point[0], .27, point[1]); this.routeMarker.visible = true;
    if (this.routeLine) { this.scene.remove(this.routeLine); this.routeLine.geometry.dispose(); (this.routeLine.material as THREE.Material).dispose(); }
    const points = [this.position, ...route].map(p => new THREE.Vector3(p[0], .3, p[1]));
    this.routeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: '#fff3ce', dashSize: .6, gapSize: .6, transparent: true, opacity: .8 }));
    this.routeLine.computeLineDistances(); this.scene.add(this.routeLine);
    let distance = 0, previous = this.position; for (const p of route) { distance += Math.hypot(p[0] - previous[0], p[1] - previous[1]); previous = p; }
    this.dispatchEvent(new CustomEvent('navigation', { detail: { name, distance } }));
  }
  stopWalking() { this.route = []; this.destination = null; this.routeMarker.visible = false; this.keys.clear(); this.joystick = [0, 0]; if (this.routeLine) this.routeLine.visible = false; this.dispatchEvent(new Event('navigation_end')); }
  resetInput() { if (this.destination) this.stopWalking(); this.keys.clear(); this.joystick = [0, 0]; this.currentInput = [0, 0]; this.pointer = null; if (this.active && this.connection.connected) this.connection.input(0, 0, this.avatars.get(this.connection.id)?.target.yaw || 0); this.sentMoving = false; }
  capture(): string { this.renderer.render(this.scene, this.camera); return this.canvas.toDataURL('image/png'); }
  resize() {
    const width = innerWidth, height = innerHeight;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height;
    if (!this.active && width > 760) this.camera.setViewOffset(width, height, -width * .19, 0, width, height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
  private setupInput() {
    window.addEventListener('keydown', event => {
      if (!this.active || !this.controlsEnabled || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) { event.preventDefault(); if (!this.photoMode) { if (this.destination) this.stopWalking(); this.keys.add(event.code); } }
      if (event.code === 'KeyV' && !event.repeat) this.cycleCamera();
      if (event.code === 'KeyC' && !event.repeat) this.setMode(this.mode === 'CINEMATIC_SPECTATOR' ? 'THIRD_PERSON' : 'CINEMATIC_SPECTATOR');
      if (event.code === 'KeyE' && !event.repeat) this.dispatchEvent(new Event('interact'));
    });
    window.addEventListener('keyup', event => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.resetInput());
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('pointerdown', e => {
      if (!this.active || !this.controlsEnabled || this.pointer) return;
      this.canvas.focus(); this.pointer = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, time: performance.now(), id: e.pointerId }; this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this.controlsEnabled || !this.pointer || e.pointerId !== this.pointer.id) return;
      this.yaw -= (e.clientX - this.pointer.x) * .005 * this.sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.pointer.y) * .004 * this.sensitivity, this.mode === 'FIRST_PERSON' ? -.85 : .12, 1.25);
      this.pointer.x = e.clientX; this.pointer.y = e.clientY;
    });
    this.canvas.addEventListener('pointerup', e => {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      const p = this.pointer; this.pointer = null;
      if (this.photoMode || !this.controlsEnabled) return;
      if (!p || Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 5 || performance.now() - p.time > 400 || e.button !== 0) return;
      this.raycaster.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), this.camera);
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.ground, point)) return;
      if (Math.hypot(point.x - worldMap.registrar[0], point.z - worldMap.registrar[1]) < 5) { this.dispatchEvent(new Event('interact')); return; }
      const district = zoneAt(point.x, point.z), local = district ? toLocal(district, point.x, point.z) : null;
      if (district && local && Math.abs(local[0] + 10) < 3 && Math.abs(local[1] - 30) < 4) { this.dispatchEvent(new CustomEvent('program', { detail: district.id })); return; }
      if (walkable(point.x, point.z, this.grants)) this.navigate([point.x, point.z], 'Garden path');
      else this.dispatchEvent(new CustomEvent('notice', { detail: 'Follow the garden paths. Ceremony areas open only to their assigned participants.' }));
    });
    for (const event of ['pointercancel', 'lostpointercapture']) this.canvas.addEventListener(event, () => this.pointer = null);
    this.canvas.addEventListener('wheel', e => { if (!this.active || !this.controlsEnabled) return; e.preventDefault(); this.zoom = THREE.MathUtils.clamp(this.zoom + e.deltaY * .012, 4, 36); }, { passive: false });
  }
  private collectInput(): Point {
    if (!this.active || !this.controlsEnabled || this.photoMode || !this.connection.connected || document.hidden || (this.state?.self.motionUntil || 0) > this.connection.now()) return [0, 0];
    let x = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) + this.joystick[0];
    let z = Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) - Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) + this.joystick[1];
    if (Math.hypot(x, z) > .1) { const c = Math.cos(this.yaw), s = Math.sin(this.yaw); return [c * x + s * z, -s * x + c * z]; }
    while (this.route.length) {
      const p = this.route[0], dx = p[0] - this.predicted[0], dz = p[1] - this.predicted[1], distance = Math.hypot(dx, dz);
      if (distance < .2) { this.route.shift(); continue; }
      const strength = this.route.length === 1 ? Math.min(1, distance / .5) : 1;
      return [dx / distance * strength, dz / distance * strength];
    }
    if (this.destination) { this.stopWalking(); this.dispatchEvent(new CustomEvent('notice', { detail: `You arrived at ${this.destinationName || 'your destination'}.` })); }
    return [0, 0];
  }
  private frame() {
    const elapsed = this.clock.getDelta(), dt = Math.min(elapsed, .08), now = performance.now() / 1000, serverNow = this.connection.now();
    this.renderTime += dt; this.frameCount++; this.fpsTime += elapsed;
    if (this.fpsTime > 2) {
      this.frameRate = Math.round(this.frameCount / this.fpsTime); this.frameCount = 0; this.fpsTime = 0;
      if (this.frameRate < 28 && this.renderer.getPixelRatio() > 1) this.renderer.setPixelRatio(Math.max(1, this.renderer.getPixelRatio() - .2));
    }
    if (this.active) {
      const input = this.collectInput(), moving = Math.hypot(...input) > .05;
      this.currentInput = input;
      if (this.connection.connected && (now - this.lastInput >= .04 || moving !== this.sentMoving)) {
        this.lastInput = now; this.sentMoving = moving;
        const yaw = Math.hypot(...input) > .05 ? Math.atan2(input[0], input[1]) : (this.avatars.get(this.connection.id)?.target.yaw || 0);
        this.connection.input(input[0], input[1], yaw);
      }
      if (this.connection.connected) {
        const scripted = (this.state?.self.motionUntil || 0) > serverNow, sample = this.avatars.get(this.connection.id)?.track.sample(serverNow);
        if (scripted && sample) { this.movement.reset([sample.x, sample.z]); this.predicted = this.movement.position; }
        else this.predicted = this.movement.step(input, dt, serverNow, this.grants);
      }
    }
    for (const [id, a] of this.avatars) {
      const local = id === this.connection.id, sample = a.track.sample(serverNow);
      const target = local ? this.predicted : [sample?.x ?? a.target.x, sample?.z ?? a.target.z];
      const previousX = a.group.position.x, previousZ = a.group.position.z;
      a.group.position.x = target[0]; a.group.position.z = target[1];
      if (local) this.position = [a.group.position.x, a.group.position.z];
      const speed = Math.min(7, Math.hypot(a.group.position.x - previousX, a.group.position.z - previousZ) / Math.max(dt, .001));
      a.speed += (speed - a.speed) * (1 - Math.exp(-dt * 12));
      const targetYaw = local && Math.hypot(...this.currentInput) > .1 ? Math.atan2(this.currentInput[0], this.currentInput[1]) : sample?.yaw ?? a.target.yaw;
      a.group.rotation.y += Math.atan2(Math.sin(targetYaw - a.group.rotation.y), Math.cos(targetYaw - a.group.rotation.y)) * Math.min(1, dt * 15);
      a.group.position.y = .23;
      const district = a.district || zoneAt(a.target.x, a.target.z)?.id;
      const phase = this.state?.directory.find(e => e.district === district && e.state === 'CEREMONY_ACTIVE')?.phase;
      const ritual = a.target.emote === 8, gesture = ritual ? phase?.id || '' : a.target.emote === 7 ? 'toast' : a.target.emote === 9 ? 'flower' : a.target.emote === 11 ? 'favor' : '';
      this.ritualProp(a, ['gifts', 'cups', 'goose', 'garlands', 'commitment', 'toast', 'flower', 'favor'].includes(gesture) ? gesture : '');
      a.prop.visible = local || Math.hypot(a.group.position.x - this.position[0], a.group.position.z - this.position[1]) < 45;
      a.effect.visible = a.target.emote === 3 || a.target.emote === 4; a.effect.position.y = 2.8 + (this.reducedMotion ? 0 : Math.sin(now * 2) * .12);
      const distance = Math.hypot(a.group.position.x - this.position[0], a.group.position.z - this.position[1]);
      const emotes = ['', 'wave', 'bow', 'congratulate', 'petals', 'dance', 'photo', 'toast', 'ritual', 'flower', 'blessing', 'favor'];
      a.model.animate(dt, a.speed, ritual ? gesture : emotes[a.target.emote] || '', this.reducedMotion, !local && distance > 35);
      a.label.visible = !local && distance < 25; a.group.visible = !(local && this.mode === 'FIRST_PERSON');
    }
    for (const host of this.hosts) host.animate(dt, 0, '', this.reducedMotion, true);
    for (let i = 0; i < this.hangingLanterns.length; i++)this.hangingLanterns[i].rotation.z = this.reducedMotion ? 0 : Math.sin(now * .85 + i * .7) * .025;
    if (!this.reducedMotion) {
      for (const f of this.wavingFlags) {
        const pos = f.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const x = f.baseX[i], y = f.baseY[i], u = x / 2.45;
          pos.setZ(i, u * (Math.sin(now * 3.8 - u * 4.5 + f.phase) * .22 + Math.sin(now * 2.2 - u * 2.4 + y * 1.2 + f.phase) * .07));
          pos.setY(i, y + u * Math.cos(now * 3.8 - u * 4.5 + f.phase) * .04);
        }
        pos.needsUpdate = true;
        f.geometry.computeVertexNormals();
      }
    }
    this.updateCamera(Math.min(elapsed, 1));
    if (this.routeMarker.visible && !this.reducedMotion) this.routeMarker.scale.setScalar(1 + Math.sin(now * 3) * .1);
    this.renderer.render(this.scene, this.camera);
  }
  private updateCamera(dt: number) {
    const target = new THREE.Vector3(), desired = new THREE.Vector3();
    if (!this.active) {
      const d = this.landingDistrict, p = toWorld(d, 0, -4);
      this.previewTarget.lerp(new THREE.Vector3(p[0], 1.5, p[1]), this.reducedMotion ? 1 : 1 - Math.exp(-dt * 2));
      target.copy(this.previewTarget);
      const offset = toWorld(d, innerWidth < 760 ? 76 : 71, innerWidth < 760 ? 94 : 78);
      desired.set(offset[0], innerWidth < 760 ? 72 : 57, offset[1]);
    } else if (this.mode === 'CINEMATIC_SPECTATOR' && this.cinematicDistrict) {
      const d = this.cinematicDistrict, views = d.cinematicViews?.length ? d.cinematicViews : [[26, 6, 10, 0, 1.4, -18], [-26, 6, -5, 0, 1.4, -18], [25, 13, -35, 0, 1.4, -18]];
      const [cx, cy, cz, ax, ay, az] = views[this.cinematicIndex % views.length], pos = toWorld(d, cx, cz), aim = toWorld(d, ax, az);
      desired.set(pos[0], cy, pos[1]); target.set(aim[0], ay, aim[1]);
    } else {
      target.set(this.position[0], this.mode === 'FIRST_PERSON' ? 1.75 : 1.3, this.position[1]);
      if (this.mode === 'FIRST_PERSON') {
        desired.copy(target); target.add(new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch) * .5, -Math.cos(this.yaw) * Math.cos(this.pitch)));
      } else if (this.mode === 'ISOMETRIC') {
        const distance = this.zoom * 2.1; desired.set(target.x + Math.sin(this.yaw) * distance, target.y + distance * 1.25, target.z + Math.cos(this.yaw) * distance);
      } else {
        desired.set(target.x + Math.sin(this.yaw) * this.zoom * Math.cos(this.pitch), target.y + Math.sin(this.pitch) * this.zoom + 1.5, target.z + Math.cos(this.yaw) * this.zoom * Math.cos(this.pitch));
        const direction = desired.clone().sub(target), distance = direction.length();
        this.raycaster.set(target, direction.normalize()); this.raycaster.far = distance;
        const hits = this.raycaster.intersectObjects(this.colliders, false);
        let clearDistance = hits.length ? Math.min(distance, hits[0].distance - .4) : distance;
        if (clearDistance < distance) desired.copy(target).addScaledVector(direction, Math.max(1.8, clearDistance));
      }
    }
    const blend = this.reducedMotion || this.cameraSnap || this.camera.position.length() < 1 ? 1 : 1 - Math.exp(-dt * (this.mode === 'FIRST_PERSON' ? 35 : 5));
    this.cameraSnap = false;
    this.camera.position.lerp(desired, blend); this.cameraTarget.lerp(target, blend); this.camera.lookAt(this.cameraTarget);
    this.foliageView.focus.value.set(this.position[0], 1.3, this.position[1]); this.foliageView.camera.value.copy(this.camera.position);
    this.foliageView.enabled.value = this.active && this.mode === 'THIRD_PERSON' ? 1 : 0;
    const focus = this.active ? new THREE.Vector3(this.position[0], 0, this.position[1]) : this.previewTarget;
    this.sun.target.position.copy(focus); this.sun.position.copy(focus).add(new THREE.Vector3(-42, 85, 47));
    this.sun.target.updateMatrixWorld();
  }
}
