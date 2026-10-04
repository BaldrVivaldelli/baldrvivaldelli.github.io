import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { slugOf } from './lib/slug';

// Every Markdown file in notas/ is a note, except README.md and files whose
// name starts with "_", which are drafts. Front matter is optional: the file
// name and the first heading already say everything a note needs.
const notas = defineCollection({
	loader: glob({
		base: './notas',
		pattern: ['**/*.md', '!**/_*', '!**/README.md'],
		generateId: ({ entry }) => slugOf(entry),
	}),
	schema: z.object({
		title: z.string().optional(),
		date: z.coerce.date().optional(),
		description: z.string().optional(),
		draft: z.boolean().default(false),
	}),
});

export const collections = { notas };
