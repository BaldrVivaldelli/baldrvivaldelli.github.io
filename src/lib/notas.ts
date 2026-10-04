import { getCollection, type CollectionEntry } from 'astro:content';
import { dateOf } from './slug';

export interface Nota {
	entry: CollectionEntry<'notas'>;
	slug: string;
	title: string;
	date: Date;
	description?: string;
}

// Markdown inline syntax that should not reach a <title> or a feed.
const plain = (md: string) =>
	md
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_~]/g, '')
		.trim();

const firstHeading = (body: string) => /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1];

// The first paragraph after the heading, as long as it is prose.
const firstParagraph = (body: string) => {
	const afterTitle = body.replace(/^[\s\S]*?^#[ \t].*$/m, '');
	const block = afterTitle.trim().split(/\n\s*\n/)[0] ?? '';
	return /^(#|```|\$\$|>|[-*+] |\d+\. |\||!\[)/.test(block) ? undefined : plain(block.replace(/\s+/g, ' '));
};

const toNota = (entry: CollectionEntry<'notas'>): Nota => {
	const file = entry.filePath ?? entry.id;
	const body = entry.body ?? '';
	const title = entry.data.title ?? firstHeading(body);
	const date = entry.data.date ?? dateOf(file);
	if (!title) throw new Error(`${file}: falta el título. La primera línea tiene que ser "# Título".`);
	if (!date) throw new Error(`${file}: falta la fecha. Nombrá el archivo AAAA-MM-DD-slug.md.`);
	return { entry, slug: entry.id, title: plain(title), date, description: entry.data.description ?? firstParagraph(body) };
};

// Published notes, newest first. Drafts show up only in `npm run dev`.
export async function notas(): Promise<Nota[]> {
	const entries = await getCollection('notas', ({ data }) => import.meta.env.DEV || !data.draft);
	return entries.map(toNota).sort((a, b) => b.date.valueOf() - a.date.valueOf() || a.title.localeCompare(b.title, 'es'));
}
