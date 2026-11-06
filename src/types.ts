export type CameraMode = 'THIRD_PERSON' | 'FIRST_PERSON' | 'ISOMETRIC' | 'CINEMATIC_SPECTATOR';
export type GuestGender = 'female' | 'male';
export interface Phase {
  id: string; title: string; duration: number; action: string; required: boolean;
  dialogue: string; calledRoles?: string[]; index?: number; endsAt?: number;
}
export interface SpatialZone {
  id: string; name: string; role: string; point: [number, number]; public: boolean;
}
export interface DistrictCollider {
  bounds: number[]; height: number; material: string;
}
export interface District {
  id: string; name: string; nativeName: string; symbol: string; center: number[]; rotation: number;
  venue: string; stage: string; color: string; roof: string; floor: string; flower: string;
  inspiration: string; description: string; attire: string[]; activity: string; program: Phase[];
  layoutTitle?: string; layoutSummary?: string;
  photoPoint?: [number, number];
  cinematicViews?: [number, number, number, number, number, number][];
  spatialZones?: SpatialZone[];
  colliders?: DistrictCollider[];
}
export interface WeddingEvent {
  id: string; slug: string; couple: string[]; district: string; state: string; venue: string | null;
  slotSeconds: number; queuePosition: number; readyDeadline: number | null; readyCount: number;
  startedAt: number | null; phase: Phase | null; audience: number; audienceLimit: number;
  priorityUsed: number; priorityLimit: number; estimatedStart?: number;
  side?: number; isCouple?: boolean; myReady?: boolean; myActions?: string[]; members?: Member[];
}
export interface Member { guest_id: number; nickname: string; role: string; side: number; accepted: boolean; seat: number; }
export interface Proposal { id: string; state: string; district: string; proposer: string; partner: string; incoming: boolean; expiresAt: number; }
export interface Membership extends Omit<Member, 'nickname'> { event: WeddingEvent; position: number[]; }
export interface WorldState {
  v: number; type: string; serverTime: number;
  self: { id: number; code: string; nickname: string; zone: string; attire: number; grants: string[]; revision: number; motionUntil?: number; gender?: GuestGender; clothingColor?: string };
  guestCount: number; directory: WeddingEvent[]; wedding: WeddingEvent | null;
  proposals: Proposal[]; memberships: Membership[]; viewing: WeddingEvent | null; overflow: boolean;
  venues: { district: string; availableAt: number; occupied: boolean }[];
  nearby?: {id: number; nickname: string; code: string; attire: number; district: string | null; gender?: GuestGender; clothingColor?: string}[];
}
export interface PlayerSnapshot { id: number; x: number; z: number; yaw: number; ack: number; avatar: number; emote: number; }
export interface Snapshot { tick: number; time: number; players: PlayerSnapshot[]; }
export interface Evidence {
  payload: { version: number; issuer: string; eventReference: string; couple: string[]; district: string; completedAt: string; disclaimer: string };
  canonical: string; signature: string; publicKey: string; algorithm: string;
}
