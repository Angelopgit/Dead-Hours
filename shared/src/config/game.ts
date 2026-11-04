export const GAME = {
  title: 'DEAD HOURS',
  /** Shown on the main menu and by the server's /health; keep in step with package.json. */
  version: '0.5.0',
  subtitle: 'Board the windows. Count the hours.',
  /** The town the night happens in (what players read; code names such as MAPLE_HOLLOW stay as they were). */
  town: 'Vesper',
  minPlayers: 1,
  maxPlayers: 4,
  preparationSeconds: 45,
  serverTickRate: 20,
  defaultPort: 2567,
} as const;
