export interface Breadcrumb {
  message: string;
  category?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface BreadcrumbInput {
  category?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fixed-size ring of recent app events (navigation, taps, requests) attached
 * to every notice as `context.breadcrumbs` so errors carry the interaction
 * trail that led up to them.
 */
export class BreadcrumbBuffer {
  private crumbs: Breadcrumb[] = [];

  constructor(private capacity: number) {}

  add(message: string, input: BreadcrumbInput = {}): void {
    if (this.capacity <= 0) return;
    this.crumbs.push({
      message,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      timestamp: new Date().toISOString(),
    });
    if (this.crumbs.length > this.capacity) {
      this.crumbs.splice(0, this.crumbs.length - this.capacity);
    }
  }

  clear(): void {
    this.crumbs = [];
  }

  snapshot(): Breadcrumb[] {
    return [...this.crumbs];
  }
}
