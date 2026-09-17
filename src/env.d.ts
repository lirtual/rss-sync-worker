interface RefreshMessage {
  feedId: number;
  dispatchToken: string;
  dispatchedAt: number;
}

interface Env {
  DB: D1Database;
  REFRESH_QUEUE: Queue<RefreshMessage>;
  READER_USERNAME: string;
  READER_TOKEN: string;
  ADMIN_TOKEN: string;
  DAILY_DISPATCH_BUDGET: string;
  REEDER_TRACE: string;
}
