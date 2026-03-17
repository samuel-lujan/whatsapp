export const errMsg = (e: unknown): string => (e as Error).message;

export function raceWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message = "timeout",
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
}
