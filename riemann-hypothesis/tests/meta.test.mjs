import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const base = "https://guillhermm.github.io/web-ai-experiments/riemann-hypothesis/";

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

test("tab icon is linked and the CSP lets it load", async () => {
	assert.ok(html.includes('<link rel="icon" href="./icon.svg" type="image/svg+xml">'));
	assert.match(html, /img-src 'self'/);
	assert.match(await readFile(new URL("../icon.svg", import.meta.url), "utf8"), /^<svg /);
});

test("the what-if controls collapse behind a toggle, and nothing animates before the script sets the start state", () => {
	assert.match(html, /<button id="tools-toggle"[^>]*aria-controls="tools"[^>]*aria-expanded="true"/);
	assert.match(html, /<div id="tools" class="tools">[\s\S]*id="beta"[\s\S]*id="ghost"/);
	assert.ok(html.includes('<body class="is-loading">'));
});

test("Search Console verification tag is present", () => {
	assert.ok(html.includes('<meta name="google-site-verification" content="IMB4bqRBXLrR92ODWWzF0c8qv-83lzgZZW2WHXw-ZCA">'));
});
