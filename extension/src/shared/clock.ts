/**
 * Estimates the offset between this machine's clock and the server's from
 * clockPing/clockPong round trips. Playback positions are stamped with
 * server time, so without this a few seconds of skew between two laptops
 * shows up directly as a few seconds of sync error.
 *
 * Each sample assumes the server read its clock halfway through the round
 * trip; the sample with the shortest round trip among the recent ones is
 * the least distorted by network jitter, so that one wins.
 */
export class ClockOffset {
  private samples: Array<{ rtt: number; offset: number }> = [];
  private maxSamples: number;

  constructor(maxSamples = 8) {
    this.maxSamples = maxSamples;
  }

  addSample(t0: number, serverTime: number, t1: number): void {
    const rtt = t1 - t0;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.samples.push({ rtt, offset: serverTime - (t0 + t1) / 2 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  /** server time minus local time, in ms; 0 until a sample arrives. */
  get offset(): number {
    let best: { rtt: number; offset: number } | undefined;
    for (const sample of this.samples) {
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    return best?.offset ?? 0;
  }

  toLocal(serverTime: number): number {
    return serverTime - this.offset;
  }
}
