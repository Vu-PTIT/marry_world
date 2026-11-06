import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/lora/400.css';
import './style.css';
import { WorldConnection } from './network';
import { GardenScene } from './scene';
import { WorldUI } from './ui';

const root=document.querySelector<HTMLElement>('#app')!;
export const runtime:{scene?:GardenScene;connection?:WorldConnection;ui?:WorldUI}={};
const canvas=document.createElement('canvas');canvas.className='world-canvas';canvas.tabIndex=0;
canvas.setAttribute('aria-label','Three-dimensional wedding park. Use WASD or arrow keys to walk after entering.');root.append(canvas);
try{
  const connection=new WorldConnection();
  const scene=new GardenScene(canvas,connection);
  const ui=new WorldUI(root,scene,connection);
  Object.assign(runtime,{scene,connection,ui});
  if(import.meta.env.DEV)(window as unknown as {__ww:typeof runtime}).__ww=runtime;
  document.fonts.ready.then(()=>ui.ready());
  if(!location.pathname.startsWith('/w/'))connection.restore();
}catch(error){
  console.error(error);
  const fallback=document.createElement('section');fallback.className='graphics-error';
  fallback.innerHTML='<h1>The garden needs a 3D view.</h1><p>Enable WebGL in a current browser, then reload to explore Wedding World.</p><button onclick="location.reload()">Try again</button>';
  root.append(fallback);
}
