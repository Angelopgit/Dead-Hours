import { Schema, MapSchema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('string') id = '';
  @type('string') name = '';
  @type('boolean') ready = false;
  @type('boolean') host = false;
  @type('string') primary = 'ar';
  @type('string') secondary = 'pistol';
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') yaw = 0;
  @type('number') health = 100;
  @type('number') lastSeq = 0;
}

export class SurvivalState extends Schema {
  @type('string') phase: 'lobby' | 'preparation' | 'survival' | 'over' = 'lobby';
  @type('string') lobbyName = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
