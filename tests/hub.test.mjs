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
