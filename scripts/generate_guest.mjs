import { writeFile } from 'node:fs/promises';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildAvatarAsset } from '../src/avatar-model.ts';

// GLTFExporter uses this browser interface for its final binary Blob.
globalThis.FileReader=class {
  readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}
  readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result=`data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;this.onloadend?.();});}
};
for(const gender of ['male','female']){
  const asset=buildAvatarAsset(gender);
  const binary=await new GLTFExporter().parseAsync(asset.root,{binary:true,animations:asset.clips,trs:true});
  const file=gender==='female'?'guest-dress.glb':'guest.glb';
  await writeFile(new URL(`../public/models/${file}`,import.meta.url),Buffer.from(binary));
  const mesh=asset.root.getObjectByName('GuestSkin');
  console.log(JSON.stringify({file:`public/models/${file}`,bytes:binary.byteLength,bones:mesh.skeleton.bones.length,clips:asset.clips.map(c=>c.name),triangles:mesh.geometry.getAttribute('position').count/3}));
}
