import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://rss-sync.test${path}`, init));

describe("worker foundation", () => {
  it("serves a public health endpoint without secrets", async () => {
    const response = await fetchWorker("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "rss-sync-worker",
    });
    expect(JSON.stringify(await response.clone().json())).not.toContain("token");
  });

  it("rejects invalid ClientLogin credentials", async () => {
    const response = await fetchWorker("/api/reader/accounts/ClientLogin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Email: "test-reader",
        Passwd: "wrong-token",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Error=BadAuthentication\n");
  });

  it("completes ClientLogin with the configured reader credentials", async () => {
    const response = await fetchWorker("/api/reader/accounts/ClientLogin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Email: "test-reader",
        Passwd: "test-reader-token",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      "SID=test-reader-token\nLSID=test-reader-token\nAuth=test-reader-token\n",
    );
  });

  it("protects Google Reader protocol endpoints", async () => {
    const missing = await fetchWorker("/api/reader/reader/api/0/token");
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("Error=AuthRequired\n");

    const invalid = await fetchWorker("/api/reader/reader/api/0/token", {
      headers: { Authorization: "GoogleLogin auth=wrong-token" },
    });
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).toBe("Error=InvalidAuthToken\n");

    const valid = await fetchWorker("/api/reader/reader/api/0/token", {
      headers: { Authorization: "GoogleLogin auth=test-reader-token" },
    });
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("test-reader-token");
  });

  it("returns single-user info after authentication", async () => {
    const response = await fetchWorker("/api/reader/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=test-reader-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: "1",
      userName: "test-reader",
      userEmail: "test-reader",
      userProfileId: "1",
    });
  });

  it("protects admin routes with a separate bearer token", async () => {
    const missing = await fetchWorker("/admin/status");
    expect(missing.status).toBe(401);

    const invalid = await fetchWorker("/admin/status", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(invalid.status).toBe(401);

    const valid = await fetchWorker("/admin/status", {
      headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ status: "ok" });
  });
});
