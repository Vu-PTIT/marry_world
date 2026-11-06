import data from '../shared/world.json';
import type { District } from './types';

export const worldMap = data;
export const districts = data.districts as District[];
export const districtById = Object.fromEntries(districts.map(d => [d.id, d]));
export type Point = [number, number];
export function toWorld(d: District, x: number, z: number): Point {
  const c = Math.cos(d.rotation), s = Math.sin(d.rotation);
  return [d.center[0] + c * x + s * z, d.center[1] - s * x + c * z];
}
export function toLocal(d: District, x: number, z: number): Point {
  const c = Math.cos(d.rotation), s = Math.sin(d.rotation), dx = x - d.center[0], dz = z - d.center[1];
  return [c * dx - s * dz, s * dx + c * dz];
}
export function inRect(x: number, z: number, b: number[], padding = 0): boolean {
  return x >= b[0] - padding && x <= b[1] + padding && z >= b[2] - padding && z <= b[3] + padding;
}
function segmentDistance(x: number, z: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x-a[0])*dx + (z-a[1])*dz) / (dx*dx + dz*dz || 1)));
  return Math.hypot(x-a[0]-t*dx, z-a[1]-t*dz);
}
export const gates = Object.fromEntries(districts.map(d => [d.id, toWorld(d, ...worldMap.gate as Point)]));
export const paths: {a: Point; b: Point; width: number}[] = [
  ...districts.map(d => ({ a: [0,0] as Point, b: gates[d.id], width: 8 })),
  ...worldMap.transitions.map(t => ({ a: gates[t.from], b: gates[t.to], width: 8 })),
];
export function walkable(x: number, z: number, grants = new Set<string>()): boolean {
  if (worldMap.globalColliders.some(c => ('bounds' in c && c.bounds) ? inRect(x, z, (c as any).bounds, .34) : Math.hypot(x - (c as any).center[0], z - (c as any).center[1]) < (c as any).radius + .34)) return false;
  let found = Math.hypot(x, z) <= worldMap.plazaRadius - .34;
  for (const d of districts) {
    const [lx, lz] = toLocal(d,x,z);
    if (!inRect(lx,lz,worldMap.districtBounds,-.34)) continue;
    found = true;
    if (worldMap.colliders.some(c => inRect(lx,lz,c.bounds,.34))) return false;
    if (d.colliders?.some(c => inRect(lx,lz,c.bounds,.34))) return false;
    for (const a of worldMap.areas) {
      if (inRect(lx,lz,a.bounds,.34) && !grants.has(`${d.id}:${a.id}`)) return false;
    }
  }
  return found || paths.some(p => segmentDistance(x,z,p.a,p.b) <= p.width/2-.34);
}
export function move(x: number,z: number,dx: number,dz: number,dt: number,grants: Set<string>): Point {
  const len = Math.hypot(dx,dz);
  if (len > 1) { dx /= len; dz /= len; }
  const distance = worldMap.speed * Math.min(.1, Math.max(0,dt)), steps = Math.max(1,Math.ceil(distance/.15));
  for (let i=0;i<steps;i++) {
    const nx=x+dx*distance/steps,nz=z+dz*distance/steps;
    if (walkable(nx,nz,grants)) {x=nx;z=nz;}
    else if (walkable(nx,z,grants)) x=nx;
    else if (walkable(x,nz,grants)) z=nz;
  }
  return [x,z];
}
export function zoneAt(x: number,z: number): District | undefined {
  return districts.find(d => {const [lx,lz]=toLocal(d,x,z);return inRect(lx,lz,worldMap.districtBounds,4);});
}

export function clearWalk(a: Point,b: Point,grants: Set<string>): boolean {
  const steps=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.2));
  for(let i=1;i<=steps;i++)if(!walkable(a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps,grants))return false;
  return true;
}

// A* follows the same traversability/access data as the server. No travel teleport.
export function findPath(start: Point, target: Point, grants: Set<string>): Point[] {
  const step = 2, key = (x:number,z:number) => `${x},${z}`;
  const sx=Math.round(start[0]/step),sz=Math.round(start[1]/step),tx=Math.round(target[0]/step),tz=Math.round(target[1]/step);
  const endKey=key(tx,tz), heap: {x:number;z:number;g:number;f:number}[]=[];
  const costs=new Map<string,number>(),parents=new Map<string,string>();
  const push=(n:typeof heap[number])=>{heap.push(n);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p].f<=n.f)break;heap[i]=heap[p];i=p;}heap[i]=n;};
  const pop=()=>{const n=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1].f<heap[j].f)j++;if(last.f<=heap[j].f)break;heap[i]=heap[j];i=j;}heap[i]=last;}return n;};
  push({x:sx,z:sz,g:0,f:Math.hypot(tx-sx,tz-sz)});costs.set(key(sx,sz),0);
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let end='';
  for(let count=0;heap.length&&count<35000;count++){
    const n=pop(),nk=key(n.x,n.z);
    if(n.g>(costs.get(nk)??Infinity))continue;
    if(nk===endKey||Math.hypot(n.x*step-target[0],n.z*step-target[1])<2){end=nk;break;}
    for(const [dx,dz]of dirs){
      const x=n.x+dx,z=n.z+dz,k=key(x,z),g=n.g+Math.hypot(dx,dz);
      if(g>=(costs.get(k)??Infinity)||Math.abs(x)>140||Math.abs(z)>140)continue;
      if(!walkable(x*step,z*step,grants)||!walkable((x+n.x)*step/2,(z+n.z)*step/2,grants))continue;
      costs.set(k,g);parents.set(k,nk);push({x,z,g,f:g+Math.hypot(tx-x,tz-z)});
    }
  }
  if(!end)return [];
  const route:Point[]=[];
  while(end!==key(sx,sz)){
    const [x,z]=end.split(',').map(Number);route.push([x*step,z*step]);
    end=parents.get(end)!;if(!end)break;
  }
  route.reverse();
  if(walkable(...target,grants))route.push(target);
  // Keep only turns that the collision/access map actually requires.
  const smooth:Point[]=[];let origin=start,index=0;
  while(index<route.length){
    let next=route.length-1;
    while(next>=index&&!clearWalk(origin,route[next],grants))next--;
    if(next<index)return [];
    smooth.push(route[next]);origin=route[next];index=next+1;
  }
  return smooth;
}
