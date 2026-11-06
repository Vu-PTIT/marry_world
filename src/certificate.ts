import { districtById } from './map';
import type { Evidence } from './types';

export const DISCLAIMER='Virtual ceremony keepsake. For entertainment only. Not a legal marriage certificate.';
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));

export async function verifyEvidence(evidence:Evidence,trustedKey:string):Promise<boolean>{
  try{
    if(evidence.algorithm!=='Ed25519'||evidence.publicKey!==trustedKey||evidence.payload.disclaimer!==DISCLAIMER)return false;
    const canonical=JSON.stringify(evidence.payload,Object.keys(evidence.payload).sort());
    if(evidence.canonical!==canonical)return false;
    const key=await crypto.subtle.importKey('raw',decode(evidence.publicKey),{name:'Ed25519'},false,['verify']);
    return await crypto.subtle.verify({name:'Ed25519'},key,decode(evidence.signature),new TextEncoder().encode(evidence.canonical));
  }catch{return false;}
}

export function download(url:string,name:string){const a=document.createElement('a');a.href=url;a.download=name;a.click();}
export function saveEvidence(evidence:Evidence){
  const url=URL.createObjectURL(new Blob([JSON.stringify(evidence,null,2)],{type:'application/json'}));
  download(url,`wedding-world-${evidence.payload.eventReference}.json`);window.setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function leaf(ctx:CanvasRenderingContext2D,x:number,y:number,angle:number,color:string,size=35){
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(0,0,size,size*.36,0,0,Math.PI*2);ctx.fill();ctx.restore();
}
function blossom(ctx:CanvasRenderingContext2D,x:number,y:number,color:string,size=35){
  for(let i=0;i<5;i++){const a=i*Math.PI*2/5;leaf(ctx,x+Math.cos(a)*size*.6,y+Math.sin(a)*size*.6,a,color,size*.7);}
  ctx.fillStyle='#c9a15b';ctx.beginPath();ctx.arc(x,y,size*.15,0,Math.PI*2);ctx.fill();
}

export async function renderCertificate(evidence:Evidence):Promise<HTMLCanvasElement>{
  await Promise.all([document.fonts.load('400 40px "Lora"'),document.fonts.load('400 40px "DM Sans"')]);
  const canvas=document.createElement('canvas');canvas.width=2480;canvas.height=3508;
  const ctx=canvas.getContext('2d')!,d=districtById[evidence.payload.district];
  ctx.fillStyle='#fbfaf3';ctx.fillRect(0,0,2480,3508);
  ctx.strokeStyle=d.color;ctx.lineWidth=3;ctx.strokeRect(110,110,2260,3288);
  if(d.id==='vietnam'){
    ctx.strokeRect(135,135,2210,3238);
    for(const x of [220,2260])for(let y=240;y<3200;y+=180){leaf(ctx,x,y,-.7,'#a3ac86',42);blossom(ctx,x,y+60,'#d6a19a',32);}
  }else if(d.id==='japan'){
    ctx.fillStyle='#eee7d8';ctx.fillRect(180,180,110,3148);
    for(let i=0;i<14;i++)blossom(ctx,1950+Math.sin(i*2.1)*230,260+i*49,'#e3c3cd',38);
  }else if(d.id==='korea'){
    for(let i=0;i<9;i++){ctx.fillStyle=i%2?'#d8dfd4':'#e6e3d3';ctx.fillRect(190+i*237,190,220,400);}
    for(let i=0;i<7;i++)blossom(ctx,550+i*230,520,'#bb7d86',38);
  }else if(d.id==='india'){
    ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(350,900);ctx.lineTo(350,650);ctx.quadraticCurveTo(1240,-50,2130,650);ctx.lineTo(2130,900);ctx.stroke();
    for(let i=0;i<19;i++){const a=i/18*Math.PI;blossom(ctx,1240+900*Math.cos(a),680-390*Math.sin(a),'#e3b15d',45);}
  }else{
    for(const side of [-1,1])for(let i=0;i<14;i++){
      const x=1240+side*(760+Math.sin(i/13*Math.PI)*155),y=650+i*140;
      leaf(ctx,x,y,side*(.45+i*.05),'#82956c',50);leaf(ctx,x+side*30,y+47,-side*.7,'#abb18a',38);
    }
  }
  ctx.textAlign='center';ctx.fillStyle='#244e43';ctx.font='400 56px "DM Sans"';ctx.fillText('Wedding World',1240,795);
  ctx.strokeStyle=d.color;ctx.lineWidth=3;
  for(const x of [1206,1274]){ctx.beginPath();ctx.ellipse(x,945,45,64,x<1240?-.35:.35,0,Math.PI*2);ctx.stroke();}
  ctx.fillStyle='#244e43';ctx.font='400 100px "Lora"';ctx.fillText('Virtual Wedding',1240,1170);ctx.fillText('Certificate',1240,1305);
  ctx.font='400 37px "DM Sans"';ctx.fillStyle='#617362';ctx.fillText('A keepsake of a moment shared',1240,1450);
  const fit=(text:string,y:number)=>{let size=125;do{ctx.font=`400 ${size}px "Lora"`;size-=2;}while(ctx.measureText(text).width>1640&&size>50);ctx.fillText(text,1240,y);};
  ctx.fillStyle=d.color;fit(evidence.payload.couple[0],1735);
  ctx.fillStyle='#7b8c75';ctx.font='400 65px "Lora"';ctx.fillText('&',1240,1860);
  ctx.fillStyle=d.color;fit(evidence.payload.couple[1],2010);
  ctx.strokeStyle='#cbd1bb';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(880,2150);ctx.lineTo(1600,2150);ctx.stroke();
  ctx.fillStyle='#244e43';ctx.font='400 52px "Lora"';ctx.fillText(`${d.name} · ${d.venue}`,1240,2280);
  ctx.fillStyle='#617362';ctx.font='400 34px "Lora"';
  const date=new Intl.DateTimeFormat(undefined,{dateStyle:'long',timeStyle:'short'}).format(new Date(evidence.payload.completedAt));ctx.fillText(date,1240,2370);
  ctx.font='400 28px "DM Sans"';ctx.fillText('A symbolic celebration, freely chosen by both participants.',1240,2530);
  ctx.fillStyle='#617362';ctx.font='400 24px "DM Sans"';ctx.fillText(`Event reference ${evidence.payload.eventReference}`,1240,2780);
  ctx.fillText('Issued by Wedding World · Ed25519 signed completion evidence',1240,2830);
  ctx.font='400 22px "DM Sans"';ctx.fillText(`Signature ${evidence.signature.slice(0,44)}`,1240,2890);ctx.fillText(evidence.signature.slice(44),1240,2925);
  ctx.fillStyle='#53654f';ctx.font='400 27px "DM Sans"';
  const words=DISCLAIMER.split(' '),lines:string[]=[];let line='';
  for(const word of words){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>1740){lines.push(line);line=word;}else line=next;}lines.push(line);
  lines.forEach((text,i)=>ctx.fillText(text,1240,3120+i*44));
  return canvas;
}

export async function savePDF(canvas:HTMLCanvasElement,evidence:Evidence){
  const {jsPDF}=await import('jspdf');
  const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
  pdf.setProperties({title:'Wedding World — Virtual Wedding Certificate',subject:DISCLAIMER,creator:'Wedding World'});
  pdf.addImage(canvas.toDataURL('image/jpeg',.96),'JPEG',0,0,210,297);
  pdf.save(`wedding-world-${evidence.payload.eventReference}.pdf`);
}
