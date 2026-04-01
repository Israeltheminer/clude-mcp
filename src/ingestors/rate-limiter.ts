export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async throttle(onWait?: (waitSec: number) => void): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 10;
      onWait?.(Math.ceil(waitMs / 1000));

      const endAt = Date.now() + waitMs;
      await new Promise<void>(resolve => {
        const tick = () => {
          const remaining = Math.ceil((endAt - Date.now()) / 1000);
          if (remaining <= 0) { resolve(); return; }
          onWait?.(remaining);
          setTimeout(tick, 1000);
        };
        tick();
      });

      return this.throttle(onWait);
    }

    this.timestamps.push(Date.now());
  }
}
