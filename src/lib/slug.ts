// A note's file name is AAAA-MM-DD-slug.md: the slug is its URL and the date
// its publication day. Both helpers read only the file name.
const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '');

export const slugOf = (path: string) => {
	const name = stem(path);
	return DATED.exec(name)?.[2] ?? name;
};

export const dateOf = (path: string) => {
	const day = DATED.exec(stem(path))?.[1];
	return day ? new Date(`${day}T00:00:00Z`) : undefined;
};
