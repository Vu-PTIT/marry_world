import { move, walkable, worldMap, type Point } from './map';

type InputSample = { time: number; input: Point };
export type PositionSample = { time: number; x: number; z: number; yaw: number };

/** Render-rate prediction. Network snapshots correct drift over time, never pace the steps. */
export class LocalMovement {
  position: Point = [0, 24];
  private inputs: InputSample[] = [];
  private correction: Point = [0, 0];
  private snapshotTime = -Infinity;

  reset(position: Point) {
    this.position = [...position];
    this.inputs = [];
    this.correction = [0, 0];
    this.snapshotTime = -Infinity;
  }

  step(input: Point, dt: number, now: number, grants: Set<string>): Point {
    const previous = this.inputs.at(-1);
    if (!previous || Math.hypot(input[0]-previous.input[0], input[1]-previous.input[1]) > .001)
      this.inputs.push({time: now-dt, input: [...input]});
    while (this.inputs.length > 1 && this.inputs[1].time < now-1) this.inputs.shift();
    this.position = move(...this.position, ...input, dt, grants);
    const blend = 1-Math.exp(-dt/.16);
    const dx = this.correction[0]*blend, dz = this.correction[1]*blend;
    // A visual correction must not cut across a wall or a protected ceremonial area.
    const distance = Math.hypot(dx,dz);
    if (distance > .00001) {
      const before = this.position;
      this.position = move(...before, dx/distance, dz/distance, Math.min(distance/worldMap.speed,.1), grants);
      this.correction[0] -= this.position[0]-before[0];
      this.correction[1] -= this.position[1]-before[1];
    }
    return this.position;
  }

  reconcile(position: Point, time: number, now: number, grants: Set<string>): boolean {
    if (time <= this.snapshotTime) return false;
    this.snapshotTime = time;
    if (Math.hypot(position[0]-this.position[0],position[1]-this.position[1]) > 3 || !walkable(...this.position,grants)) {
      this.reset(position); this.snapshotTime = time; return true;
    }
    // Replay the actual input timeline over the age of this snapshot. An acknowledgement
    // identifies a command, not how long the server continuously simulated that command.
    let estimate: Point = [...position];
    const from = Math.max(time,now-.3);
    let cursor = from, input: Point = [0,0];
    for (const sample of this.inputs) {
      if (sample.time <= from) { input = sample.input; continue; }
      if (sample.time > now) break;
      estimate = this.advance(estimate,input,sample.time-cursor,grants);
      cursor = sample.time; input = sample.input;
    }
    estimate = this.advance(estimate,input,Math.max(0,now-cursor),grants);
    this.correction = [estimate[0]-this.position[0],estimate[1]-this.position[1]];
    return false;
  }

  private advance(position: Point,input: Point,duration: number,grants: Set<string>): Point {
    while (duration > 0) { const dt = Math.min(.05,duration); position = move(...position,...input,dt,grants); duration -= dt; }
    return position;
  }
}

/** A short buffer absorbs the jitter of the server's 10 Hz position stream. */
export class SnapshotTrack {
  private samples: PositionSample[] = [];
  push(sample: PositionSample): boolean {
    const last = this.samples.at(-1);
    if (last && sample.time <= last.time) return false;
    const discontinuity = !last || Math.hypot(sample.x-last.x,sample.z-last.z) > 3 || sample.time-last.time > 1;
    if (discontinuity) this.samples = [];
    this.samples.push(sample);
    if (this.samples.length > 12) this.samples.shift();
    return discontinuity;
  }
  sample(now: number): PositionSample | undefined {
    const samples = this.samples;
    if (!samples.length) return;
    const time = now-.15;
    for (let i=1;i<samples.length;i++) {
      const a=samples[i-1],b=samples[i];
      if (time>b.time) continue;
      const t=Math.max(0,(time-a.time)/(b.time-a.time));
      const yawDelta=Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw));
      return {time,x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,yaw:a.yaw+yawDelta*t};
    }
    // Hold the latest known pose if the connection stalls; never walk through unseen walls.
    return samples.at(-1);
  }
}
