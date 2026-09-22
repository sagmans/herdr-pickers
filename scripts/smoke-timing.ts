// Shared timing policy for the real-Herdr smoke. Shared CI runners are slow and
// heavily loaded, so waits carry a generous budget; the growing poll interval
// matters just as much, because every probe spawns a herdr CLI process that
// would otherwise compete with the picker processes the probe waits for.
export const POLL_INTERVAL_MS = 250;
export const POLL_INTERVAL_MAX_MS = 2_000;
export const POLL_BACKOFF_FACTOR = 1.6;
export const POLL_TIMEOUT_MS = 30_000;

// Cold client paints, concurrent plugin starts, and Picker catalog loads are
// the observed slow paths under CI load, so they get a proportional budget.
export const POLL_TIMEOUT_EXTENDED_MS = 60_000;
