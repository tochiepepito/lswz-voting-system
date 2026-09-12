/**
 * Test double for `next/headers`.
 *
 * The integration suite exercises the real services, and those services read the
 * voter session from a cookie. Outside a Next.js request `cookies()` throws, so
 * the integration Vitest config aliases `next/headers` to this module.
 *
 * The point is that NOTHING in `src/` changes for tests: the services still call
 * `cookies()`, still hash the token they find, and still look the session up in
 * PostgreSQL. Only the transport is swapped, so what the tests verify is the
 * production code path rather than a parallel one.
 */

type CookieRecord = { name: string; value: string };

class TestCookieStore {
  private readonly jar = new Map<string, string>();

  get(name: string): CookieRecord | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: { maxAge?: number }): void {
    // Mirror the real behaviour: maxAge 0 clears the cookie.
    if (value === '' || options?.maxAge === 0) {
      this.jar.delete(name);
      return;
    }
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.jar.delete(name);
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  getAll(): CookieRecord[] {
    return [...this.jar.entries()].map(([name, value]) => ({ name, value }));
  }

  /** Test-only: start a fresh browser. */
  reset(): void {
    this.jar.clear();
  }

  /** Test-only: copy this jar, to simulate a second browser or device. */
  snapshot(): Map<string, string> {
    return new Map(this.jar);
  }

  /** Test-only: restore a previously captured jar. */
  restore(snapshot: Map<string, string>): void {
    this.jar.clear();
    for (const [name, value] of snapshot) this.jar.set(name, value);
  }
}

export const testCookieStore = new TestCookieStore();

let testHeaders = new Headers();

/** Test-only: set the headers seen by the code under test. */
export function setTestHeaders(init?: HeadersInit): void {
  testHeaders = new Headers(init);
}

// --- The `next/headers` surface the application actually uses ---------------

export async function cookies(): Promise<TestCookieStore> {
  return testCookieStore;
}

export async function headers(): Promise<Headers> {
  return testHeaders;
}

export async function draftMode(): Promise<{ isEnabled: boolean }> {
  return { isEnabled: false };
}
