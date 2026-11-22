import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const hub = await readFile(new URL("index.html", root), "utf8");
// Card links outside HTML comments, so the commented card template is not treated as a real page.
const links = [...hub.replace(/<!--[\s\S]*?-->/g, "").matchAll(/href="(\.\/[^"]+)"/g)].map((m) => m[1]);

test("hub links point at folders, not at index.html", () => {
	assert.ok(links.length > 0);
	assert.ok(!hub.includes("/index.html\""), "no link ends in /index.html");
	for (const link of links.filter((l) => !/\.\w+$/.test(l))) assert.match(link, /\/$/, link);
});

test("every folder the hub links to has a page", async () => {
	for (const link of links.filter((l) => l.endsWith("/"))) {
		await access(new URL(`${link}index.html`, root));
	}
});

const runHubScript = async (protocol, hrefs) => {
	const { runInNewContext } = await import("node:vm");
	const anchors = hrefs.map((href) => ({ href, getAttribute() { return this.href; }, setAttribute(_, v) { this.href = v; } }));
	const document = {
		location: { protocol },
		querySelectorAll: (sel) => {
			assert.equal(sel, 'a[href^="./"][href$="/"]');
			return anchors.filter((a) => a.href.startsWith("./") && a.href.endsWith("/"));
		},
	};
	runInNewContext(await readFile(new URL("hub.js", root), "utf8"), { document });
	return anchors.map((a) => a.href);
};

test("opened from disk, folder links get index.html; external links are left alone", async () => {
	assert.deepEqual(await runHubScript("file:", ["./calc/", "https://codepen.io/x/", "./a/b/"]), ["./calc/index.html", "https://codepen.io/x/", "./a/b/index.html"]);
});

test("served over http, links stay clean", async () => {
	assert.deepEqual(await runHubScript("https:", ["./calc/"]), ["./calc/"]);
});

test("hub loads its script under a CSP that only allows its own scripts", () => {
	assert.ok(hub.includes('<script src="hub.js" defer></script>'));
	assert.match(hub, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self';[^"]*">/);
});
