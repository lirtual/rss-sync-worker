declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    REFRESH_QUEUE: Queue<RefreshMessage>;
    USERNAME: string;
    PASSWORD: string;
    DAILY_DISPATCH_BUDGET: string;
    REEDER_TRACE: string;
    TEST_MIGRATIONS: D1Migration[];
  }

  interface Exports {
    default: Fetcher;
  }
}
