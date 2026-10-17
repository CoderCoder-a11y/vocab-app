const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { extractUrls, findWordImages } = require("../utils/tavily");

test("extractUrls keeps clean https images only, without duplicates", () => {
    const out = extractUrls([
        "https://a.com/1.jpg", { url: "https://b.com/2.png", description: "x" }, "https://a.com/1.jpg",
        "http://insecure.com/3.jpg", "https://c.com/logo.svg", "not a url", null, 5,
    ]);
    assert.deepEqual(out, ["https://a.com/1.jpg", "https://b.com/2.png"]);
});

test("findWordImages searches again until it has 3 pictures", async (t) => {
    const queries = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const b = JSON.parse(body);
            queries.push(b.query);
            assert.equal(req.headers.authorization, "Bearer k");
            assert.equal(b.include_images, true);
            const n = queries.length; // 1st query -> 1 image, 2nd -> 2 more
            const images = n === 1 ? ["https://x.com/1.jpg"] : ["https://x.com/2.jpg", "https://x.com/3.jpg"];
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ images }));
        });
    });
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    process.env.TAVILY_API_KEY = "k";
    process.env.TAVILY_API_BASE = `http://127.0.0.1:${server.address().port}`;

    const urls = await findWordImages("brave", "ready to face danger");
    assert.equal(urls.length, 3);
    assert.equal(queries.length, 2);
});

test("missing key is reported", async () => {
    delete process.env.TAVILY_API_KEY;
    await assert.rejects(findWordImages("x"), { code: "NO_KEY" });
});