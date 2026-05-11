import { describe, expect, it } from "vitest";

import {
  createFreeLogUploadUrl,
  createFreeOtlpProxyUrls,
  createFreeLogUploader,
  createFreeLogUploaderFromEnv,
  createFreeOtlpUploader,
} from "./relay-log-upload.js";

describe("relay log upload", () => {
  it("derives the HTTP log endpoint from relay WebSocket URLs", () => {
    expect(createFreeLogUploadUrl("wss://relay.test/acp?hostId=host-1")).toBe(
      "https://relay.test/api/logs",
    );
    expect(createFreeLogUploadUrl("ws://localhost:8787/host")).toBe(
      "http://localhost:8787/api/logs",
    );
    expect(createFreeOtlpProxyUrls("wss://relay.test/acp?hostId=host-1")).toEqual({
      logsEndpointUrl: "https://relay.test/api/otel/logs",
      tracesEndpointUrl: "https://relay.test/api/otel/traces",
    });
  });

  it("batches records and sends account session authorization", async () => {
    const requests: Request[] = [];
    const uploader = createFreeLogUploader({
      accountSession: "session-token",
      batchSize: 2,
      context: {
        "acp.remote.host_id": "host-1",
      },
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "host",
    });

    uploader.writeText(
      "connected",
      {
        "acp.remote.component": "host",
      },
      {
        spanId: "span-1",
        traceId: "trace-1",
      },
    );
    uploader.emit({
      eventName: "acp.session.start",
      kind: "otel_span",
      observedAt: "2026-05-06T00:00:00.000Z",
      spanContext: {
        traceId: "trace-1",
      },
    });
    await uploader.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer session-token",
    );
    await expect(requests[0].json()).resolves.toMatchObject({
      context: {
        "acp.remote.host_id": "host-1",
      },
      records: [
        {
          body: "connected",
          kind: "text",
          spanId: "span-1",
          traceId: "trace-1",
        },
        {
          eventName: "acp.session.start",
          kind: "otel_span",
          traceId: "trace-1",
        },
      ],
      source: "host",
      version: 1,
    });
  });

  it("uses env configuration and supports an emergency disable switch", () => {
    expect(
      createFreeLogUploaderFromEnv({
        env: {
          ACP_ACCOUNT_SESSION: "session-token",
          FREE_LOG_UPLOAD: "0",
          FREE_RELAY_URL: "wss://relay.test/acp",
        },
        source: "bridge",
      }),
    ).toBeUndefined();

    expect(
      createFreeLogUploaderFromEnv({
        env: {
          ACP_ACCOUNT_SESSION: "session-token",
          FREE_RELAY_URL: "wss://relay.test/acp",
        },
        source: "host",
      }),
    ).toBeTruthy();

    expect(
      createFreeLogUploaderFromEnv({
        env: {
          ACP_ACCOUNT_SESSION: "session-token",
          FREE_RELAY_URL: "wss://relay.test/acp",
        },
        source: "bridge",
      }),
    ).toBeTruthy();
  });

  it("exports logs and spans to OTLP endpoints", async () => {
    const requests: Request[] = [];
    const uploader = createFreeOtlpUploader({
      batchSize: 10,
      context: {
        "acp.remote.host_id": "host-1",
      },
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ partialSuccess: {} }), {
          status: 200,
        });
      },
      logsEndpointUrl: "https://otel.test/v1/logs",
      source: "host",
      token: "otlp-token",
      tracesEndpointUrl: "https://otel.test/v1/traces",
    });

    uploader.writeText(
      "connected",
      {
        "acp.remote.component": "host",
      },
      {
        spanId: "2222222222222222",
        traceId: "11111111111111111111111111111111",
      },
    );
    uploader.emit({
      attributes: {
        "acp.session.id": "session-1",
      },
      eventName: "acp.session.start",
      kind: "otel_span",
      observedAt: "2026-05-06T00:00:01.000Z",
      record: {
        duration: [1, 0],
        kind: 1,
        parentSpanId: "3333333333333333",
        startTime: [1778025600, 0],
      },
      spanId: "4444444444444444",
      traceId: "11111111111111111111111111111111",
    });
    await uploader.flush();

    expect(requests.map((request) => request.url)).toEqual([
      "https://otel.test/v1/logs",
      "https://otel.test/v1/traces",
    ]);
    expect(requests[0].headers.get("X-OTLP-Token")).toBe("otlp-token");
    await expect(requests[0].json()).resolves.toMatchObject({
      resourceLogs: [
        {
          resource: {
            attributes: expect.arrayContaining([
              {
                key: "service.name",
                value: { stringValue: "free-host" },
              },
            ]),
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: "connected" },
                  spanId: "2222222222222222",
                  traceId: "11111111111111111111111111111111",
                },
              ],
            },
          ],
        },
      ],
    });
    await expect(requests[1].json()).resolves.toMatchObject({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "acp.session.start",
                  parentSpanId: "3333333333333333",
                  spanId: "4444444444444444",
                  traceId: "11111111111111111111111111111111",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("uses the relay OTLP proxy by default from env", async () => {
    const requests: Request[] = [];
    const uploader = createFreeLogUploaderFromEnv({
      env: {
        ACP_ACCOUNT_SESSION: "session-token",
        FREE_RELAY_URL: "wss://relay.test/acp",
      },
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ partialSuccess: {} }), {
          status: 200,
        });
      },
      source: "host",
    });

    expect(uploader).toBeTruthy();
    uploader?.writeText("connected");
    await uploader?.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://relay.test/api/otel/logs");
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer session-token",
    );
  });

  it("splits oversized batches before uploading", async () => {
    const requests: Request[] = [];
    const uploader = createFreeLogUploader({
      accountSession: "session-token",
      batchSize: 100,
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "host",
    });

    for (let index = 0; index < 40; index += 1) {
      uploader.writeText(`${index}:${"x".repeat(20_000)}`);
    }
    await uploader.flush();

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(Buffer.byteLength(await request.text(), "utf8")).toBeLessThan(
        512 * 1024,
      );
    }
  });

  it("keeps queued records for retry after transient upload failure", async () => {
    const requests: Request[] = [];
    let fail = true;
    const uploader = createFreeLogUploader({
      accountSession: "session-token",
      endpointUrl: "https://relay.test/api/logs",
      async fetch(input, init) {
        requests.push(new Request(input, init));
        if (fail) {
          throw new Error("fetch failed");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      source: "bridge",
    });

    uploader.writeText("connected");
    await uploader.flush();
    fail = false;
    await uploader.flush();

    expect(requests).toHaveLength(2);
    await expect(requests[1].json()).resolves.toMatchObject({
      records: [
        {
          body: "connected",
          kind: "text",
        },
      ],
    });
  });
});
