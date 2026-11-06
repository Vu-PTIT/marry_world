/** Monotonic local time plus the least-delayed recent authority clock sample. */
export class ServerClock {
  private offset=0;
  private target=0;
  private last=0;
  private ready=false;
  private samples:{time:number;offset:number}[]=[];

  observe(serverTime:number,localTime:number){
    const offset=serverTime-localTime;
    // Reconnects and an authority clock jump establish a fresh timeline.
    if(!this.ready||Math.abs(serverTime-this.now(localTime))>2){
      this.offset=this.target=offset;this.last=localTime;this.samples=[];this.ready=true;
    }
    this.samples.push({time:localTime,offset});
    this.samples=this.samples.filter(s=>s.time>localTime-30);
    this.target=Math.max(...this.samples.map(s=>s.offset));
  }
  now(localTime:number){
    const elapsed=Math.max(0,localTime-this.last);this.last=localTime;
    const difference=this.target-this.offset;
    // Metadata arrival jitter must not move the render clock backwards or change
    // its rate abruptly. Small drift is corrected at at most one percent per second.
    this.offset+=Math.max(-elapsed*.01,Math.min(elapsed*.01,difference));
    return localTime+this.offset;
  }
}
