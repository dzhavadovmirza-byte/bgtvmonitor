// Tiny HTTP server that exposes /api/prices and /health. The price logic
// lives in prices.js (pure handler — same shape as the original Vercel
// function so the frontend works without changes).
import http from "node:http";
import handler from "./prices.js";

const PORT = parseInt(process.env.PORT || "8081", 10);

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === "GET" && (req.url === "/api/prices" || req.url.startsWith("/api/prices?"))) {
            return await handler(req, res);
        }
        if (req.method === "GET" && req.url === "/health") {
            res.statusCode = 200;
            res.setHeader("content-type", "text/plain");
            return res.end("ok");
        }
        res.statusCode = 404;
        res.end();
    } catch (e) {
        console.error("handler crash:", e);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "internal" }));
        }
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`priceapi listening on :${PORT}`);
});

// Graceful shutdown so docker stop doesn't drop in-flight requests.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        console.log(`got ${sig}, shutting down`);
        server.close(() => process.exit(0));
        // hard timeout in case a request hangs
        setTimeout(() => process.exit(1), 10_000).unref();
    });
}
