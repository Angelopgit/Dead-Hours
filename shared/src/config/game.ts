export const GAME = {
  title: 'DEAD HOURS',
  /** Shown on the main menu and by the server's /health; keep in step with package.json. */
  version: '0.4.1',
  subtitle: "Survive Until You Can't.",
  minPlayers: 1,
  maxPlayers: 4,
  preparationSeconds: 45,
  serverTickRate: 20,
  defaultPort: 2567,
} as const;
