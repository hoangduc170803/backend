export class CoalescedTask {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stale = false;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly delayMs: number,
  ) {}

  schedule(): void {
    if (this.running) {
      this.stale = true;
      return;
    }
    this.timer ??= setTimeout(() => void this.execute(), this.delayMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stale = false;
  }

  private async execute(): Promise<void> {
    this.timer = null;
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
      if (this.stale) {
        this.stale = false;
        this.schedule();
      }
    }
  }
}
