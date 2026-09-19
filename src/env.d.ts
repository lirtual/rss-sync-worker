interface RefreshMessage {
  feedId: number;
  dispatchToken: string;
  dispatchedAt: number;
}

interface Env {
  DB: D1Database;
  REFRESH_QUEUE: Queue<RefreshMessage>;
  USERNAME: string;
  PASSWORD: string;
  DAILY_DISPATCH_BUDGET: string;
  REEDER_TRACE: string;
}
