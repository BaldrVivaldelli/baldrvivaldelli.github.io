import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { notas } from '../lib/notas';
import { url } from '../lib/url';
import { SITE } from '../site';

export async function GET(context: APIContext) {
	return rss({
		title: SITE.name,
		description: SITE.description,
		site: new URL(url(), context.site).href,
		customData: '<language>es</language>',
		items: (await notas()).map((nota) => ({
			title: nota.title,
			pubDate: nota.date,
			description: nota.description,
			link: url(`${nota.slug}/`),
		})),
	});
}
