import type { Snapshot, WorldState, Evidence, GuestGender } from './types';
import { ServerClock } from './server-clock';

export class WorldConnection extends EventTarget {
  socket: WebSocket | null = null;
  id = 0; sequence = 0; publicKey = ''; connected = false; intentionalClose = false;
  state: WorldState | null = null;
  private serverClock=new ServerClock();
  private token = '';
  private retry = 0;
  private pending = new Map<string,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:number}>();
  private heartbeat = 0;

  emit(type: string, detail?: unknown) { this.dispatchEvent(new CustomEvent(type,{detail})); }
  now(): number { return this.serverClock.now(performance.now()/1000); }
  async enter(nickname: string, avatar: number, invitation?: string, gender:GuestGender='female', clothingColor='#f1e3cd'): Promise<void> {
    const response = await fetch('/api/guests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname,avatar,invitation:invitation||null,gender,clothingColor})});
    const result = await response.json();
    if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:'The garden could not be reached. Check that the Python server is running.');
    this.token=result.token; this.id=result.id;
    sessionStorage.setItem('ww-guest',JSON.stringify({token:this.token,id:this.id}));
    this.open();
  }
  restore(): boolean {
    try {const data=JSON.parse(sessionStorage.getItem('ww-guest')||'null');if(!data?.token)return false;this.token=data.token;this.id=data.id;this.open();return true;}
    catch{return false;}
  }
  hasSavedSession():boolean{
    try{return typeof JSON.parse(sessionStorage.getItem('ww-guest')||'null')?.token==='string';}
    catch{return false;}
  }
  private open() {
    if(this.intentionalClose)return;
    const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
    ws.binaryType='arraybuffer'; this.socket=ws;
    ws.onopen=()=>ws.send(JSON.stringify({v:1,type:'hello',token:this.token}));
    ws.onmessage=event=>{
      if(event.data instanceof ArrayBuffer){this.readSnapshot(event.data);return;}
      let data:any;try{data=JSON.parse(event.data);}catch{return;}
      if(data.type==='welcome'){
        this.connected=true;this.retry=0;this.sequence=data.inputSequence;this.id=data.id;this.publicKey=data.publicKey;
        this.acceptState(data.state);this.emit('connected');
        window.clearInterval(this.heartbeat);
        this.heartbeat=window.setInterval(()=>{if(this.connected)this.command('ping').catch(()=>{});},10000);
      }else if(data.type==='world')this.acceptState(data);
      else if(data.type==='command_ok'||data.type==='command_error'){
        const waiting=this.pending.get(data.id);
        if(waiting){window.clearTimeout(waiting.timer);this.pending.delete(data.id);data.type==='command_ok'?waiting.resolve(data.data):waiting.reject(new Error(data.message));}
        else if(data.type==='command_error')this.emit('notice',data.message);
      }else if(data.type==='session_error'){
        this.intentionalClose=true;sessionStorage.removeItem('ww-guest');ws.close();this.emit('session_expired',data.message);
      }else if(data.type==='completion')this.emit('completion',data.evidence as Evidence);
      else if(data.message)this.emit('notice',data.message);
    };
    ws.onclose=()=>{
      if(this.socket!==ws)return;
      this.connected=false;window.clearInterval(this.heartbeat);
      for(const p of this.pending.values()){window.clearTimeout(p.timer);p.reject(new Error('The world is reconnecting. Try that action after you reconnect.'));}
      this.pending.clear();this.emit('disconnected');
      if(!this.intentionalClose)window.setTimeout(()=>this.open(),Math.min(8000,700*2**this.retry++));
    };
    ws.onerror=()=>this.emit('connection_error');
  }
  private acceptState(state:WorldState){
    this.state=state;this.serverClock.observe(state.serverTime,performance.now()/1000);this.emit('state',state);
  }
  private readSnapshot(buffer:ArrayBuffer){
    const view=new DataView(buffer);
    if(buffer.byteLength<16||view.getUint8(0)!==1||view.getUint8(1)!==2)return;
    const count=view.getUint16(14);
    if(count>96||buffer.byteLength!==16+count*22)return;
    const players=[];
    for(let i=0;i<count;i++){
      const offset=16+i*22;
      players.push({id:view.getUint32(offset),x:view.getFloat32(offset+4),z:view.getFloat32(offset+8),yaw:view.getFloat32(offset+12),ack:view.getUint32(offset+16),avatar:view.getUint8(offset+20),emote:view.getUint8(offset+21)});
    }
    this.emit('snapshot',{tick:view.getUint32(2),time:view.getFloat64(6),players} satisfies Snapshot);
  }
  input(dx:number,dz:number,yaw:number):number{
    if(!this.connected||!this.socket||this.socket.bufferedAmount>16384)return this.sequence;
    this.sequence=(this.sequence+1)>>>0;
    const buffer=new ArrayBuffer(18),view=new DataView(buffer);
    view.setUint8(0,1);view.setUint8(1,1);view.setUint32(2,this.sequence);view.setFloat32(6,dx);view.setFloat32(10,dz);view.setFloat32(14,yaw);
    this.socket.send(buffer);return this.sequence;
  }
  command(type:string,data:Record<string,unknown>={}):Promise<any>{
    if(!this.connected||!this.socket)return Promise.reject(new Error('Wait until you are connected to the world.'));
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=window.setTimeout(()=>{this.pending.delete(id);reject(new Error('That action timed out. Check your connection and try again.'));},7000);
      this.pending.set(id,{resolve,reject,timer});this.socket!.send(JSON.stringify({v:1,id,type,data}));
    });
  }
  leave(){this.intentionalClose=true;sessionStorage.removeItem('ww-guest');this.socket?.close();}
}
