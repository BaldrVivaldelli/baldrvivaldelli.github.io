// A note links to another the way GitHub understands, by its file:
// [texto](2026-10-05-otra.md). On the site that file is the page /otra/, so
// relative links to .md files are rewritten; every other link is left alone.
const NOTE = /^(?:[\w.-]+\/)*(?:\d{4}-\d{2}-\d{2}-)?([\w-]+)\.md(#.*)?$/;

/** @param {{ base?: string }} options */
export function rehypeNoteLinks({ base = '/' } = {}) {
	/** @param {any} node */
	const walk = (node) => {
		if (node.type === 'element' && node.tagName === 'a') {
			const href = node.properties?.href;
			const match = typeof href === 'string' && !href.includes(':') && NOTE.exec(href);
			if (match) node.properties.href = `${base}${match[1]}/${match[2] ?? ''}`;
		}
		for (const child of node.children ?? []) walk(child);
	};
	return walk;
}
