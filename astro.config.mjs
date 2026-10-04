// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { rehypeNoteLinks } from './src/lib/rehype-note-links.mjs';

// GitHub Actions sets GITHUB_REPOSITORY to "owner/repo". Pages serves a repo
// named owner.github.io from the root of that domain and any other one from
// /repo/, so both come from it and renaming the repo needs no edit here.
const [owner = '', repo = ''] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
const atRoot = !owner || repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
const base = atRoot ? '/' : `/${repo}/`;

export default defineConfig({
	site: owner ? `https://${owner.toLowerCase()}.github.io` : 'http://localhost:4321',
	base,
	trailingSlash: 'always',
	integrations: [sitemap()],
	markdown: {
		processor: unified({
			// Single dollars stay text: "$500 y $800" is a price, not a formula.
			remarkPlugins: [[remarkMath, { singleDollarTextMath: false }]],
			rehypePlugins: [rehypeKatex, [rehypeNoteLinks, { base }]],
		}),
		shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } },
	},
});
