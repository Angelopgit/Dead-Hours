import { Room, type Client } from 'colyseus';
import { C2S, GAME, NEIGHBORHOOD, PLAYER, decodeAppearance, encodeAppearance, type InputFrame, type JoinOptions } from '@dead-hours/shared';
import { PlayerState, SurvivalState } from './schema';

interface CreateOptions {
  lobbyName?: string;
  maxPlayers?: number;
  private?: boolean;
}

/**
 * Authoritative survival room. Phase 1 covers lobby membership, readiness, host migration
 * and a validated movement integrator; collision, zombies and combat move here in Phase 4.
 */
export class SurvivalRoom extends Room<SurvivalState> {
  maxClients: number = GAME.maxPlayers;
  state = new SurvivalState();

  onCreate(options: CreateOptions): void {
    this.maxClients = Math.min(Math.max(options.maxPlayers ?? GAME.maxPlayers, 1), 8);
    this.state.lobbyName = (options.lobbyName ?? 'Safehouse').slice(0, 32);
    void this.setMetadata({ lobbyName: this.state.lobbyName, status: 'lobby' });
    if (options.private) void this.setPrivate(true);

    this.onMessage(C2S.ready, (client, ready: boolean) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ready = !!ready;
    });

    this.onMessage(C2S.input, (client, frame: InputFrame) => this.applyInput(client, frame));
    this.setSimulationInterval(() => this.tick(), 1000 / GAME.serverTickRate);
  }

  onJoin(client: Client, options: Partial<JoinOptions>): void {
    const spawn = NEIGHBORHOOD.playerSpawns[this.state.players.size % NEIGHBORHOOD.playerSpawns.length];
    const p = new PlayerState();
    p.id = client.sessionId;
    p.name = (options.name ?? 'Survivor').slice(0, 20);
    p.primary = options.primary ?? 'ar';
    p.secondary = options.secondary ?? 'pistol';
    p.appearance = encodeAppearance(decodeAppearance(options.appearance));
    p.x = spawn.x;
    p.y = spawn.y;
    p.z = spawn.z;
    p.yaw = spawn.yaw;
    p.host = this.state.players.size === 0;
    this.state.players.set(client.sessionId, p);
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    try {
      // Hold the slot briefly so a dropped connection can resume without losing state.
      if (!consented) await this.allowReconnection(client, 20);
      else throw new Error('left');
    } catch {
      const wasHost = p.host;
      this.state.players.delete(client.sessionId);
      if (wasHost) {
        const next = this.state.players.values().next().value as PlayerState | undefined;
        if (next) next.host = true;
      }
    }
  }

  /** Server-side movement validation: clamp per-frame displacement to what the client could legally move. */
  private applyInput(client: Client, f: InputFrame): void {
    const p = this.state.players.get(client.sessionId);
    if (!p || typeof f?.seq !== 'number' || f.seq <= p.lastSeq) return;
    const dt = Math.min(Math.max(f.dt, 0), 0.1);
    const len = Math.hypot(f.moveX, f.moveZ);
    const nx = len > 1 ? f.moveX / len : f.moveX;
    const nz = len > 1 ? f.moveZ / len : f.moveZ;
    const speed = f.crouch ? PLAYER.crouchSpeed : f.aim ? PLAYER.aimSpeed : f.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    p.x += nx * speed * dt;
    p.z += nz * speed * dt;
    const half = NEIGHBORHOOD.halfExtent - 1;
    p.x = Math.min(Math.max(p.x, -half), half);
    p.z = Math.min(Math.max(p.z, -half), half);
    p.yaw = f.yaw;
    p.lastSeq = f.seq;
  }

  private tick(): void {
    // Survival director, zombie AI and barricade simulation run here from Phase 4/5.
  }
}
