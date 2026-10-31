import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const base = "https://guillhermm.github.io/web-ai-experiments/einstein-field-equation/";

test("page carries a search description and link preview tags", () => {
	for (const tag of ['name="description"', 'property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"']) {
		assert.match(html, new RegExp(`<meta ${tag} content="[^"]+">`), tag);
	}
});

test("canonical, og:url and og:image are absolute and point at this page", () => {
	assert.ok(html.includes(`<link rel="canonical" href="${base}">`));
	assert.ok(html.includes(`property="og:url" content="${base}"`));
	assert.ok(html.includes(`property="og:image" content="${base}preview.jpg"`));
});

test("sitemap lists this page alone", async () => {
	const xml = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");
	const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	assert.deepEqual(locs, [base]);
});
