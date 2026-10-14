import { execFile } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const docker = promisify(execFile);

/** Four pulls at most: Docker also downloads multiple layers per pull. */
export async function prepull(
  images: readonly string[],
  io = {
    run: (args: string[]): Promise<unknown> => docker('docker', args),
    wait: (ms: number): Promise<unknown> => setTimeout(ms),
    now: (): number => Date.now()
  }
): Promise<void> {
  let next = 0;
  let cooldownUntil = 0;
  let throttles = 0;
  let failed = false;
  let failure: unknown;

  await Promise.all(
    Array.from({ length: Math.min(4, images.length) }, async () => {
      try {
        while (!failed && next < images.length) {
          const image = images[next++]!;
          try {
            await io.run(['image', 'inspect', image]);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
          }

          for (let attempt = 1; attempt <= 5; attempt++) {
            // Recheck after waking: the other worker may have extended the cooldown.
            while (!failed && io.now() < cooldownUntil) {
              await io.wait(cooldownUntil - io.now());
            }
            if (failed) return;
            console.error(`pulling ${image} (${attempt})`);
            try {
              await io.run(['pull', '--quiet', image]);
              break;
            } catch (error) {
              const detail = error as NodeJS.ErrnoException & { stderr?: string };
              if (detail.code === 'ENOENT') throw error;
              const message = detail.stderr || detail.message;
              console.error(message);
              if (/toomanyrequests|too many requests|rate exceeded|\b429\b/i.test(message)) {
                // A registry limit affects both workers, not just the refused image.
                const delay = Math.min(240_000, 30_000 * 2 ** throttles++);
                cooldownUntil = Math.max(cooldownUntil, io.now() + delay);
                console.error(`Registry rate limit: pausing new pulls for ${delay / 1000}s`);
              }
              if (attempt === 5) throw new Error(`Could not pull ${image}`, { cause: error });
              await io.wait(attempt * 15_000);
            }
          }
        }
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    })
  );
  // Drain in-flight pulls before failing; Harbor must never start with missing images.
  if (failed) throw failure;
}
