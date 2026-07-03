// Models empirically ignore soft noop hints and can loop hundreds of times
// re-sending byte-identical payloads. A thrown tool error is what actually
// breaks the cycle — it surfaces as a visible error in the agent trace and
// forces the model to re-read the file before retrying.

/** @public */
export const NOOP_HARD_LIMIT = 3;

interface NoopEntry {
	payloadKey: string;
	count: number;
}

const noopTracker = new Map<string, NoopEntry>();

/**
 * Record a noop edit attempt for the given canonical mutation target path.
 * A different payloadKey resets the count (the model changed payload = progress).
 * Returns the current count and whether the hard limit has been hit.
 */
export function recordNoopEdit(
	path: string,
	payloadKey: string,
): { count: number; escalate: boolean } {
	const existing = noopTracker.get(path);
	if (existing && existing.payloadKey === payloadKey) {
		existing.count += 1;
	} else {
		noopTracker.set(path, { payloadKey, count: 1 });
	}
	const count = noopTracker.get(path)!.count;
	return { count, escalate: count >= NOOP_HARD_LIMIT };
}

/**
 * Clear the noop counter for a path after a successful applied edit.
 */
export function recordAppliedEdit(path: string): void {
	noopTracker.delete(path);
}

/**
 * Reset all counters — for use in tests only.
 * @public
 */
export function resetNoopLoopGuard(): void {
	noopTracker.clear();
}
